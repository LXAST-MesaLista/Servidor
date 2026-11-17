// MesaLista · pruebas automáticas de la API (casos CP-01 a CP-28 y CP-35)
//
// Se ejecutan contra un servidor de PRUEBAS, en la misma máquina que la base
// de datos, con "test_clock": true en config.json (reloj simulado con la
// cabecera X-Test-Now) y la pasarela simulada ("paypal": {"mode": "fake"}).
// BORRAN todos los datos.
//
//   node pruebas/run.js http://127.0.0.1:8091 --yes                 (desarrollo)
//   node pruebas/run.js https://<dominio de pruebas> --yes
//
// Opciones: --insecure (no valida el certificado), --only=CP-06,CP-12
// En el servidor: ML_CONFIG=/opt/mesalista-servidor/config/config.json para
// usar la configuración de la instalación.

import { config, settings as configSettings, ROOT } from '../src/config.js';
import { spawn, execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newState, runWith } from '../src/context.js';
import * as db from '../src/db.js';
import * as clock from '../src/clock.js';
import * as settings from '../src/settings.js';
import * as admin from '../src/admin.js';
import * as mail from '../src/mail.js';
import * as push from '../src/push.js';
import * as qr from '../src/qr.js';

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
const opts = process.argv.slice(3);
if (!/^https?:\/\//.test(base)) {
  console.error('Uso: node pruebas/run.js <url base> --yes [--insecure] [--only=CP-01,CP-02]');
  process.exit(2);
}
if (config('test_clock') !== true) {
  console.error('Activa "test_clock": true en config/config.json (solo en un servidor de pruebas).');
  process.exit(2);
}
if (!opts.includes('--yes')) {
  console.error('Estas pruebas BORRAN todas las cuentas y reservas. Añade --yes para continuar.');
  process.exit(2);
}
if (opts.includes('--insecure')) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const only = opts.find((o) => o.startsWith('--only='))?.slice(7).split(',') ?? null;

// ---------------------------------------------------------------------------
// Cliente HTTP con su propio token de sesión y su reloj simulado
// ---------------------------------------------------------------------------

class Res {
  constructor(status, body, headers) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }

  code() {
    return this.body?.error?.code ?? null;
  }
}

class Client {
  token = null;
  email = '';

  constructor(now) {
    this.now = now;
  }

  at(now) {
    this.now = now;
    return this;
  }

  /** Petición sin seguir redirecciones; devuelve la respuesta de fetch. */
  raw(method, path, body = null, extra = {}) {
    const headers = { Accept: 'application/json', 'X-Test-Now': this.now, ...extra };
    if (this.token !== null && !('Authorization' in extra)) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    const init = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) };
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(`${base}/api/v1${path}`, init);
  }

  async req(method, path, body = null, extra = {}) {
    const res = await this.raw(method, path, body, extra);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { _raw: text };
    }
    // Login y registro devuelven el token: a partir de aquí va en cada petición.
    if (typeof data?.session?.token === 'string') {
      this.token = data.session.token;
    }
    return new Res(res.status, data, res.headers);
  }

  get(p, extra = {}) { return this.req('GET', p, null, extra); }
  post(p, b = {}) { return this.req('POST', p, b); }
  patch(p, b = {}) { return this.req('PATCH', p, b); }
  put(p, b = {}) { return this.req('PUT', p, b); }
  delete(p, b = {}) { return this.req('DELETE', p, b); }
}

// ---------------------------------------------------------------------------
// Utilidades de las pruebas
// ---------------------------------------------------------------------------

const results = { ok: 0, fail: 0 };
const failures = [];
let current = '';

function check(cond, what, detail = undefined) {
  if (cond) {
    results.ok++;
    console.log(`    \x1b[32m✔\x1b[0m ${what}`);
  } else {
    results.fail++;
    failures.push(`${current}: ${what}`);
    console.log(`    \x1b[31m✘ ${what}\x1b[0m${detail !== undefined ? ` → ${JSON.stringify(detail)}` : ''}`);
  }
}

/** Igualdad de valores JSON (listas y objetos con el mismo orden de claves). */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera a que fn() devuelva algo verdadero (hasta ms). Las devoluciones y
 * los envíos se hacen después de responder, así que tardan unos milisegundos.
 */
async function eventually(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) {
      return v;
    }
    await sleep(50);
  }
}

/** Día base: un sábado al menos 14 días en el futuro, para que el worker real no lo toque. */
let D = clock.addDays(clock.startOfDay(new Date()), 14);
while (D.getDay() !== 6) {
  D = clock.addDays(D, 1);
}

/** Fecha y hora relativa al día base: at(-1, '21:00') = viernes 21:00. */
const at = (days, hhmm) => `${clock.ymd(clock.addDays(D, days))} ${hhmm}:00`;
const day = (days = 0) => clock.ymd(clock.addDays(D, days));
const plusMinutes = (sqlText, minutes) => clock.sql(clock.plus(clock.at(sqlText), minutes));

const client = (now) => new Client(now);

const PASSWORD = 'Prueba-MesaLista-2026';
let seq = 0;

/** Registra un cliente nuevo y devuelve su cliente HTTP con la sesión iniciada. */
async function newClient(now, phone = null) {
  seq++;
  const c = client(now);
  const email = `cliente${seq}@pruebas.test`;
  const r = await c.post('/auth/register', {
    name: `Cliente Prueba ${String.fromCharCode(65 + (seq % 26))}`,
    email,
    phone: phone ?? `+34600${String(seq).padStart(6, '0')}`,
    password: PASSWORD,
  });
  if (r.status !== 201) {
    throw new Error(`No se pudo registrar: ${JSON.stringify(r.body)}`);
  }
  c.email = email;
  return c;
}

async function staffClient(now, role = 'staff') {
  seq++;
  const email = `${role}${seq}@pruebas.test`;
  await admin.createStaff({ name: 'Personal Prueba', email, password: PASSWORD, role });
  const c = client(now);
  const r = await c.post('/panel/login', { email, password: PASSWORD });
  if (r.status !== 200) {
    throw new Error(`No se pudo iniciar sesión del personal: ${JSON.stringify(r.body)}`);
  }
  return c;
}

/**
 * Sesión nueva del personal a esa hora. Las pruebas saltan horas en el reloj
 * simulado, y una sesión del panel se cierra tras 30 minutos sin uso (RS-05).
 */
const staffAt = (now) => staffClient(now);

function reserve(c, date, time, party, extra = {}) {
  return c.post('/reservations', { request_id: randomUUID(), date, time, party, ...extra });
}

/**
 * Atajo de las pruebas: las 12 mesas con plano numeradas en orden (1-8 la
 * sala, 9-12 la terraza): code(3) = 'S-3', code(9) = 'T-1'. Un código se
 * devuelve tal cual.
 */
const code = (t) => (typeof t === 'string' ? t : t <= 8 ? `S-${t}` : `T-${t - 8}`);

/** Id de una mesa por su código ('S-3') o por su número en orden (3, 9…). */
const tableId = async (t) => db.value('SELECT id FROM dining_tables WHERE code_live = ?', [code(t)]);
const tableIds = (list) => Promise.all(list.map(tableId));

/** Id de una opción de menú (cambia cada vez que se recargan los datos de prueba). */
const optionId = (name) => db.value('SELECT id FROM menu_options WHERE name = ?', [name]);

const status = (id) => db.value('SELECT status FROM reservations WHERE id = ?', [id]);
const countReservations = () => db.value('SELECT COUNT(*) FROM reservations');

/** Ocupa una mesa con un cliente sin reserva que ya está sentado. */
async function occupy(table, now) {
  return db.insert(
    `INSERT INTO reservations (source, table_id, party_size, start_at, end_at, arrived_at, status,
                               arrival_before_min, arrival_after_min, change_deadline_h, created_at)
     VALUES ('walkin', ?, 2, ?, ?, ?, 'seated', 15, 20, 24, ?)`,
    [await tableId(table), now, plusMinutes(now, 120), now, now],
  );
}

/** Deja la base de datos con el restaurante de pruebas y sin cuentas ni reservas. */
async function resetDatabase() {
  await db.script(`TRUNCATE table_occupancy, reservation_menu_options, reservation_tables, table_holds, notifications,
                   email_outbox, push_outbox, push_devices, payments, group_requests, password_resets, secrets,
                   reservations, sessions, login_attempts, link_attempts, users, dining_tables, service_slots,
                   closed_days, settings, menu_options RESTART IDENTITY CASCADE`);
  await db.script(readFileSync(join(ROOT, 'bd', 'datos.sql'), 'utf8'));
  settings.forget();
}

async function setSetting(name, value) {
  await db.exec('UPDATE settings SET value = ? WHERE name = ?', [value, name]);
  settings.forget();
}

/** Último correo en cola para to cuyo asunto contiene subject (o null). */
const mailTo = (to, subject) => db.value(
  'SELECT body FROM email_outbox WHERE to_email = ? AND subject LIKE ? ORDER BY id DESC LIMIT 1', [to, `%${subject}%`],
);

/** GET sin seguir redirecciones: [código, dirección de destino]. Admite la URL completa. */
async function redirectOf(c, url) {
  const path = url.startsWith('http') ? url.replace(/^https?:\/\/[^/]+\/api\/v1/, '') : url;
  const res = await c.raw('GET', path);
  await res.arrayBuffer();
  return [res.status, res.headers.get('location') ?? ''];
}

/** Solicitud de grupo aceptada por el personal con esas mesas: devuelve la reserva (vista del personal). */
async function acceptedGroup(c, staff, date, time, party, tables) {
  await c.post('/group-requests', { date, time, party });
  const gid = await db.value('SELECT MAX(id) FROM group_requests');
  const r = await staff.post(`/panel/group-requests/${gid}/accept`, { table_ids: await tableIds(tables) });
  if (r.status !== 200) {
    throw new Error(`No se pudo aceptar el grupo: ${JSON.stringify(r.body)}`);
  }
  return r.body.reservation;
}

/** El titular paga la señal con la pasarela simulada: devuelve la dirección de la web o de la app a la que vuelve. */
async function payDeposit(c, id, returnAt = null, from = 'web') {
  const url = (await c.post(`/reservations/${id}/pay`, { from })).body.approve_url ?? '';
  if (returnAt !== null) {
    c.at(returnAt);
  }
  const [, toReturn] = await redirectOf(c, url);
  const [, toApp] = await redirectOf(c, toReturn);
  return toApp;
}

/** Arranca un servidor falso (azure-stub.js o fcm-stub.js) y espera a que escuche. */
async function startStub(file, port, env) {
  const child = spawn(process.execPath, [join(ROOT, 'pruebas', file)], {
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    const up = await new Promise((resolve) => {
      const s = connect(port, '127.0.0.1', () => { s.end(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (up) {
      break;
    }
    await sleep(100);
  }
  return child;
}

const tests = [];
const test = (id, title, fn) => tests.push({ id, title, fn });

// ---------------------------------------------------------------------------
// CP-01 · RF-01, RS-09
// ---------------------------------------------------------------------------
test('CP-01', 'Registro y contraseñas robustas', async () => {
  const c = client(at(-3, '12:00'));
  const ok = await c.post('/auth/register', { name: 'Lucía Ferrer', email: 'lucia@pruebas.test', phone: '+34 600 111 222', password: PASSWORD });
  check(ok.status === 201, 'una cuenta nueva se crea', ok.body);
  const dup = await client(at(-3, '12:00')).post('/auth/register', { name: 'Otra', email: 'LUCIA@pruebas.test', phone: '+34600111333', password: PASSWORD });
  check(dup.status === 409 && dup.code() === 'email_taken', 'el mismo correo se rechaza', dup.body);
  const short = await client(at(-3, '12:00')).post('/auth/register', { name: 'Pepe', email: 'pepe@pruebas.test', phone: '+34600111444', password: '123456789' });
  check(short.status === 422, 'una contraseña de 9 caracteres se rechaza', short.body);
  const common = await client(at(-3, '12:00')).post('/auth/register', { name: 'Pepe', email: 'pepe@pruebas.test', phone: '+34600111444', password: '1234567890' });
  check(common.status === 422, '«1234567890» se rechaza por común', common.body);
  check((await db.value('SELECT COUNT(*) FROM users')) === 1, 'solo existe una cuenta');
});

// ---------------------------------------------------------------------------
// CP-02 · RF-02, RF-03, RS-05, RS-06
// ---------------------------------------------------------------------------
test('CP-02', 'Inicio y cierre de sesión, caducidad y bloqueo', async () => {
  const t0 = at(-3, '12:00');
  const c = await newClient(t0);
  const { email } = c;

  const badPass = await client(t0).post('/auth/login', { email, password: 'incorrecta-123' });
  const badMail = await client(t0).post('/auth/login', { email: 'nadie@pruebas.test', password: PASSWORD });
  check(badPass.status === 401 && badMail.status === 401
    && badPass.body.error.message === badMail.body.error.message, 'mismo mensaje genérico con correo o contraseña erróneos');

  const s = client(t0);
  check((await s.post('/auth/login', { email, password: PASSWORD })).status === 200, 'con credenciales correctas se inicia sesión');
  check((await s.get('/reservations')).status === 200, 'con la sesión se piden las reservas');
  await s.post('/auth/logout');
  const copy = client(t0);
  copy.token = c.token;
  await c.post('/auth/logout');
  check((await copy.get('/reservations')).status === 401, 'tras cerrar la sesión, el mismo token se rechaza');

  const t = client(t0);
  await t.post('/auth/login', { email, password: PASSWORD });
  check((await t.at(at(-3, '12:59')).get('/me')).status === 200, 'la sesión vale a los 59 minutos');
  check((await t.at(at(-3, '13:01')).get('/me')).status === 401, 'la sesión se rechaza a los 61 minutos');

  const victim = await newClient(t0);
  const x = client(at(-3, '14:00'));
  for (let i = 1; i <= 5; i++) {
    await x.post('/auth/login', { email: victim.email, password: `mala-${i}-xxxxx` });
  }
  const sixth = await x.post('/auth/login', { email: victim.email, password: PASSWORD });
  check(sixth.status === 429, 'el sexto intento se rechaza aunque la contraseña sea correcta', sixth.body);
  const later = await x.at(at(-3, '14:16')).post('/auth/login', { email: victim.email, password: PASSWORD });
  check(later.status === 200, 'pasados 15 minutos vuelve a poder entrar', later.body);

  const p = await staffClient(at(-3, '10:00'));
  check((await p.at(at(-3, '10:29')).get('/panel/me')).status === 200, 'panel activo a los 29 minutos');
  check((await p.at(at(-3, '11:00')).get('/panel/me')).status === 401, 'panel cerrado tras 31 minutos sin actividad');
  const q = await staffClient(at(-3, '10:00'));
  await q.at(at(-3, '10:10')).get('/panel/version', { 'X-Background': '1' });
  check((await q.at(at(-3, '10:31')).get('/panel/me')).status === 401, 'el sondeo automático no cuenta como actividad');
  const r = await staffClient(at(-3, '10:00'));
  for (let m = 0; m < 8 * 60; m += 25) {
    await r.at(plusMinutes(at(-3, '10:00'), m)).get('/panel/me');
  }
  check((await r.at(at(-3, '18:01')).get('/panel/me')).status === 401, 'panel cerrado a las 8 horas aunque haya actividad');

  // Token Bearer: el de un tipo de sesión no vale en las rutas del otro, y
  // usarlo mal no cierra la sesión de su lado.
  const panel = await staffClient(at(-3, '10:00'));
  const wrong = client(at(-3, '10:01'));
  wrong.token = panel.token;
  check((await wrong.get('/me')).status === 401, 'el token del panel no vale en las rutas de cliente');
  check((await panel.at(at(-3, '10:02')).get('/panel/me')).status === 200, 'y la sesión del panel sigue abierta');
  check((await client(at(-3, '10:00')).get('/me', { Authorization: 'Basic eDp5' })).status === 401, 'una cabecera Authorization que no es Bearer se rechaza');

  // RS-06 detrás de la web: su servidor envía la IP del navegador en
  // X-Forwarded-For y la API solo la acepta desde trusted_proxies (127.0.0.1 en desarrollo).
  if (['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) {
    const who = await newClient(at(-3, '15:00'));
    const web = client(at(-3, '15:00'));
    for (let i = 1; i <= 5; i++) {
      await web.req('POST', '/auth/login', { email: who.email, password: `mala-${i}-xxxxx` }, { 'X-Forwarded-For': '203.0.113.10' });
    }
    const blocked = await web.req('POST', '/auth/login', { email: who.email, password: PASSWORD }, { 'X-Forwarded-For': '203.0.113.10' });
    const other = await web.req('POST', '/auth/login', { email: who.email, password: PASSWORD }, { 'X-Forwarded-For': '203.0.113.11' });
    check(blocked.status === 429 && other.status === 200,
      'el bloqueo por intentos es por la IP del navegador que envía la web, no por la de la web', [blocked.status, other.status]);
  } else {
    check(true, 'omitida: X-Forwarded-For solo se comprueba contra la API local');
  }
});

// ---------------------------------------------------------------------------
// CP-03 · RF-04, RF-05, RP-02, RP-03, RP-08
// ---------------------------------------------------------------------------
test('CP-03', 'Perfil, eliminación de cuenta y borrado de datos', async () => {
  const now = at(-3, '12:00');
  const c = await newClient(now);
  const p = await c.patch('/me', { phone: '+34 699 000 111' });
  check(p.status === 200 && (await c.get('/me')).body.user.phone === '+34699000111', 'RF-04: el perfil devuelve el teléfono nuevo');

  const r1 = (await reserve(c, day(), '20:00', 2, { note: 'nota', consent: true })).body.reservation.id;
  const r2 = (await reserve(c, day(), '13:00', 2)).body.reservation.id;
  const uid = await db.value('SELECT id FROM users WHERE email = ?', [c.email]);
  const del = await c.delete('/me', { password: PASSWORD });
  check(del.status === 200, 'la cuenta se elimina', del.body);
  check((await status(r1)) === 'cancelled' && (await status(r2)) === 'cancelled', 'sus dos reservas futuras quedan «cancelada»');
  check((await db.value('SELECT COUNT(*) FROM users WHERE id = ?', [uid])) === 0, 'nombre, correo y teléfono borrados');
  check((await db.value('SELECT COUNT(*) FROM reservations WHERE user_id IS NOT NULL OR note IS NOT NULL')) === 0, 'las reservas se conservan sin datos personales');
  const login = await client(now).post('/auth/login', { email: c.email, password: PASSWORD });
  check(login.status === 401, 'la cuenta ya no inicia sesión');

  // RP-03 y RP-08 con reservas antiguas insertadas directamente.
  const today = clock.startOfDay(new Date());
  const t1 = await tableId(1);
  const gf = await optionId('Sin gluten');
  const mk = async (daysAgo, st) => {
    const start = `${clock.ymd(clock.addDays(today, -daysAgo))} 21:00:00`;
    const id = await db.insert(
      `INSERT INTO reservations (source, guest_name, guest_phone, table_id, party_size, start_at, end_at, status,
                                 arrival_before_min, arrival_after_min, change_deadline_h, note, created_at)
       VALUES ('local', 'Persona Antigua', '+34600999999', ?, 2, ?, ?, ?, 15, 20, 24, 'nota antigua', ?)`,
      [t1, start, plusMinutes(start, 120), st, start],
    );
    await db.exec('INSERT INTO reservation_menu_options (reservation_id, option_id) VALUES (?, ?)', [id, gf]);
    return id;
  };
  const d89 = await mk(89, 'completed');
  const d91 = await mk(91, 'no_show');
  const d6 = await mk(6, 'completed');
  const d8 = await mk(8, 'completed');
  await db.run('CALL sp_daily_purge(?::date)', [clock.ymd(today)]);
  const row = (id) => db.one('SELECT guest_name, guest_phone, note FROM reservations WHERE id = ?', [id]);
  const optsOf = (id) => db.value('SELECT COUNT(*) FROM reservation_menu_options WHERE reservation_id = ?', [id]);
  const r91 = await row(d91);
  check(r91.guest_name === null && r91.guest_phone === null, 'RP-03: la de hace 91 días pierde los datos personales');
  check((await row(d89)).guest_name !== null, 'RP-03: la de hace 89 días los conserva');
  check((await row(d8)).note === null && (await optsOf(d8)) === 0, 'RP-08: la de hace 8 días pierde opciones y nota');
  check((await row(d6)).note !== null && (await optsOf(d6)) === 1, 'RP-08: la de hace 6 días las conserva');

  // PostgreSQL no tiene eventos: la limpieza diaria la lanza cron con worker.js --diario.
  const out = await new Promise((resolve) => {
    execFile(process.execPath, [join(ROOT, 'bin', 'worker.js'), '--diario'], { env: process.env },
      (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, text: `${stdout}${stderr}` }));
  });
  check(out.code === 0 && out.text.includes('limpieza diaria hecha'), 'worker.js --diario ejecuta la limpieza diaria', out);
});

// ---------------------------------------------------------------------------
// CP-04 · RF-06, RF-07, RF-08, RF-12, RF-13, RP-04
// ---------------------------------------------------------------------------
test('CP-04', 'Disponibilidad, reserva, asignación, opciones y nota', async () => {
  const now = at(-3, '12:00');
  const c = await newClient(now);
  const avail = await c.get(`/availability?date=${day()}&party=4`);
  check(avail.status === 200 && avail.body.times.includes('21:00'), 'las 21:00 aparecen para cuatro', avail.body);
  check(!avail.body.times.includes('22:30') && avail.body.times.includes('22:00'), 'la última cena empieza a las 22:00');

  const note = 'a'.repeat(200);
  const gf = await optionId('Sin gluten');
  const r = await reserve(c, day(), '21:00', 4, { menu_options: [gf], note, consent: true });
  check(r.status === 201 && r.body.reservation.status === 'confirmed', 'la reserva queda confirmada', r.body);
  const id = r.body.reservation?.id ?? 0;
  const row = await db.one('SELECT r.*, t.max_capacity FROM reservations r JOIN dining_tables t ON t.id = r.table_id WHERE r.id = ?', [id]);
  check(row?.max_capacity === 4, 'se asigna una mesa de 4 (la de menor capacidad)', row?.max_capacity);
  check(row?.note === note && row?.consent_at !== null, 'la nota de 200 caracteres y el consentimiento se guardan');
  check((await db.value('SELECT option_id FROM reservation_menu_options WHERE reservation_id = ?', [id])) === gf, 'la opción «sin gluten» se guarda');

  const staff = await staffClient(now);
  const agenda = await staff.get(`/panel/reservations?date=${day()}`);
  const seen = agenda.body.reservations.filter((x) => x.id === id);
  check(seen.length > 0 && seen[0].note === note && same(seen[0].menu_options, [gf]), 'el personal ve la nota y las opciones en la agenda');

  const tooLong = await reserve(c, day(), '13:00', 2, { note: 'b'.repeat(201), consent: true });
  check(tooLong.status === 422, 'una nota de 201 caracteres se rechaza', tooLong.body);
  const noConsent = await reserve(c, day(), '13:00', 2, { menu_options: [await optionId('Vegetariano')], note: 'vegetariana', consent: false });
  const nid = noConsent.body.reservation?.id ?? 0;
  check(noConsent.status === 201 && (await db.value('SELECT note FROM reservations WHERE id = ?', [nid])) === null
    && (await db.value('SELECT COUNT(*) FROM reservation_menu_options WHERE reservation_id = ?', [nid])) === 0,
  'sin consentimiento se guarda sin opciones ni nota (RP-04)');

  // RF-06: con todas las mesas de cuatro ocupadas a las 21:00, no se ofrece para cuatro y sí para dos.
  const others = [];
  for (let i = 0; i < 8; i++) {
    others.push(await newClient(now));
  }
  for (const o of others) {
    await reserve(o, day(), '21:00', 4);
  }
  const four = (await c.get(`/availability?date=${day()}&party=4`)).body.times;
  const two = (await c.get(`/availability?date=${day()}&party=2`)).body.times;
  check(!four.includes('21:00'), 'sin mesas para cuatro, las 21:00 no aparecen para cuatro', four);
  check(two.includes('21:00'), 'pero sí para dos', two);
});

// ---------------------------------------------------------------------------
// CP-05 · RF-09 (CA-09-1 a CA-09-3)
// ---------------------------------------------------------------------------
test('CP-05', 'Reservas consecutivas, solapadas y sobre intervalos liberados', async () => {
  const now = at(-3, '12:00');
  const a = await newClient(now);
  const b = await newClient(now);
  const c = await newClient(now);
  // Solo la mesa 8 admite 10 comensales.
  const r1 = await reserve(a, day(), '20:00', 10);
  const r2 = await reserve(b, day(), '22:00', 10);
  check(r1.status === 201 && r2.status === 201, 'CA-09-1: 20:00-22:00 y 22:00-00:00 en la misma mesa se aceptan');
  const before = await countReservations();
  const r3 = await reserve(c, day(), '21:00', 10);
  check(r3.status === 409 && r3.code() === 'conflict' && (await countReservations()) === before, 'CA-09-2: una solicitud para las 21:00 se rechaza y no crea reserva', r3.body);
  await a.post(`/reservations/${r1.body.reservation.id}/cancel`);
  await b.post(`/reservations/${r2.body.reservation.id}/cancel`);
  const r4 = await reserve(c, day(), '21:00', 10);
  check(r4.status === 201, 'CA-09-3: al cancelarse, el intervalo vuelve a estar disponible', r4.body);
});

// ---------------------------------------------------------------------------
// CP-06 · RF-09 (CA-09-4): 20 solicitudes simultáneas por la única mesa
// ---------------------------------------------------------------------------
test('CP-06', '20 clientes piden a la vez la única mesa disponible', async () => {
  const now = at(-3, '12:00');
  const clients = [];
  for (let i = 0; i < 20; i++) {
    clients.push(await newClient(now));
  }
  const responses = await Promise.all(clients.map((c) => c.raw('POST', '/reservations',
    { request_id: randomUUID(), date: day(), time: '13:00', party: 10 })));
  const codes = responses.map((r) => r.status);
  await Promise.all(responses.map((r) => r.arrayBuffer()));
  const created = codes.filter((s) => s === 201).length;
  const conflicts = codes.filter((s) => s === 409).length;
  check(created === 1, 'se confirma exactamente una reserva', codes);
  check(conflicts === 19, 'las otras 19 se rechazan por conflicto');
  const t8 = await tableId(8);
  const inDb = await db.value("SELECT COUNT(*) FROM reservations WHERE status = 'confirmed' AND table_id = ?", [t8]);
  check(inDb === 1, 'en la base de datos hay una sola reserva en la mesa');

  // Segunda protección: aunque un fallo del código intentara guardar una
  // reserva solapada (aquí, escribiendo directamente), PostgreSQL la rechaza.
  const overlap = (from, to) => db.tx(() => db.insert(
    `INSERT INTO reservations (source, guest_name, table_id, party_size, start_at, end_at, status,
                               arrival_before_min, arrival_after_min, change_deadline_h, created_at)
     VALUES ('local', 'Solapada', ?, 2, ?, ?, 'confirmed', 15, 20, 24, ?)`,
    [t8, from, to, at(-3, '12:00')],
  ));
  try {
    await overlap(at(0, '14:00'), at(0, '16:00'));
    check(false, 'la base de datos debería rechazar una reserva solapada');
  } catch (e) {
    check(db.isOverlap(e) && (await countReservations()) === 1,
      'la base de datos rechaza por sí sola una reserva solapada en la misma mesa', e.code);
  }
  check((await overlap(at(0, '15:00'), at(0, '17:00'))) > 0, 'una reserva justo a continuación (15:00) sí entra');
});

// ---------------------------------------------------------------------------
// CP-07 · RF-10
// ---------------------------------------------------------------------------
test('CP-07', 'La misma solicitud enviada tres veces', async () => {
  const c = await newClient(at(-3, '12:00'));
  const payload = { request_id: randomUUID(), date: day(), time: '20:30', party: 3 };
  const ids = [];
  const statuses = [];
  for (let i = 0; i < 3; i++) {
    const r = await c.post('/reservations', payload);
    statuses.push(r.status);
    ids.push(r.body.reservation?.id ?? null);
  }
  check(same(statuses, [201, 200, 200]), 'la primera crea y las repeticiones responden 200', statuses);
  check(new Set(ids).size === 1 && ids[0] !== null, 'las tres respuestas identifican la misma reserva', ids);
  check((await countReservations()) === 1, 'hay una sola reserva');
});

// ---------------------------------------------------------------------------
// CP-08 · RF-11, RF-36, RS-08
// ---------------------------------------------------------------------------
test('CP-08', 'Límite por cliente, día cerrado y datos incorrectos', async () => {
  const c = await newClient(at(-3, '12:00'));
  for (const t of ['13:00', '13:30', '14:00']) {
    await reserve(c, day(), t, 2);
  }
  const before = await countReservations();
  const fourth = await reserve(c, day(), '20:00', 2);
  check(fourth.status === 409 && fourth.code() === 'limit', 'la cuarta reserva se rechaza', fourth.body);

  await db.exec('INSERT INTO closed_days (day) VALUES (?)', [day(1)]);
  const d = await newClient(at(-3, '12:00'));
  const closed = await reserve(d, day(1), '13:00', 2);
  check(closed.status === 422 && closed.code() === 'closed', 'una reserva en día cerrado se rechaza', closed.body);
  check(same((await d.get(`/availability?date=${day(1)}&party=2`)).body.times, []), 'un día cerrado no ofrece ninguna hora');

  const bad = {
    'comensales = 0': { date: day(), time: '20:00', party: 0 },
    'fecha pasada': { date: day(-10), time: '20:00', party: 2 },
    'hora no permitida': { date: day(), time: '20:10', party: 2 },
    'nota de 5.000': { date: day(), time: '20:00', party: 2, note: 'x'.repeat(5000), consent: true },
    'opción inexistente': { date: day(), time: '20:00', party: 2, menu_options: [999], consent: true },
    'inyección en fecha': { date: "2026-01-01' OR '1'='1", time: '20:00', party: 2 },
    'inyección en hora': { date: day(), time: '20:00; DROP TABLE reservations;--', party: 2 },
    'comensales en texto': { date: day(), time: '20:00', party: '2 OR 1=1' },
    'campo desconocido': { date: day(), time: '20:00', party: 2, user_id: 1 },
  };
  for (const [what, payload] of Object.entries(bad)) {
    const r = await d.post('/reservations', { request_id: randomUUID(), ...payload });
    check(r.status === 422, `rechaza ${what}`, r.body);
  }
  const inj = await client(at(-3, '12:00')).post('/auth/register', { name: "Robert'); DROP TABLE users;--", email: 'x@pruebas.test', phone: '+34600000001', password: PASSWORD });
  check(inj.status === 422, 'rechaza un nombre con inyección SQL', inj.body);
  check((await countReservations()) === before, 'la base de datos no ha cambiado');
});

// ---------------------------------------------------------------------------
// CP-09 · RF-14, RF-15, RS-03
// ---------------------------------------------------------------------------
test('CP-09', 'Consultar y modificar las propias; no las ajenas', async () => {
  const now = at(-3, '12:00');
  const a = await newClient(now);
  const b = await newClient(now);
  const ra = (await reserve(a, day(), '20:00', 2)).body.reservation;
  const rb = (await reserve(b, day(), '20:00', 2)).body.reservation;
  const list = (await a.get('/reservations')).body.reservations;
  check(list.length === 1 && list[0].id === ra.id, 'A solo ve su reserva');

  const mod = await a.patch(`/reservations/${ra.id}`, { time: '21:00', party: 3 });
  check(mod.status === 200 && mod.body.reservation.time === '21:00' && mod.body.reservation.party === 3, 'la modificación válida se aplica', mod.body);
  check(mod.body.reservation?.qr !== ra.qr, 'la reserva modificada tiene un QR nuevo (RF-18)');

  // Sin mesa para 10 a las 21:00: se ocupa la única mesa de 10.
  await reserve(await newClient(now), day(), '21:00', 10);
  const snapshotSql = 'SELECT table_id, party_size, start_at, qr_version FROM reservations WHERE id = ?';
  const snapshot = await db.one(snapshotSql, [ra.id]);
  const imp = await a.patch(`/reservations/${ra.id}`, { party: 9 });
  check(imp.status === 409 && imp.code() === 'conflict', 'pedir comensales sin mesa libre devuelve conflicto', imp.body);
  check(same(await db.one(snapshotSql, [ra.id]), snapshot), 'la reserva conserva hora, mesa y QR');

  const rowB = await db.one('SELECT * FROM reservations WHERE id = ?', [rb.id]);
  check((await a.get(`/reservations/${rb.id}`)).status === 404, 'A no puede consultar la de B');
  check((await a.patch(`/reservations/${rb.id}`, { time: '22:00' })).status === 404, 'A no puede modificar la de B');
  check((await a.post(`/reservations/${rb.id}/cancel`)).status === 404, 'A no puede cancelar la de B');
  check(same(await db.one('SELECT * FROM reservations WHERE id = ?', [rb.id]), rowB), 'la reserva de B no ha cambiado');
});

// ---------------------------------------------------------------------------
// CP-10 · RF-16, RF-31 (CA-16-1 a CA-16-5)
// ---------------------------------------------------------------------------
test('CP-10', 'Cancelaciones del titular y del personal', async () => {
  const book = at(-5, '12:00');
  const a = await newClient(book);
  const b = await newClient(book);
  const r1 = (await reserve(a, day(), '20:00', 2)).body.reservation.id;
  const r2 = (await reserve(a, day(), '21:00', 2)).body.reservation.id;
  const r3 = (await reserve(b, day(), '20:00', 2)).body.reservation.id;

  // Las sesiones de cliente duran 60 minutos: cada salto de hora usa una sesión nueva.
  const login = async (c, now) => {
    await c.at(now).post('/auth/login', { email: c.email, password: PASSWORD });
    return c;
  };
  const ok = await (await login(a, at(-1, '14:00'))).post(`/reservations/${r1}/cancel`);
  check(ok.status === 200 && (await status(r1)) === 'cancelled', 'CA-16-1: 30 horas antes se cancela', ok.body);
  check((await db.value("SELECT COUNT(*) FROM email_outbox WHERE subject LIKE '%cancelada%'")) >= 1 || config('mail.enabled') === true,
    'RF-17: se prepara el correo de cancelación');
  const late = await (await login(a, at(0, '01:00'))).post(`/reservations/${r2}/cancel`);
  check(late.status === 409 && late.code() === 'deadline' && (await status(r2)) === 'confirmed', 'CA-16-2: 20 horas antes se rechaza', late.body);
  const other = await (await login(b, at(-1, '14:00'))).post(`/reservations/${r2}/cancel`);
  check(other.status === 404 && (await status(r2)) === 'confirmed', 'CA-16-3: otra cuenta no puede cancelarla');
  const again = await (await login(a, at(-1, '14:05'))).post(`/reservations/${r1}/cancel`);
  check(again.status === 200 && (await status(r1)) === 'cancelled', 'CA-16-5: repetir la cancelación responde con éxito y no cambia nada');

  const byStaff = await (await staffAt(at(0, '19:30'))).post(`/panel/reservations/${r3}/cancel`);
  check(byStaff.status === 200 && (await status(r3)) === 'cancelled', 'RF-31: el personal cancela 30 minutos antes', byStaff.body);
  const notes = (await (await login(b, at(0, '19:31'))).get('/me/notifications')).body.notifications ?? [];
  check(notes.length === 1, 'RF-32: el titular ve el aviso al abrir la app', notes);

  await (await staffAt(at(0, '20:50'))).post(`/panel/reservations/${r2}/arrive`);
  const seated = await (await login(a, at(0, '20:55'))).post(`/reservations/${r2}/cancel`);
  check(seated.status === 409, 'CA-16-4: una reserva en curso no se cancela', seated.body);
});

// ---------------------------------------------------------------------------
// CP-11 · RF-17 · correo por Azure Communication Services (servidor falso
// azure-stub.js, que comprueba la firma como Azure)
// ---------------------------------------------------------------------------
test('CP-11', 'Correo por Azure Communication Services', async () => {
  const port = 18099;
  const key = Buffer.from('clave-de-pruebas-de-mesalista').toString('base64');
  const log = join(tmpdir(), `ml-azure-${randomBytes(4).toString('hex')}.log`);
  writeFileSync(log, '');
  const stub = await startStub('azure-stub.js', port, { ML_AZURE_KEY: key, ML_AZURE_LOG: log, ML_AZURE_PORT: String(port) });
  const saved = configSettings.mail;
  const use = (connection) => {
    configSettings.mail = { enabled: true, connection_string: connection, sender: 'DoNotReply@pruebas.azurecomm.net' };
  };
  const outbox = () => db.all('SELECT to_email, attempts, claim, last_error FROM email_outbox ORDER BY id');
  try {
    use('');
    await mail.queue('ana@pruebas.test', 'Reserva confirmada', 'Hola, Ana:\n\nTu reserva está confirmada.\n');
    let sent = await mail.flush(50);
    let rows = await outbox();
    check(sent === 0 && rows.length === 1 && rows[0].attempts === 0,
      'sin cadena de conexión no se envía nada y el correo espera en la cola', rows);

    use(`endpoint=http://127.0.0.1:${port}/;accesskey=${Buffer.from('otra-clave').toString('base64')}`);
    sent = await mail.flush(50);
    rows = await outbox();
    check(sent === 0 && rows[0].attempts === 1 && String(rows[0].last_error).includes('Azure HTTP 401'),
      'con una clave equivocada Azure responde 401 y se gasta un intento', rows);

    use(`endpoint=http://127.0.0.1:${port}/;accesskey=${key}`);
    sent = await mail.flush(50);
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const msg = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : {};
    check(sent === 1 && (await outbox()).length === 0, 'con la clave buena Azure lo acepta (202) y sale de la cola');
    check(msg.senderAddress === 'DoNotReply@pruebas.azurecomm.net'
      && msg.recipients?.to?.[0]?.address === 'ana@pruebas.test'
      && msg.content?.subject === 'MesaLista · Reserva confirmada'
      && String(msg.content?.plainText ?? '').includes('Tu reserva está confirmada.')
      && msg.userEngagementTrackingDisabled === true,
    'el mensaje lleva remitente, destinatario, asunto y texto en UTF-8, sin seguimiento', msg);

    for (let i = 1; i <= 7; i++) {
      await mail.queue(`cliente${i}@pruebas.test`, 'Prueba', 'Texto');
    }
    sent = await mail.flush(50);
    check(sent === 5 && (await outbox()).length === 2, 'cada vuelta envía como mucho 5 (límite del dominio de Azure)', sent);
    await db.exec('DELETE FROM email_outbox');

    await mail.queue('limite@pruebas.test', 'Prueba', 'Texto');
    await mail.queue('luis@pruebas.test', 'Prueba', 'Texto');
    sent = await mail.flush(50);
    rows = await outbox();
    check(sent === 0 && rows.length === 2 && rows[0].attempts === 0 && rows[1].attempts === 0
      && rows[0].claim === null && rows[1].claim === null && String(rows[0].last_error).includes('429'),
    'si Azure pide esperar (429), el lote vuelve a la cola sin gastar intentos', rows);
    await db.exec('DELETE FROM email_outbox');

    await mail.queue('rechazo@pruebas.test', 'Prueba', 'Texto');
    await mail.flush(50);
    rows = await outbox();
    check(rows[0].attempts === 1 && String(rows[0].last_error).includes('Azure HTTP 400 InvalidRecipient'),
      'un destinatario rechazado gasta un intento y guarda el código de Azure', rows);
    await db.exec('DELETE FROM email_outbox');

    use(`endpoint=http://ejemplo.com/;accesskey=${key}`);
    await mail.queue('ana@pruebas.test', 'Prueba', 'Texto');
    await mail.flush(50);
    rows = await outbox();
    check(rows[0].attempts === 1 && String(rows[0].last_error).includes('no es una cadena de conexión')
      && !String(rows[0].last_error).includes(key),
    'sin HTTPS no se envía (RS-01) y el error no muestra la clave', rows);
  } finally {
    configSettings.mail = saved;
    stub.kill();
    rmSync(log, { force: true });
  }
});

// ---------------------------------------------------------------------------
// CP-12 · RF-18, RF-19, RF-20, RS-07 (CA-19-1 a CA-19-5)
// ---------------------------------------------------------------------------
test('CP-12', 'Validación del QR', async () => {
  const book = at(-3, '12:00');
  const c = await newClient(book);
  const r = (await reserve(c, day(), '21:00', 2)).body.reservation;
  const late = (await reserve(await newClient(book), day(), '21:00', 2)).body.reservation;
  const d = await newClient(book);
  const cancelled = (await reserve(d, day(), '20:00', 2)).body.reservation;
  await d.post(`/reservations/${cancelled.id}/cancel`);
  const m = (await reserve(d, day(), '20:30', 2)).body.reservation;
  await d.patch(`/reservations/${m.id}`, { party: 3 });

  const rc = await (await staffAt(at(0, '20:00'))).post('/panel/arrive-qr', { qr: cancelled.qr });
  check(rc.status === 409 && rc.code() === 'cancelled', 'CA-19-4: el QR de una reserva cancelada se rechaza', rc.body);
  const old = await (await staffAt(at(0, '20:30'))).post('/panel/arrive-qr', { qr: m.qr });
  check(old.status === 409 && old.code() === 'qr_outdated', 'CA-19-4: el QR anterior a una modificación se rechaza', old.body);

  const staff = await staffAt(at(0, '20:40'));
  const early = await staff.post('/panel/arrive-qr', { qr: r.qr });
  check(early.status === 409 && early.code() === 'too_early' && (await status(r.id)) === 'confirmed', 'CA-19-2: a las 20:40 se rechaza por llegada anticipada', early.body);
  const ok = await staff.at(at(0, '20:50')).post('/panel/arrive-qr', { qr: r.qr });
  check(ok.status === 200 && (await status(r.id)) === 'seated', 'CA-19-1: a las 20:50 se acepta y pasa a «en curso»', ok.body);
  const twice = await staff.at(at(0, '20:51')).post('/panel/arrive-qr', { qr: r.qr });
  check(twice.status === 409 && twice.code() === 'already_seated' && (await status(r.id)) === 'seated', 'RF-20: un segundo escaneo se rechaza', twice.body);

  const content = m.qr;
  const tampered = content.slice(0, -1) + (content.slice(-1) === 'A' ? 'B' : 'A');
  const alt = await staff.post('/panel/arrive-qr', { qr: tampered });
  check(alt.status === 422 && alt.code() === 'qr_invalid', 'CA-19-5: un QR con un carácter alterado se rechaza', alt.body);
  const forged = content.replace(/^ML1\.\d+\./, `ML1.${late.id}.`);
  const fake = await staff.post('/panel/arrive-qr', { qr: forged });
  check(fake.status === 422, 'RS-07: un QR fabricado con el id de otra reserva se rechaza', fake.body);

  const tooLate = await (await staffAt(at(0, '21:25'))).post('/panel/arrive-qr', { qr: late.qr });
  check(tooLate.status === 409 && (await status(late.id)) === 'no_show', 'CA-19-3: a las 21:25 se rechaza: ya está «no presentada»', tooLate.body);
});

// ---------------------------------------------------------------------------
// CP-13 · RF-21, RF-23, RF-26, RF-32, RF-35
// ---------------------------------------------------------------------------
test('CP-13', 'Mesa ocupada, más comensales, mesas desactivadas y llegada anticipada', async () => {
  const book = at(-3, '12:00');
  const tableOf = (id) => db.value('SELECT table_id FROM reservations WHERE id = ?', [id]);
  const codeOf = (tid) => db.value('SELECT code_live FROM dining_tables WHERE id = ?', [tid]);

  // RF-21 con otra mesa libre
  const c = await newClient(book);
  const r = (await reserve(c, day(), '21:00', 2)).body.reservation;
  const big = (await reserve(await newClient(book), day(), '21:00', 10)).body.reservation;
  const assigned = await tableOf(r.id);
  await occupy(await codeOf(assigned), at(0, '19:00'));
  const staff = await staffAt(at(0, '20:50'));
  const arr = await staff.post('/panel/arrive-qr', { qr: r.qr });
  check(arr.status === 200 && (await tableOf(r.id)) !== assigned,
    'RF-21: con la mesa asignada ocupada, la llegada se registra en otra libre', arr.body);

  // RF-21 sin ninguna mesa libre: solo la mesa 8 admite 10.
  await occupy(8, at(0, '19:00'));
  const none = await staff.at(at(0, '20:55')).post('/panel/arrive-qr', { qr: big.qr });
  check(none.status === 409 && none.code() === 'no_table' && none.body.error?.alert === true,
    'RF-21: sin ninguna libre, el panel recibe el aviso', none.body);

  // RF-26
  const s13 = await staffAt(at(0, '13:00'));
  const walk = (await s13.post('/panel/walkin', { party: 4, table_id: await tableId(6) })).body.reservation;
  check((await s13.post(`/panel/reservations/${walk.id}/party`, { party: 6 })).status === 200, 'RF-26: en una mesa de 6 con 4 se puede pasar a 6');
  const over = await s13.post(`/panel/reservations/${walk.id}/party`, { party: 7 });
  check(over.status === 409, 'pasar a 7 se rechaza', over.body);

  // RF-32 y RF-35: desactivar una mesa con reservas futuras (antes se liberan las mesas en curso).
  await db.exec("UPDATE reservations SET status = 'completed' WHERE status = 'seated'");
  const adminClient = await staffClient(book, 'admin');
  const holder = await newClient(book);
  const f1 = (await reserve(holder, day(1), '20:00', 6)).body.reservation;
  const t1 = await tableOf(f1.id);
  const res1 = await adminClient.patch(`/admin/tables/${t1}`, { active: false });
  check(res1.status === 200 && res1.body.moved === 1 && (await status(f1.id)) === 'confirmed'
    && (await tableOf(f1.id)) !== t1, 'con otra mesa adecuada libre, la reserva pasa a ella', res1.body);
  const f2 = (await reserve(holder, day(1), '20:00', 9)).body.reservation;
  // También se cancela la reserva de 10 de hoy que no encontró mesa (RF-21): solo cabía en la 8.
  const res2 = await adminClient.patch(`/admin/tables/${await tableId(8)}`, { active: false });
  check(res2.body.cancelled === 2 && (await status(f2.id)) === 'cancelled' && (await status(big.id)) === 'cancelled',
    'sin mesa adecuada, se cancelan', res2.body);
  const notes = (await holder.at(book).get('/me/notifications')).body.notifications;
  check(notes.length === 1, 'RF-32: el titular ve el aviso al abrir la app', notes);
  const avail = (await holder.get(`/availability?date=${day(1)}&party=9`)).body.times;
  check(same(avail, []), 'la mesa desactivada deja de ofrecerse', avail);

  // RF-23: llegada anticipada 30 minutos antes
  const e = await newClient(book);
  const er = (await reserve(e, day(2), '21:00', 2)).body.reservation;
  const e2 = (await reserve(await newClient(book), day(2), '21:00', 2)).body.reservation;
  const s2030 = await staffAt(at(2, '20:30'));
  const early = await s2030.post('/panel/arrive-qr', { qr: er.qr, early: true });
  check(early.status === 200 && early.body.reservation.end_time === '23:00', 'con la mesa libre se registra y sigue terminando a las 23:00', early.body);
  await occupy(await codeOf(await tableOf(e2.id)), at(2, '19:00'));
  const busy = await s2030.post('/panel/arrive-qr', { qr: e2.qr, early: true });
  check(busy.status === 409 && (await status(e2.id)) === 'confirmed', 'con la mesa ocupada, se rechaza', busy.body);
});

// ---------------------------------------------------------------------------
// CP-14 · RF-22, RF-24, RF-25
// ---------------------------------------------------------------------------
test('CP-14', 'Búsqueda, llegada sin QR, no presentadas y fin de la reserva', async () => {
  const book = at(-3, '12:00');
  const c = await newClient(book, '+34 611 222 333');
  const r = (await reserve(c, day(), '21:00', 2)).body.reservation;
  const staff = await staffClient(at(0, '20:55'));
  const found = (await staff.get(`/panel/reservations?date=${day()}&q=611222333`)).body.reservations;
  check(found.length === 1 && found[0].id === r.id, 'la búsqueda por teléfono encuentra la reserva', found);
  const nuria = await db.insert(
    `INSERT INTO reservations (source, guest_name, guest_phone, code, table_id, party_size, start_at, end_at, status,
                               arrival_before_min, arrival_after_min, change_deadline_h, created_at)
     VALUES ('local', 'Núria Ollé', '+34622000111', 'ABCDEFGHJK', ?, 2, ?, ?, 'confirmed', 15, 20, 24, ?)`,
    [await tableId(2), at(0, '13:00'), at(0, '15:00'), book],
  );
  const hit = (await staff.get(`/panel/reservations?date=${day()}&q=${encodeURIComponent('NURIA olle')}`)).body.reservations ?? [];
  check(hit.length === 1 && hit[0].id === nuria, 'la búsqueda no distingue mayúsculas ni acentos («NURIA olle» encuentra «Núria Ollé»)', hit);
  const arr = await staff.post(`/panel/reservations/${r.id}/arrive`, { early: false });
  check(arr.status === 200 && (await status(r.id)) === 'seated', 'la llegada sin QR la pasa a «en curso»', arr.body);

  const x = (await reserve(await newClient(book), day(), '21:00', 4)).body.reservation;
  await staff.at(at(0, '21:20')).get('/panel/version');
  check((await status(x.id)) === 'confirmed', 'a las 21:20 todavía no está «no presentada»');
  await staff.at(at(0, '21:21')).get('/panel/version');
  check((await status(x.id)) === 'no_show', 'a las 21:21 está «no presentada»');
  const walk = await staff.post('/panel/walkin', { party: 4, table_id: await db.value('SELECT table_id FROM reservations WHERE id = ?', [x.id]) });
  check(walk.status === 201, 'y su mesa vuelve a estar disponible', walk.body);

  const later = await staffAt(at(0, '22:40'));
  const done = await later.post(`/panel/reservations/${r.id}/complete`);
  check(done.status === 200 && (await status(r.id)) === 'completed', 'el personal la da por terminada: «completada»', done.body);
  const room = (await later.get('/panel/room')).body.tables;
  const t = room.find((y) => y.code === r.table);
  check(t?.state === 'free', 'la mesa vuelve a estar libre en sala');
});

// ---------------------------------------------------------------------------
// CP-15 · RF-27, RF-28, RF-33, RF-34
// ---------------------------------------------------------------------------
test('CP-15', 'Reserva presencial, cliente sin reserva y estado en sala', async () => {
  let staff = await staffClient(at(0, '12:00'));
  const local = await staff.post('/panel/reservations', { name: 'Joan Pons', phone: '600 333 444', date: day(), time: '21:00', party: 4 });
  check(local.status === 201 && local.body.reservation.status === 'confirmed', 'la reserva presencial queda confirmada', local.body);
  check((await db.value('SELECT user_id FROM reservations WHERE id = ?', [local.body.reservation.id])) === null, 'no pertenece a ninguna cuenta');
  check(local.body.ticket.code.length === 10 && local.body.ticket.qr.startsWith('ML1.'), 'genera ticket con código y QR');

  staff = await staffAt(at(0, '13:05'));
  const walk = await staff.post('/panel/walkin', { party: 3 });
  check(walk.status === 201 && walk.body.reservation.status === 'seated', 'el cliente sin reserva nace «en curso»', walk.body);
  const tableCode = walk.body.reservation.table;
  const room = (await staff.get('/panel/room')).body.tables;
  check(room.find((x) => x.code === tableCode)?.state === 'occupied', 'su mesa aparece ocupada en sala');

  const other = await staffClient(at(0, '13:05'));
  const v1 = (await other.get('/panel/version', { 'X-Background': '1' })).body.version;
  await staff.post(`/panel/reservations/${walk.body.reservation.id}/complete`);
  const v2 = (await other.get('/panel/version', { 'X-Background': '1' })).body.version;
  check(v1 !== v2, 'RF-34: el otro panel detecta el cambio sin recargar');
});

// ---------------------------------------------------------------------------
// CP-16 · RF-29, RF-30, RS-12, RS-13, RP-07
// ---------------------------------------------------------------------------
test('CP-16', 'Ticket, vinculación y códigos de reserva', async () => {
  const now = at(-3, '12:00');
  const staff = await staffClient(now);
  const l1 = (await staff.post('/panel/reservations', { name: 'Joan Pons', phone: '600 333 444', date: day(), time: '21:00', party: 2 })).body;
  const l2 = (await staff.post('/panel/reservations', { name: 'Ana Ruiz', phone: '600 555 666', date: day(), time: '20:00', party: 2 })).body;
  const { ticket } = l1;
  check(same(Object.keys(ticket), ['date', 'time', 'party', 'code', 'qr']), 'RP-07: el ticket solo lleva fecha, hora, comensales, código y QR', Object.keys(ticket));

  const joan = await newClient(now);
  const link = await joan.post('/reservations/link', { code: ticket.code.toLowerCase(), phone: '+34600333444' });
  check(link.status === 200 && link.body.reservation.id === l1.reservation.id, 'con código y teléfono correctos se vincula', link.body);
  check((await joan.get('/reservations')).body.reservations.length === 1, 'aparece entre sus reservas');
  const mod = await joan.patch(`/reservations/${l1.reservation.id}`, { party: 3 });
  check(mod.status === 200, 'y puede modificarla', mod.body);
  const again = await (await newClient(now)).post('/reservations/link', { code: ticket.code, phone: '600333444' });
  check(again.status === 404, 'otra cuenta no puede vincularla de nuevo', again.body);

  const thief = await newClient(now);
  for (let i = 0; i < 5; i++) {
    await thief.post('/reservations/link', { code: l2.ticket.code, phone: `699 000 00${i}` });
  }
  const sixth = await thief.post('/reservations/link', { code: l2.ticket.code, phone: '600 555 666' });
  check(sixth.status === 429, 'RS-13: el sexto intento se rechaza aunque los datos sean correctos', sixth.body);

  const okTicket = await (await staffAt(at(0, '19:50'))).post('/panel/arrive-qr', { qr: l2.ticket.qr });
  check(okTicket.status === 200, 'el QR del ticket de una reserva sin vincular se acepta', okTicket.body);
  const oldTicket = await (await staffAt(at(0, '20:50'))).post('/panel/arrive-qr', { qr: ticket.qr });
  check(oldTicket.status === 409 && oldTicket.code() === 'qr_outdated', 'tras vincularla, el QR del ticket se rechaza', oldTicket.body);

  const codes = Array.from({ length: 10000 }, () => qr.newCode());
  check(new Set(codes).size === 10000, 'RS-12: 10.000 códigos sin repetir');
  check(codes.every((x) => /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/.test(x)), 'todos con 10 caracteres sin 0/O ni 1/I');
  check(!same([...codes].sort(), codes), 'no siguen ningún orden');
});

// ---------------------------------------------------------------------------
// CP-17 · RF-35 a RF-38, RS-04
// ---------------------------------------------------------------------------
test('CP-17', 'Operaciones de administración y roles', async () => {
  const now = at(-3, '12:00');
  const adminClient = await staffClient(now, 'admin');
  const staff = await staffClient(now);
  const customer = await newClient(now);
  const nobody = client(now);

  const ops = [
    ['GET', '/admin/tables', null],
    ['POST', '/admin/tables', { number: 99, zone: 'Barra', min_capacity: 1, max_capacity: 2 }],
    ['PUT', '/admin/settings', { max_future_per_client: 4 }],
    ['POST', '/admin/staff', { name: 'Nuevo Empleado', email: 'nuevo@pruebas.test', password: PASSWORD, role: 'staff' }],
  ];
  for (const [m, p, b] of ops) {
    check((await nobody.req(m, p, b)).status === 401, `sin sesión: ${m} ${p} se rechaza`);
    check((await customer.req(m, p, b)).status === 401, `cliente: ${m} ${p} se rechaza`);
    check((await staff.req(m, p, b)).status === 403, `personal: ${m} ${p} se rechaza`);
    const r = await adminClient.req(m, p, b);
    check([200, 201].includes(r.status), `administrador: ${m} ${p} se acepta`, r.body);
  }
  check((await customer.get('/panel/reservations')).status === 401, 'un cliente no accede a la agenda del personal');

  // RF-37: los cambios de duración solo afectan a las reservas nuevas.
  const c = await newClient(now);
  const before = (await reserve(c, day(), '20:00', 2)).body.reservation;
  await adminClient.put('/admin/settings', { duration_min: 90 });
  const after = (await reserve(c, day(), '13:00', 2)).body.reservation;
  check(before.end_time === '22:00', 'la reserva existente conserva su fin');
  check(after.end_time === '14:30', 'la nueva dura 90 minutos', after);

  // RF-36
  await adminClient.put('/admin/schedule/slots', { slots: [{ weekday: 6, open: '20:00', close: '00:00' }] });
  const times = (await c.get(`/availability?date=${day()}&party=2`)).body.times;
  check(!times.includes('13:00') && times.includes('22:30'), 'las franjas nuevas se aplican', times);

  // RF-38
  const emp = await db.value("SELECT id FROM users WHERE email = 'nuevo@pruebas.test'");
  await adminClient.patch(`/admin/staff/${emp}`, { active: false });
  const login = await client(now).post('/panel/login', { email: 'nuevo@pruebas.test', password: PASSWORD });
  check(login.status === 401, 'una cuenta de personal desactivada no inicia sesión');
});

// ---------------------------------------------------------------------------
// CP-18 · Códigos de mesa, mesas extra, eliminar mesas y «Cerrar local» con PIN
// ---------------------------------------------------------------------------
test('CP-18', 'Códigos de mesa, mesas extra, eliminar y cerrar local', async () => {
  const book = at(-3, '12:00');
  const adminClient = await staffClient(book, 'admin');
  const staff = await staffClient(book);

  const codes = (await adminClient.get('/admin/tables')).body.tables.map((t) => t.code);
  check(same(codes, ['S-1', 'S-2', 'S-3', 'S-4', 'S-5', 'S-6', 'S-7', 'S-8', 'T-1', 'T-2', 'T-3', 'T-4', 'E-1', 'E-2']),
    'las mesas se nombran por zona: S-1…S-8, T-1…T-4 y las extra E-1, E-2', codes);
  check((await adminClient.post('/admin/tables', { number: 1, zone: 'Salón', min_capacity: 1, max_capacity: 2 })).code() === 'duplicate',
    'no se crea otra S-1 (misma inicial de zona y número)');

  // Las extra nunca se ofrecen solas; sí para unir.
  const c = await newClient(book);
  for (let i = 0; i < 4; i++) {
    await reserve(await newClient(book), day(), '21:00', 2); // S-1, S-2, T-1 y S-3 ocupadas a las 21:00
  }
  const all = (await db.all("SELECT code_live FROM dining_tables d JOIN reservations r ON r.table_id = d.id WHERE r.status = 'confirmed'"))
    .map((x) => x.code_live);
  check(!all.includes('E-1') && !all.includes('E-2'), 'una reserva de la app nunca cae en una mesa extra', all);
  const s21 = await staffAt(at(0, '21:00'));
  const wt = Object.fromEntries((await s21.get('/panel/walkin-tables?party=2')).body.tables.map((t) => [t.code, t.fits]));
  check(wt['E-1'] === false, 'para un cliente sin reserva, una extra aparece pero no «basta sola»', wt);
  check((await s21.post('/panel/walkin', { party: 2, table_ids: [await tableId('E-1')] })).code() === 'join_only', 'no se sienta a nadie solo en una extra');
  const w = await s21.post('/panel/walkin', { party: 12, table_ids: [await tableId('E-1'), await tableId('S-8')] });
  check(w.status === 201 && same(w.body.reservation.tables, ['S-8', 'E-1']), 'S-8 con la extra E-1: la principal es S-8', w.body);
  const room = Object.fromEntries((await s21.get('/panel/room')).body.tables.map((t) => [t.code, t]));
  check(room['E-1'].joined_to === 'S-8' && room['S-8'].joined_to === null && room['E-1'].join_only === true,
    'en sala, E-1 figura unida a S-8 (el panel muestra una sola ficha)', [room['E-1'], room['S-8']]);
  const r = (await reserve(c, day(1), '21:00', 2)).body.reservation;
  check((await staff.post(`/panel/reservations/${r.id}/move`, { table_id: await tableId('E-2') })).code() === 'join_only', 'una extra no puede ser la mesa principal');

  // Eliminar: con reservas pendientes no; sin uso se borra; con historial se oculta y su código queda libre.
  check((await adminClient.delete(`/admin/tables/${await tableId(r.table)}`)).code() === 'table_in_use', 'no se elimina una mesa con reservas pendientes');
  const created = await adminClient.post('/admin/tables', { number: 1, zone: 'Barra', min_capacity: 1, max_capacity: 2 });
  check(created.status === 201 && created.body.tables.some((t) => t.code === 'B-1'), 'se añade la mesa B-1 en una zona nueva');
  const del = await adminClient.delete(`/admin/tables/${await tableId('B-1')}`);
  check(del.status === 200 && del.body.deleted === 'B-1' && (await db.value("SELECT COUNT(*) FROM dining_tables WHERE zone = 'Barra'")) === 0,
    'una mesa sin reservas se borra del todo');
  const old = await occupy('T-4', at(-5, '13:00'));
  await db.exec("UPDATE reservations SET status = 'completed' WHERE id = ?", [old]);
  const t4 = await tableId('T-4');
  check((await adminClient.delete(`/admin/tables/${t4}`)).status === 200 && (await db.value('SELECT deleted_at FROM dining_tables WHERE id = ?', [t4])) !== null,
    'una mesa con reservas antiguas queda eliminada pero conserva el historial');
  check(!(await staff.get('/panel/room')).body.tables.some((t) => t.code === 'T-4'), 'y ya no aparece en sala');
  check((await adminClient.post('/admin/tables', { number: 4, zone: 'Terraza', min_capacity: 2, max_capacity: 4 })).status === 201, 'su código T-4 se puede volver a usar');
  check((await staff.delete(`/admin/tables/${await tableId('T-3')}`)).status === 403, 'el personal no elimina mesas');

  // Cerrar local con PIN.
  const s22 = await staffAt(at(0, '22:00'));
  check((await s22.post('/panel/close', { pin: '2580' })).code() === 'no_pin', 'sin PIN fijado, «Cerrar local» no funciona');
  check((await s22.put('/admin/close-pin', { pin: '2580' })).status === 403, 'el personal no fija el PIN');
  check((await adminClient.put('/admin/close-pin', { pin: '12' })).status === 422, 'el PIN tiene de 4 a 8 cifras');
  const set = await adminClient.put('/admin/close-pin', { pin: '2580' });
  check(set.status === 200 && set.body.close_pin_set === true && (await db.value("SELECT value FROM secrets WHERE name = 'close_pin'")) !== '2580',
    'el administrador fija el PIN (se guarda cifrado)');
  check((await s22.post('/panel/close', { pin: '0000' })).code() === 'bad_pin', 'un PIN incorrecto no cierra');
  const seated = await db.value("SELECT COUNT(*) FROM reservations WHERE status = 'seated'");
  const close = await s22.post('/panel/close', { pin: '2580' });
  check(close.status === 200 && close.body.completed === seated && seated > 0, `con el PIN se terminan las ${seated} reservas en curso`, close.body);
  const busyNow = (await s22.get('/panel/room')).body.tables.filter((t) => t.state === 'occupied');
  check(busyNow.length === 0, 'y todas las mesas quedan libres');
  check((await status(r.id)) === 'confirmed', 'las reservas que aún no han llegado no se tocan');
  for (let i = 0; i < 4; i++) {
    await s22.post('/panel/close', { pin: '9999' });
  }
  check((await s22.post('/panel/close', { pin: '2580' })).code() === 'locked', 'tras 5 PIN incorrectos se bloquea 15 minutos');
});

// ---------------------------------------------------------------------------
// CP-19 · Cambiar, unir y separar mesas (panel del personal)
// ---------------------------------------------------------------------------
test('CP-19', 'Cambiar, unir y separar mesas', async () => {
  const book = at(-3, '12:00');

  // Grupo de 12 sin reserva en tres mesas de 4 (3, 4 y 5).
  const s13 = await staffAt(at(0, '13:00'));
  const w = await s13.post('/panel/walkin', { party: 12, table_ids: await tableIds([3, 4, 5]) });
  const r = w.body.reservation ?? {};
  check(w.status === 201 && same(r.tables, ['S-3', 'S-4', 'S-5']) && r.max_capacity === 12,
    'un grupo de 12 se sienta en tres mesas de 4 unidas', w.body);
  const room = (await s13.get('/panel/room')).body.tables;
  const occ = room.filter((t) => ['S-3', 'S-4', 'S-5'].includes(t.code) && t.state === 'occupied' && t.current?.id === r.id);
  check(occ.length === 3, 'las tres mesas aparecen ocupadas por la misma reserva');
  const short = await s13.post('/panel/walkin', { party: 12, table_ids: await tableIds([10, 11]) });
  check(short.status === 409 && short.code() === 'over_capacity', 'mesas que no suman plazas suficientes se rechazan', short.body);

  // Las mesas unidas no se ofrecen a nadie mientras dura la reserva.
  const c = await newClient(at(0, '13:00'));
  const avail = (await c.get(`/availability?date=${day()}&party=4`)).body.times;
  let taken = 0;
  for (let i = 0; i < 6; i++) {
    const res = await reserve(await newClient(at(0, '13:00')), day(), '14:00', 4);
    if (res.status === 201) {
      taken++;
      check(!['S-3', 'S-4', 'S-5'].includes(res.body.reservation.table), `la reserva ${i} no cae en una mesa unida`, res.body.reservation.table);
    }
  }
  check(taken === 4 && avail.includes('14:00'), 'a las 14:00 solo quedan las 4 mesas para cuatro que no están unidas', taken);

  // Más comensales: hasta la capacidad de todas sus mesas; uniendo otra, más.
  const over = await s13.post(`/panel/reservations/${r.id}/party`, { party: 13 });
  check(over.status === 409 && over.code() === 'over_capacity', 'pasar a 13 con 12 plazas se rechaza', over.body);
  const free = (await s13.get(`/panel/reservations/${r.id}/free-tables`)).body.tables ?? [];
  const freeCodes = free.map((t) => t.code);
  check(freeCodes.includes('T-1') && !freeCodes.includes('S-3'), 'las mesas libres para unir no incluyen las suyas', freeCodes);
  const t9 = await tableId(9);
  const join = await s13.post(`/panel/reservations/${r.id}/join`, { table_ids: [t9] });
  check(join.status === 200 && same(join.body.reservation.tables, ['S-3', 'S-4', 'S-5', 'T-1']), 'se une la mesa T-1', join.body);
  check((await s13.post(`/panel/reservations/${r.id}/party`, { party: 13 })).status === 200, 'con la mesa 9 ya caben 13');
  const sep = await s13.post(`/panel/reservations/${r.id}/separate`, { table_id: t9 });
  check(sep.status === 409 && sep.code() === 'over_capacity', 'no se separa una mesa si sin ella no caben todos', sep.body);
  const busyJoin = await s13.post(`/panel/reservations/${r.id}/join`, { table_ids: [t9] });
  check(busyJoin.status === 409, 'una mesa que ya es suya no se vuelve a unir', busyJoin.body);

  // Cambiar de mesa una reserva confirmada.
  const a = await newClient(book);
  const ra = (await reserve(a, day(), '21:00', 2)).body.reservation;
  const rb = (await reserve(await newClient(book), day(), '21:00', 2)).body.reservation;
  const s20 = await staffAt(at(0, '20:00'));
  const mv = await s20.post(`/panel/reservations/${ra.id}/move`, { table_id: t9 });
  check(mv.status === 200 && mv.body.reservation.table === 'T-1', 'una reserva confirmada se mueve a otra mesa libre', mv.body);
  const clash = await s20.post(`/panel/reservations/${ra.id}/move`, { table_id: await tableId(rb.table) });
  check(clash.status === 409 && clash.code() === 'table_busy', 'no se mueve a una mesa reservada a esa hora', clash.body);
  const big = (await reserve(await newClient(book), day(), '21:30', 6)).body.reservation;
  const small = await s20.post(`/panel/reservations/${big.id}/move`, { table_id: await tableId(1) });
  check(small.status === 409 && small.code() === 'over_capacity', 'no se mueve un grupo de 6 a una mesa de 2', small.body);
  check((await db.value('SELECT qr_version FROM reservations WHERE id = ?', [ra.id])) === 1, 'mover de mesa no cambia el QR del cliente');

  // Unir mesas a una reserva confirmada de 10 (mesa 8) para un grupo que llegará con 12.
  const g = (await reserve(await newClient(book), day(), '21:00', 10)).body.reservation;
  const jg = await s20.post(`/panel/reservations/${g.id}/join`, { table_ids: [await tableId(1)] });
  check(jg.status === 200 && jg.body.reservation.max_capacity === 12, 'a la reserva de 10 se le une una mesa de 2', jg.body);
  const deact = await (await staffClient(book, 'admin')).patch(`/admin/tables/${await tableId(1)}`, { active: false });
  check(deact.status === 409 && deact.code() === 'table_joined', 'una mesa unida a una reserva no se puede desactivar', deact.body);
  const mod = await newClient(book);
  const gr = (await reserve(mod, day(1), '21:00', 2)).body.reservation;
  await (await staffAt(book)).post(`/panel/reservations/${gr.id}/join`, { table_ids: [await tableId(2)] });
  const chg = await mod.patch(`/reservations/${gr.id}`, { time: '20:00' });
  check(chg.status === 409 && chg.code() === 'joined_tables', 'el cliente no cambia la hora de una reserva con mesas unidas', chg.body);

  // Llegada con una mesa unida todavía ocupada: aviso al personal, sin recolocar.
  await occupy(1, at(0, '19:00'));
  const s2050 = await staffAt(at(0, '20:50'));
  const arr = await s2050.post('/panel/arrive-qr', { qr: g.qr });
  check(arr.status === 409 && arr.code() === 'no_table' && arr.body.error?.alert === true,
    'si una mesa unida sigue ocupada, el panel recibe el aviso', arr.body);
  await db.exec("UPDATE reservations SET status = 'completed' WHERE source = 'walkin' AND table_id = ?", [await tableId(1)]);
  const ok = await s2050.post('/panel/arrive-qr', { qr: g.qr });
  check(ok.status === 200 && same(ok.body.reservation.tables, ['S-8', 'S-1']), 'libre la mesa unida, la llegada se registra en las dos', ok.body);
  const done = await s2050.post(`/panel/reservations/${g.id}/complete`);
  const after = (await s2050.get('/panel/room')).body.tables;
  const stillBusy = after.filter((t) => ['S-8', 'S-1'].includes(t.code) && t.state !== 'free');
  check(done.status === 200 && stillBusy.length === 0, 'al terminar, todas sus mesas quedan libres');
});

// ---------------------------------------------------------------------------
// CP-20 · Plano de la sala y lista de clientes (administración)
// ---------------------------------------------------------------------------
test('CP-20', 'Plano de la sala y lista de clientes', async () => {
  const now = at(-3, '12:00');
  const adminClient = await staffClient(now, 'admin');
  const staff = await staffClient(now);
  const t1 = await tableId(1);

  const layout = {
    tables: [
      { id: t1, pos_x: 120, pos_y: 80, shape: 'round' },
      { id: await tableId(2), pos_x: 900, pos_y: 520, shape: 'rect' },
    ],
  };
  check((await staff.put('/admin/tables/layout', layout)).status === 403, 'el personal no puede cambiar el plano');
  const ok = await adminClient.put('/admin/tables/layout', layout);
  check(ok.status === 200, 'el administrador guarda el plano', ok.body);
  const roomByCode = async () => Object.fromEntries((await staff.get('/panel/room')).body.tables.map((t) => [t.code, t]));
  let room = await roomByCode();
  check(room['S-1'].pos_x === 120 && room['S-1'].pos_y === 80 && room['S-1'].shape === 'round'
    && room['S-2'].shape === 'rect', 'la sala devuelve las posiciones y formas guardadas', [room['S-1'], room['S-2']]);
  check(room['S-3'].pos_x === 330 && room['S-3'].pos_y === 110, 'las mesas de los datos iniciales ya tienen su sitio en el plano', room['S-3']);
  await db.exec('UPDATE dining_tables SET pos_x = NULL, pos_y = NULL WHERE id = ?', [await tableId(3)]);
  room = await roomByCode();
  check(room['S-3'].pos_x === null, 'una mesa sin posición se devuelve sin ella (el panel la coloca)');
  const bad = {
    'fuera del plano': { id: t1, pos_x: 1001, pos_y: 10, shape: 'rect' },
    'forma inexistente': { id: t1, pos_x: 10, pos_y: 10, shape: 'star' },
    'mesa inexistente': { id: 999999, pos_x: 10, pos_y: 10, shape: 'rect' },
  };
  for (const [what, table] of Object.entries(bad)) {
    const r = await adminClient.put('/admin/tables/layout', { tables: [table] });
    check([404, 422].includes(r.status), `rechaza una mesa ${what}`, r.body);
  }
  check((await db.value('SELECT pos_x FROM dining_tables WHERE id = ?', [t1])) === 120, 'un plano rechazado no cambia nada');

  const ana = await newClient(now, '+34 622 000 111');
  await reserve(ana, day(), '20:00', 2);
  await reserve(ana, day(), '13:00', 2);
  await newClient(now);
  check((await staff.get('/admin/clients')).status === 403, 'el personal no ve la lista de clientes');
  check((await client(now).get('/admin/clients')).status === 401, 'sin sesión tampoco');
  const all = (await adminClient.get('/admin/clients')).body.clients ?? [];
  check(all.length === 2, 'la lista tiene a los dos clientes', all.length);
  const found = (await adminClient.get('/admin/clients?q=622000111')).body.clients ?? [];
  check(found.length === 1 && found[0].email === ana.email && found[0].reservations === 2 && found[0].upcoming === 2,
    'la búsqueda por teléfono encuentra al cliente con sus 2 reservas pendientes', found);
  check(!('password_hash' in (found[0] ?? {})), 'la lista no incluye el hash de la contraseña');
});

// ---------------------------------------------------------------------------
// CP-21 · RF-40 Recuperar la contraseña
// ---------------------------------------------------------------------------
test('CP-21', 'Recuperar la contraseña', async () => {
  const now = at(-3, '12:00');
  const c = await newClient(now);
  const anon = client(now);
  await staffClient(now);
  const staffEmail = await db.value("SELECT email FROM users WHERE role = 'staff' LIMIT 1");

  const a = await anon.post('/auth/forgot', { email: 'nadie@pruebas.test' });
  const b = await anon.post('/auth/forgot', { email: c.email });
  check(a.status === 200 && b.status === 200 && same(a.body, b.body), 'la respuesta es la misma exista o no la cuenta', [a.body, b.body]);
  check((await mailTo('nadie@pruebas.test', 'Restablecer')) === null, 'a un correo sin cuenta no se envía nada');
  await anon.post('/auth/forgot', { email: staffEmail });
  check((await mailTo(staffEmail, 'Restablecer')) === null, 'las cuentas del personal no se recuperan desde la app');
  const body = String(await mailTo(c.email, 'Restablecer'));
  const m = /\/restablecer\?token=([0-9a-f]{64})/.exec(body);
  check(m !== null, 'el correo lleva el enlace con el token', body);
  const token = m?.[1] ?? '';
  const sha = createHash('sha256').update(token).digest('hex');
  check((await db.value('SELECT COUNT(*) FROM password_resets WHERE token_hash = ?', [token])) === 0
    && (await db.value('SELECT COUNT(*) FROM password_resets WHERE token_hash = ?', [sha])) === 1,
  'la base de datos guarda el hash del token, no el token');

  check((await anon.post('/auth/reset', { token: 'a'.repeat(64), password: 'Otra-Clave-Segura-1' })).code() === 'reset_invalid', 'un token inventado no sirve');
  check((await anon.post('/auth/reset', { token, password: 'corta' })).status === 422, 'la nueva contraseña cumple la política');
  const ok = await anon.post('/auth/reset', { token, password: 'Otra-Clave-Segura-1' });
  check(ok.status === 200, 'con el enlace se cambia la contraseña', ok.body);
  check((await c.get('/me')).status === 401, 'la sesión abierta se cierra al cambiarla');
  check((await client(now).post('/auth/login', { email: c.email, password: PASSWORD })).status === 401, 'la contraseña anterior ya no vale');
  check((await client(now).post('/auth/login', { email: c.email, password: 'Otra-Clave-Segura-1' })).status === 200, 'la nueva sí');
  check((await anon.post('/auth/reset', { token, password: 'Tercera-Clave-Segura-1' })).code() === 'reset_invalid', 'el enlace solo funciona una vez');

  // Caduca a los 30 minutos y un enlace nuevo anula el anterior.
  const tokenOf = async () => /token=([0-9a-f]{64})/.exec(String(await mailTo(c.email, 'Restablecer')))?.[1] ?? '';
  await anon.post('/auth/forgot', { email: c.email });
  const m1 = await tokenOf();
  await anon.post('/auth/forgot', { email: c.email });
  const m2 = await tokenOf();
  check((await anon.post('/auth/reset', { token: m1, password: 'Cuarta-Clave-Segura-1' })).code() === 'reset_invalid', 'pedir otro enlace anula el anterior');
  check((await client(at(-3, '12:31')).post('/auth/reset', { token: m2, password: 'Cuarta-Clave-Segura-1' })).code() === 'reset_invalid', 'a los 30 minutos el enlace ha caducado');

  // Como mucho 3 enlaces por hora (ya van 3).
  const before = await db.value('SELECT COUNT(*) FROM password_resets');
  check((await anon.post('/auth/forgot', { email: c.email })).status === 200 && (await db.value('SELECT COUNT(*) FROM password_resets')) === before,
    'el cuarto enlace en una hora no se envía (y la respuesta no lo delata)');
});

// ---------------------------------------------------------------------------
// CP-22 · RF-43 Solicitudes de grupos grandes
// ---------------------------------------------------------------------------
test('CP-22', 'Solicitudes de grupos grandes', async () => {
  const book = at(-3, '12:00');
  const c = await newClient(book);
  const staff = await staffClient(book);

  const cfg = (await c.get('/config')).body;
  check(cfg.max_group_party === 40 && cfg.deposit_per_person === 5, 'la app sabe el máximo de un grupo (40) y la señal por persona (5 €)', cfg);
  check((await c.get(`/group-requests/times?date=${day()}`)).body.times.includes('21:00'), 'se ofrecen las horas de inicio del día');

  check((await client(book).post('/group-requests', { date: day(), time: '21:00', party: 14 })).status === 401, 'sin sesión no se puede pedir');
  check((await c.post('/group-requests', { date: day(), time: '21:00', party: 10 })).status === 422, '10 comensales no es un grupo: se reserva normal');
  check((await c.post('/group-requests', { date: day(), time: '21:00', party: 41 })).status === 422, 'más de 40 se rechaza');
  check((await c.post('/group-requests', { date: day(), time: '21:15', party: 14 })).code() === 'invalid_time', 'una hora no permitida se rechaza');
  const r = await c.post('/group-requests', { date: day(), time: '21:00', party: 14, note: 'Cumpleaños', consent: true });
  check(r.status === 201 && r.body.requests[0].status === 'pending' && r.body.requests[0].note === 'Cumpleaños', 'el cliente envía una solicitud de 14 a las 21:00', r.body);
  const gid = r.body.requests[0].id;

  check((await c.get('/panel/group-requests')).status === 401, 'un cliente no ve las solicitudes del panel');
  const list = (await staff.get('/panel/group-requests')).body.requests;
  check(list.length === 1 && list[0].party === 14 && list[0].email === c.email, 'el personal ve la solicitud con los datos del cliente', list);
  const tables = (await staff.get(`/panel/group-requests/${gid}/tables`)).body.tables;
  check(tables.length === 14 && tables.every((t) => t.free === true), 'y las 14 mesas (12 y 2 extra), libres a esa hora');

  // Otra reserva a esa hora ocupa la mesa 1.
  const x = (await reserve(await newClient(book), day(), '21:00', 2)).body.reservation;
  const free = Object.fromEntries((await staff.get(`/panel/group-requests/${gid}/tables`)).body.tables.map((t) => [t.code, t.free]));
  check(x.table === 'S-1' && free['S-1'] === false, 'la mesa 1 aparece ocupada a esa hora');
  check((await staff.post(`/panel/group-requests/${gid}/accept`, { table_ids: [await tableId(8)] })).code() === 'over_capacity', 'con la mesa 8 sola (10 plazas) no caben 14');
  check((await staff.post(`/panel/group-requests/${gid}/accept`, { table_ids: await tableIds([8, 1, 2]) })).code() === 'table_busy', 'una mesa ocupada a esa hora no se puede usar');
  const acc = await staff.post(`/panel/group-requests/${gid}/accept`, { table_ids: await tableIds([8, 6]), reply: 'Os esperamos' });
  const res = acc.body.reservation ?? {};
  check(acc.status === 200 && res.status === 'pending_payment' && same(res.tables, ['S-8', 'S-6']) && res.deposit?.cents === 7000,
    'aceptada con las mesas 8 y 6: pendiente de pago, señal 14 × 5 € = 70 €', acc.body);
  check((await staff.post(`/panel/group-requests/${gid}/accept`, { table_ids: [await tableId(7)] })).code() === 'not_pending', 'no se acepta dos veces');
  check((await reserve(await newClient(book), day(), '21:00', 10)).code() === 'conflict', 'mientras espera el pago, las mesas del grupo no se pueden reservar');
  const mine = (await c.get('/group-requests')).body.requests[0];
  check(mine.status === 'accepted' && mine.reservation_id === res.id && mine.reply === 'Os esperamos', 'el cliente ve la solicitud aceptada con el mensaje', mine);
  check(String(await mailTo(c.email, 'Solicitud de grupo aceptada')).includes('70 €'), 'y recibe un correo con el importe de la señal');
  check((await c.get('/me/notifications')).body.notifications.length === 1, 'y un aviso en la app');

  // Rechazo con motivo.
  const pendingId = (requests) => requests.find((g) => g.status === 'pending').id;
  const g2 = pendingId((await c.post('/group-requests', { date: day(1), time: '13:00', party: 20 })).body.requests);
  check((await staff.post(`/panel/group-requests/${g2}/reject`, {})).status === 422, 'para rechazar hay que dar un motivo');
  check((await staff.post(`/panel/group-requests/${g2}/reject`, { reply: 'Ese día no tenemos sitio' })).status === 200, 'el personal la rechaza con un motivo');
  check(String(await mailTo(c.email, 'no aceptada')).includes('Ese día no tenemos sitio'), 'el cliente recibe el motivo por correo');

  // El cliente cancela la suya; la de otro «no existe».
  const other = await newClient(book);
  const g3 = pendingId((await c.post('/group-requests', { date: day(2), time: '13:00', party: 12 })).body.requests);
  check((await other.post(`/group-requests/${g3}/cancel`)).status === 404, 'otro cliente no puede cancelarla');
  check((await c.post(`/group-requests/${g3}/cancel`)).status === 200 && (await db.value('SELECT status FROM group_requests WHERE id = ?', [g3])) === 'cancelled', 'el titular la cancela');

  // Como mucho 3 pendientes por cliente.
  for (const t of ['13:00', '13:30', '14:00']) {
    await c.post('/group-requests', { date: day(3), time: t, party: 12 });
  }
  check((await c.post('/group-requests', { date: day(3), time: '20:00', party: 12 })).code() === 'limit', 'la cuarta solicitud pendiente se rechaza');

  // Sin señal (0 €), el grupo aceptado queda confirmado.
  await setSetting('deposit_per_person', 0);
  const free4 = await acceptedGroup(other, staff, day(4), '21:00', 12, [8, 1]);
  check(free4.status === 'confirmed' && free4.deposit === null, 'con señal 0 € la reserva del grupo nace confirmada', free4);
  check((await staff.put('/admin/settings', { max_group_party: 10 })).status === 403, 'solo el administrador cambia los parámetros');
  check((await (await staffClient(book, 'admin')).put('/admin/settings', { max_group_party: 10 })).status === 422, 'el máximo de un grupo debe superar el de una reserva normal');
});

// ---------------------------------------------------------------------------
// CP-23 · RF-44 Señal con pago de prueba (pasarela simulada)
// ---------------------------------------------------------------------------
test('CP-23', 'Señal de los grupos con pago de prueba', async () => {
  const book = at(-3, '12:00');
  const c = await newClient(book);
  const staff = await staffClient(book);
  const g = await acceptedGroup(c, staff, day(), '21:00', 12, [8, 1]);
  const { id } = g;
  const paymentStatus = (rid) => db.value('SELECT status FROM payments WHERE reservation_id = ? ORDER BY id DESC LIMIT 1', [rid]);

  let view = (await c.get(`/reservations/${id}`)).body.reservation;
  check(view.status === 'pending_payment' && view.payable && view.qr === null && view.deposit.amount === '60 €'
    && view.deposit.due === at(-3, '12:15').slice(0, 16), 'el titular ve 60 € a pagar antes de las 12:15 y aún no tiene QR', view);
  check((await staff.post(`/panel/reservations/${id}/arrive`, {})).code() === 'pending_payment', 'sin pagar no se puede registrar la llegada');
  check((await (await newClient(book)).post(`/reservations/${id}/pay`)).status === 404, 'otro cliente no puede pagarla');

  let to = await payDeposit(c.at(at(-3, '12:05')), id);
  check(to.endsWith(`/reservas/${id}?pago=ok`), 'tras aprobar el pago vuelve a la reserva con «pago=ok»', to);
  view = (await c.get(`/reservations/${id}`)).body.reservation;
  check(view.status === 'confirmed' && view.qr !== null && view.deposit.payment === 'captured', 'la reserva queda confirmada, con QR y la señal cobrada', view);
  check(String(await mailTo(c.email, 'Reserva confirmada')).includes('señal de 60 €'), 'el correo de confirmación menciona la señal');
  const order = await db.value('SELECT order_id FROM payments WHERE reservation_id = ?', [id]);
  const [, again] = await redirectOf(c, `/payments/return?token=${order}`);
  check(again.endsWith('pago=ok') && (await db.value("SELECT COUNT(*) FROM payments WHERE status = 'captured'")) === 1, 'volver otra vez de PayPal no cobra dos veces');
  check((await c.post(`/reservations/${id}/pay`)).code() === 'not_payable', 'una reserva pagada no se vuelve a pagar');
  check((await c.patch(`/reservations/${id}`, { time: '21:30' })).code() === 'joined_tables', 'la hora de un grupo no se cambia desde la app');

  // Cancelación del titular dentro de plazo: se devuelve la señal.
  check((await c.post(`/reservations/${id}/cancel`)).status === 200, 'el titular cancela dentro de plazo');
  check((await eventually(async () => (await paymentStatus(id)) === 'refunded')), 'y la señal queda devuelta');
  check(String(await mailTo(c.email, 'Reserva cancelada')).includes('devolvemos la señal de 60 €'), 'el correo lo indica');

  // Sin pagar a tiempo: se libera y no se cobra un pago aprobado tarde.
  const c2 = await newClient(book);
  const late = await acceptedGroup(c2, await staffAt(book), day(1), '21:00', 12, [8, 1]);
  to = await payDeposit(c2, late.id, at(-3, '12:20'));
  check(to.endsWith('pago=caducado'), 'un pago aprobado después del plazo vuelve con «pago=caducado»', to);
  check((await paymentStatus(late.id)) === 'failed'
    && (await db.value('SELECT capture_id FROM payments WHERE reservation_id = ?', [late.id])) === null, 'y no se cobra');
  await (await staffAt(at(-3, '12:20'))).get('/panel/version');
  check((await status(late.id)) === 'cancelled' && (await db.value('SELECT cancelled_by FROM reservations WHERE id = ?', [late.id])) === 'system',
    'el sistema cancela la reserva que no se pagó a tiempo');
  check((await db.value('SELECT status FROM group_requests WHERE reservation_id = ?', [late.id])) === 'expired', 'la solicitud queda «caducada»');
  check((await mailTo(c2.email, 'Reserva sin confirmar')) !== null
    && (await c2.at(at(-3, '12:21')).get('/me/notifications')).body.notifications.length === 2,
  'el titular recibe correo y aviso (una sola vez)');
  await (await staffAt(at(-3, '12:22'))).get('/panel/version');
  check((await db.value("SELECT COUNT(*) FROM email_outbox WHERE subject LIKE '%sin confirmar%'")) === 1 || config('mail.enabled') === true, 'el aviso no se repite');
  check((await reserve(await newClient(at(-3, '12:22')), day(1), '21:00', 10)).status === 201, 'y la mesa 8 vuelve a poder reservarse');

  // El restaurante cancela sin devolver (el cliente avisó fuera de plazo).
  const c3 = await newClient(book);
  const s3 = await staffAt(book);
  const paid = await acceptedGroup(c3, s3, day(2), '21:00', 12, [8, 1]);
  await payDeposit(c3, paid.id);
  const x = await s3.post(`/panel/reservations/${paid.id}/cancel`, { refund: false });
  check(x.status === 200 && x.body.reservation.deposit.payment === 'captured', 'el personal cancela sin devolver la señal', x.body);
  check(String(await mailTo(c3.email, 'cancelada por el restaurante')).includes('no se devuelve'), 'el correo dice que la señal no se devuelve');
  const paid2 = await acceptedGroup(c3, s3, day(3), '21:00', 12, [8, 1]);
  await payDeposit(c3, paid2.id);
  await s3.post(`/panel/reservations/${paid2.id}/cancel`);
  check((await eventually(async () => (await paymentStatus(paid2.id)) === 'refunded')), 'si el restaurante cancela sin más, se devuelve');

  // Desde la app: PayPal le devuelve a la app (front.payment_app), no a la web.
  const c4 = await newClient(book);
  const fromApp = await acceptedGroup(c4, await staffAt(book), day(4), '21:00', 12, [8, 1]);
  check((await c4.post(`/reservations/${fromApp.id}/pay`, { from: 'movil' })).status === 422, 'el origen del pago solo puede ser «web» o «app»');
  to = await payDeposit(c4, fromApp.id, null, 'app');
  check(to === `mesalista://reserva/${fromApp.id}?pago=ok`, 'pagando desde la app, se vuelve a la app con «pago=ok»', to);
});

// ---------------------------------------------------------------------------
// CP-24 · RF-45 Bloqueo de mesas y franjas
// ---------------------------------------------------------------------------
test('CP-24', 'Bloqueo de mesas y franjas', async () => {
  const book = at(-3, '12:00');
  const staff = await staffClient(book);
  const c = await newClient(book);
  const t8 = await tableId(8);

  // La única mesa de 10 (la 8) bloqueada por la noche.
  const h = await staff.post('/panel/holds', { date: day(), from: '20:00', to: '00:00', reason: 'Evento privado', table_ids: [t8] });
  check(h.status === 201 && h.body.holds.length === 1 && h.body.holds[0].table === 'S-8', 'el personal bloquea la mesa S-8 por la noche', h.body);
  const times = (await c.get(`/availability?date=${day()}&party=10`)).body.times;
  check(!times.some((t) => t >= '20:00') && times.includes('13:00'), 'para 10 no se ofrece ninguna cena, pero sí la comida', times);
  const r = await reserve(c, day(), '21:00', 10);
  check(r.status === 409 && r.code() === 'conflict', 'una reserva de 10 a las 21:00 se rechaza', r.body);
  check((await reserve(c, day(), '13:00', 10)).status === 201, 'a mediodía la mesa 8 sí se puede reservar');

  // Franja completa: todas las mesas.
  const all = await staff.post('/panel/holds', { date: day(1), from: '13:00', to: '16:00', reason: 'Cerrado a mediodía', all: true });
  check(all.status === 201, 'se bloquea la comida del día siguiente para todas las mesas', all.body);
  const t2 = (await c.get(`/availability?date=${day(1)}&party=2`)).body.times;
  check(!t2.some((t) => t < '17:00') && t2.includes('20:00'), 'ese día no se ofrece ninguna hora de comida y sí las cenas', t2);

  // Con una reserva dentro, no se bloquea.
  const x = (await reserve(await newClient(book), day(2), '21:00', 2)).body.reservation;
  const clash = await staff.post('/panel/holds', { date: day(2), from: '20:00', to: '23:00', reason: 'Avería', table_ids: [await tableId(x.table)] });
  check(clash.status === 409 && clash.code() === 'reservations_in_hold' && (clash.body.error?.reservations ?? []).includes(x.id),
    'no se bloquea una mesa con una reserva en ese horario, y se dice cuál', clash.body);
  check((await db.value('SELECT COUNT(*) FROM table_holds WHERE starts_at >= ?', [day(2)])) === 0, 'el bloqueo rechazado no se guarda');

  // Validaciones y permisos.
  check((await staff.post('/panel/holds', { date: day(), from: '22:00', to: '21:00', reason: 'x', all: true })).status === 422, 'el fin anterior al inicio se rechaza');
  check((await staff.post('/panel/holds', { date: day(-10), from: '13:00', to: '16:00', reason: 'Pasado', all: true })).status === 422, 'un horario ya pasado se rechaza');
  check((await c.post('/panel/holds', { date: day(), from: '13:00', to: '16:00', reason: 'Cliente', all: true })).status === 401, 'un cliente no puede bloquear mesas');

  // En sala: una mesa bloqueada ahora aparece «Bloqueada» y no sirve para un cliente sin reserva.
  const s = await staffAt(at(0, '12:55'));
  await s.post('/panel/holds', { date: day(), from: '13:00', to: '15:00', reason: 'Avería', table_ids: [await tableId(1)] });
  const s13 = await staffAt(at(0, '13:10'));
  const room = Object.fromEntries((await s13.get('/panel/room')).body.tables.map((t) => [t.code, t]));
  check(room['S-1'].state === 'blocked' && room['S-1'].hold?.reason === 'Avería', 'la mesa S-1 aparece bloqueada en sala', room['S-1']);
  const wt = (await s13.get('/panel/walkin-tables?party=2')).body.tables.map((t) => t.code);
  check(!wt.includes('S-1'), 'y no se ofrece para sentar a un cliente sin reserva', wt);

  // Al quitar el bloqueo, la mesa vuelve a ofrecerse.
  const id8 = await db.value('SELECT id FROM table_holds WHERE table_id = ?', [t8]);
  check((await staff.delete(`/panel/holds/${id8}`)).status === 200, 'se quita el bloqueo de la mesa 8');
  check((await reserve(await newClient(book), day(), '21:00', 10)).status === 201, 'y la mesa 8 vuelve a poder reservarse por la noche');
});

// ---------------------------------------------------------------------------
// CP-25 · RF-46 Estadísticas (coinciden con un recuento manual)
// ---------------------------------------------------------------------------
test('CP-25', 'Estadísticas de un periodo', async () => {
  const x = clock.ymd(clock.addDays(D, -63)); // un sábado pasado
  const t3 = await tableId(3);
  const mk = async (time, party, st, source) => {
    const start = `${x} ${time}:00`;
    await db.insert(
      `INSERT INTO reservations (source, guest_name, table_id, party_size, start_at, end_at, status,
                                 arrival_before_min, arrival_after_min, change_deadline_h, created_at)
       VALUES (?, 'Prueba', ?, ?, ?, ?, ?, 15, 20, 24, ?)`,
      [source, t3, party, start, plusMinutes(start, 120), st, start],
    );
  };
  await mk('21:00', 4, 'completed', 'app');
  await mk('13:00', 2, 'completed', 'local');
  await mk('21:00', 3, 'no_show', 'app');
  await mk('20:00', 5, 'cancelled', 'app');
  await mk('22:00', 2, 'completed', 'walkin');

  const adminClient = await staffClient(at(-3, '12:00'), 'admin');
  check((await (await staffClient(at(-3, '12:00'))).get(`/admin/stats?from=${x}&to=${x}`)).status === 403, 'el personal no ve las estadísticas');
  const s = (await adminClient.get(`/admin/stats?from=${x}&to=${x}`)).body;
  check(s.reservations === 4, 'reservas sin canceladas: 4', s.reservations);
  check(s.people === 8, 'comensales sentados: 4 + 2 + 2 = 8', s.people);
  check(s.no_show_rate === 33.3, 'no presentadas: 1 de 3 reservas cuya hora llegó = 33,3 %', s.no_show_rate);
  check(s.cancel_rate === 25, 'canceladas: 1 de 4 reservas = 25 %', s.cancel_rate);
  check(same(s.by_source, { app: 2, local: 1, walkin: 1 }), 'por origen: app 2, local 1, sin reserva 1', s.by_source);
  const hours = Object.fromEntries(s.by_hour.map((h) => [h.time, h.reservations]));
  check(same(hours, { '13:00': 1, '21:00': 2, '22:00': 1 }), 'por hora: 13:00 → 1, 21:00 → 2, 22:00 → 1', hours);
  const sat = s.by_service.filter((o) => o.weekday === 6);
  // 56 plazas activas; cena 20–24 h: 2 rotaciones; comida 13–16 h: 1.
  check(sat[0]?.slot === '13:00–16:00' && sat[0].people === 2 && sat[0].capacity === 56 && sat[0].occupancy === 3.6,
    'comida del sábado: 2 comensales de 56 plazas = 3,6 %', sat[0]);
  check(sat[1]?.slot === '20:00–00:00' && sat[1].people === 6 && sat[1].capacity === 112 && sat[1].occupancy === 5.4,
    'cena del sábado: 6 comensales de 56 × 2 rotaciones = 5,4 %', sat[1]);
  check((await adminClient.get(`/admin/stats?from=${x}&to=${clock.ymd(clock.addDays(D, -70))}`)).status === 422, 'un periodo al revés se rechaza');
});

// ---------------------------------------------------------------------------
// CP-26 · RF-47 Exportar las reservas de un día a CSV
// ---------------------------------------------------------------------------
test('CP-26', 'Exportar a CSV', async () => {
  const book = at(-3, '12:00');
  const c = await newClient(book, '+34 633 444 555');
  await reserve(c, day(), '20:00', 2, { note: '=HYPERLINK("http://x.test","clic")', consent: true, menu_options: [await optionId('Vegano')] });
  await reserve(await newClient(book), day(), '13:00', 4);
  await reserve(await newClient(book), day(1), '13:00', 4);
  const staff = await staffClient(book);

  const res = await staff.raw('GET', `/panel/reservations.csv?date=${day()}`);
  const csv = await res.text();
  const type = res.headers.get('content-type') ?? '';
  check(res.status === 200 && type.startsWith('text/csv'), 'el personal descarga el CSV', type);
  check(csv.startsWith('﻿"Fecha";"Hora"'), 'empieza con BOM y la cabecera separada por «;»', csv.slice(0, 40));
  const lines = csv.split('\r\n').filter(Boolean);
  check(lines.length === 3, 'una línea de cabecera y una por cada reserva del día (2)', lines.length);
  check(csv.includes('"\'=HYPERLINK(""http://x.test"",""clic"")"'), 'la fórmula de la nota se escapa con un apóstrofo');
  check(csv.includes('"+34633444555"') && csv.includes('"Vegano"'), 'el teléfono y las opciones salen tal cual');
  check((await c.get(`/panel/reservations.csv?date=${day()}`)).status === 401, 'un cliente no puede descargarlo');
});

// ---------------------------------------------------------------------------
// CP-27 · RS-01 · la API no responde por HTTP
// ---------------------------------------------------------------------------
test('CP-27', 'HTTPS obligatorio', async () => {
  if (!base.startsWith('https://')) {
    check(true, 'omitida: el servidor de desarrollo no usa HTTPS');
    return;
  }
  const res = await fetch(`http://${base.slice(8)}/api/v1/config`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  check(res.status === 301 || res.status === 308, 'una petición por HTTP solo recibe una redirección a HTTPS', res.status);
});

// ---------------------------------------------------------------------------
// CP-28 · RS-02
// ---------------------------------------------------------------------------
test('CP-28', 'Hash de contraseñas', async () => {
  await newClient(at(-3, '12:00'));
  await newClient(at(-3, '12:00'));
  const hashes = (await db.all('SELECT password_hash FROM users ORDER BY id')).map((r) => r.password_hash);
  check(hashes[0] !== hashes[1], 'dos cuentas con la misma contraseña tienen hashes distintos');
  check(hashes[0].startsWith('$argon2id$v=19$m=19456,t=2,p=1$'), 'Argon2id con 19 MiB, 2 iteraciones y paralelismo 1', hashes[0]);
  check(!hashes.join('').includes('Prueba-MesaLista'), 'no hay contraseñas en claro');
});

// ---------------------------------------------------------------------------
// CP-35 · avisos push (FCM) de los mismos cambios que RF-17 y RF-32, contra un
// servidor falso de Google (fcm-stub.js) que comprueba la firma de la cuenta
// de servicio. CP-29 a CP-34 son las pruebas manuales de la memoria.
// ---------------------------------------------------------------------------
test('CP-35', 'Avisos push con Firebase Cloud Messaging', async () => {
  const port = 18098;
  const rsa = () => generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const { publicKey, privateKey } = rsa();
  const pub = join(tmpdir(), `ml-fcm-${randomBytes(4).toString('hex')}.pem`);
  const log = join(tmpdir(), `ml-fcm-${randomBytes(4).toString('hex')}.log`);
  writeFileSync(pub, publicKey);
  writeFileSync(log, '');
  const stub = await startStub('fcm-stub.js', port, { ML_FCM_PUBKEY: pub, ML_FCM_LOG: log, ML_FCM_PORT: String(port) });
  const saved = configSettings.fcm;
  const use = (pem) => {
    configSettings.fcm = {
      enabled: true,
      project_id: 'mesalista-pruebas',
      client_email: 'push@mesalista-pruebas.iam.gserviceaccount.com',
      private_key: pem,
      token_uri: `http://127.0.0.1:${port}/token`,
      api: `http://127.0.0.1:${port}`,
    };
  };
  const outbox = () => db.all(`SELECT o.title, o.body, o.attempts, o.last_error, d.token FROM push_outbox o
                                 JOIN push_devices d ON d.id = o.device_id ORDER BY o.id`);
  try {
    const book = at(-3, '12:00');
    const c = await newClient(book);
    const dev = `dispositivo-de-prueba-${randomBytes(8).toString('hex')}`;
    check((await c.post('/me/devices', { token: dev, platform: 'android' })).status === 201, 'la app registra su dispositivo (201)');
    check((await c.post('/me/devices', { token: dev, platform: 'android' })).status === 200, 'registrarlo otra vez no lo duplica (200)');
    check((await c.post('/me/devices', { token: 'corto', platform: 'android' })).status === 422
      && (await c.post('/me/devices', { token: dev, platform: 'windows' })).status === 422, 'un token o una plataforma no válidos: 422');
    check((await client(book).post('/me/devices', { token: dev, platform: 'android' })).status === 401, 'sin sesión no se registra ningún dispositivo');

    const r = (await reserve(c, day(), '21:00', 2, { note: 'Nota privada', consent: true })).body.reservation;
    let rows = await outbox();
    check(rows.length === 1 && rows[0].title === 'Reserva confirmada' && rows[0].body.includes('a las 21:00')
      && rows[0].body.includes('2 comensales'), 'la reserva deja un aviso con el asunto, la hora y los comensales', rows);
    check(!JSON.stringify(await db.all('SELECT * FROM push_outbox')).includes('Nota privada'), 'el aviso no lleva la nota (como RP-05)');

    configSettings.fcm = { enabled: false };
    check((await push.flush()) === 0 && (await outbox()).length === 1, 'sin cuenta de servicio no se envía y el aviso espera en la cola');

    use(rsa().privateKey);
    rows = await outbox();
    check((await push.flush()) === 0 && (await outbox())[0].attempts === 1 && String((await outbox())[0].last_error).includes('token de acceso'),
      'con una clave que no es la de la cuenta, Google no da el token y se gasta un intento', await outbox());

    use(privateKey);
    let sent = await push.flush();
    const first = readFileSync(log, 'utf8').split('\n').filter(Boolean)[0];
    const msg = first ? JSON.parse(first).message ?? {} : {};
    check(sent === 1 && (await outbox()).length === 0, 'con la cuenta de servicio buena se envía y sale de la cola');
    check(msg.token === dev && msg.notification?.title === 'Reserva confirmada'
      && msg.data?.type === 'confirmed' && msg.data?.reservation_id === String(r.id)
      && msg.android?.priority === 'high', 'FCM recibe el dispositivo, el título y el id de la reserva', msg);

    await c.post('/me/devices', { token: `muerto-${'x'.repeat(20)}`, platform: 'android' });
    await c.post(`/reservations/${r.id}/cancel`);
    sent = await push.flush();
    check(sent === 1 && (await db.value("SELECT COUNT(*) FROM push_devices WHERE token LIKE 'muerto-%'")) === 0,
      'un dispositivo que FCM ya no conoce (404) se borra', sent);

    await c.post('/me/devices', { token: `limite-${'x'.repeat(20)}`, platform: 'android' });
    await reserve(c, day(1), '21:00', 2);
    sent = await push.flush();
    rows = await outbox();
    check(sent === 1 && rows.length === 1 && rows[0].attempts === 0 && String(rows[0].last_error).includes('429'),
      'con el límite de FCM (429) el aviso vuelve a la cola sin gastar intentos', rows);

    await db.exec('UPDATE push_outbox SET created_at = ?', [clock.sql(clock.plus(new Date(), -120))]);
    check((await push.flush()) === 0 && (await outbox()).length === 0, 'un aviso de hace más de una hora se descarta sin enviarlo');

    const d = await newClient(book);
    check((await d.post('/me/devices', { token: dev, platform: 'ios' })).status === 200
      && (await db.value('SELECT user_id FROM push_devices WHERE token = ?', [dev])) === (await db.value('SELECT id FROM users WHERE email = ?', [d.email])),
    'si otra cuenta entra en el mismo dispositivo, el token pasa a ella');
    check((await d.delete('/me/devices', { token: dev })).status === 200 && (await db.value('SELECT 1 FROM push_devices WHERE token = ?', [dev])) === null,
      'al cerrar sesión, la app da de baja el dispositivo');
    const cid = await db.value('SELECT id FROM users WHERE email = ?', [c.email]);
    await c.delete('/me', { password: PASSWORD });
    check((await db.value('SELECT COUNT(*) FROM push_devices WHERE user_id = ?', [cid])) === 0, 'al eliminar la cuenta se borran sus dispositivos');

    configSettings.fcm.api = 'http://fcm.ejemplo.test';
    try {
      await push.send(dev, 'Prueba', 'Prueba');
      check(false, 'una dirección de Google sin https debería rechazarse');
    } catch (e) {
      check(e.message.includes('https'), 'la dirección de Google tiene que ser https', e.message);
    }
  } finally {
    configSettings.fcm = saved;
    stub.kill();
    rmSync(log, { force: true });
    rmSync(pub, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

runWith({ state: newState(), tx: null }, async () => {
  console.log(`MesaLista · pruebas contra ${base}\nDía base: ${day()} (sábado)`);
  for (const { id, title, fn } of tests) {
    if (only !== null && !only.includes(id)) {
      continue;
    }
    current = id;
    console.log(`\n\x1b[1m${id} · ${title}\x1b[0m`);
    await resetDatabase();
    try {
      await fn();
    } catch (e) {
      check(false, `excepción: ${e?.message ?? e}`, String(e?.stack ?? '').split('\n')[1]?.trim());
    }
  }
  await resetDatabase();
  await db.close();
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Comprobaciones correctas: ${results.ok} · fallidas: ${results.fail}`);
  for (const f of failures) {
    console.log(`  ✘ ${f}`);
  }
  process.exit(results.fail === 0 ? 0 : 1);
});
