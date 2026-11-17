// Configuración del restaurante y cuentas del personal (RF-36 a RF-38).

import * as db from './db.js';
import * as clock from './clock.js';
import * as settings from './settings.js';
import * as schedule from './schedule.js';
import * as auth from './auth.js';
import * as V from './validate.js';
import { code, likeEscape } from './booking.js';
import { fail, ip } from './http.js';

export async function tables() {
  const rows = await db.all('SELECT * FROM dining_tables WHERE deleted_at IS NULL ORDER BY join_only, zone, number');
  return rows.map((t) => ({
    id: t.id,
    number: t.number,
    code: code(t),
    zone: t.zone,
    min_capacity: t.min_capacity,
    max_capacity: t.max_capacity,
    active: t.active,
    join_only: t.join_only,
    pos_x: t.pos_x,
    pos_y: t.pos_y,
    shape: t.shape,
  }));
}

/**
 * Guarda el plano de la sala: posición (centro en un lienzo de 1000 × 600 de
 * su zona) y forma de cada mesa. No toca capacidades ni reservas.
 */
export async function saveLayout(input) {
  V.only(input, ['tables']);
  const list = input.tables ?? null;
  if (!Array.isArray(list) || list.length > 200) {
    V.invalid('tables', 'El plano debe ser una lista de hasta 200 mesas.');
  }
  const rows = list.map((t) => {
    if (!V.isObject(t)) {
      V.invalid('tables', 'Mesa no válida en el plano.');
    }
    V.only(t, ['id', 'pos_x', 'pos_y', 'shape']);
    const shape = t.shape ?? 'rect';
    if (!['rect', 'round'].includes(shape)) {
      V.invalid('shape', 'La forma debe ser «rect» o «round».');
    }
    return [
      V.int(t.id ?? null, 'id', 1, V.MAX_ID),
      V.int(t.pos_x ?? null, 'pos_x', 0, 1000),
      V.int(t.pos_y ?? null, 'pos_y', 0, 600),
      shape,
    ];
  });
  await db.tx(async () => {
    for (const [id, x, y, shape] of rows) {
      // Las mesas extra no tienen plano.
      const n = await db.exec(
        'UPDATE dining_tables SET pos_x = ?, pos_y = ?, shape = ? WHERE id = ? AND NOT join_only AND deleted_at IS NULL',
        [x, y, shape, id],
      );
      if (n === 0 && (await db.value('SELECT 1 FROM dining_tables WHERE id = ? AND deleted_at IS NULL', [id])) === null) {
        fail(404, 'not_found', `La mesa ${id} no existe.`);
      }
    }
  });
  return tables();
}

// ---------------------------------------------------------------------------
// Clientes registrados
// ---------------------------------------------------------------------------

/**
 * Clientes con sus datos de contacto y un resumen de reservas. Solo para
 * administradores; los datos personales no salen de este listado (RP-01).
 */
export async function clients(q) {
  let sql = `SELECT u.id, u.name, u.email, u.phone, u.created_at,
                    COUNT(r.id) AS total,
                    COUNT(*) FILTER (WHERE r.status = 'confirmed' AND r.start_at > ?) AS upcoming,
                    COUNT(*) FILTER (WHERE r.status = 'completed') AS completed,
                    COUNT(*) FILTER (WHERE r.status = 'no_show') AS no_show,
                    MAX(r.start_at) AS last_reservation
               FROM users u
               LEFT JOIN reservations r ON r.user_id = u.id
              WHERE u.role = 'client'`;
  const params = [clock.sql()];
  if (q !== null && q !== '') {
    const like = `%${likeEscape(q)}%`;
    sql += ' AND (search_key(u.name) LIKE search_key(?) OR search_key(u.email) LIKE search_key(?) OR u.phone LIKE ?)';
    const digits = q.replace(/\D/g, '');
    params.push(like, like, digits === '' ? like : `%${digits}%`);
  }
  sql += ' GROUP BY u.id ORDER BY u.created_at DESC LIMIT 500';
  return (await db.all(sql, params)).map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    created_at: u.created_at.slice(0, 10),
    reservations: u.total,
    upcoming: u.upcoming,
    completed: u.completed,
    no_show: u.no_show,
    last_reservation: u.last_reservation === null ? null : u.last_reservation.slice(0, 10),
  }));
}

// ---------------------------------------------------------------------------
// Franjas de servicio y días cerrados (RF-36)
// ---------------------------------------------------------------------------

export async function getSchedule() {
  const slots = (await db.all('SELECT weekday, open_min, close_min FROM service_slots ORDER BY weekday, open_min'))
    .map((s) => ({ weekday: s.weekday, open: schedule.hhmm(s.open_min), close: schedule.hhmm(s.close_min) }));
  const closed = (await db.all('SELECT day FROM closed_days WHERE day >= ? ORDER BY day', [clock.ymd(clock.now())]))
    .map((r) => r.day);
  return { slots, closed_days: closed };
}

/** Sustituye todas las franjas. "00:00" como cierre significa medianoche. */
export async function saveSlots(input) {
  V.only(input, ['slots']);
  const slots = input.slots ?? null;
  if (!Array.isArray(slots) || slots.length > 50) {
    V.invalid('slots', 'Las franjas deben ser una lista de hasta 50 elementos.');
  }
  const clean = new Map();
  for (const s of slots) {
    if (!V.isObject(s)) {
      V.invalid('slots', 'Franja no válida.');
    }
    V.only(s, ['weekday', 'open', 'close']);
    const weekday = V.int(s.weekday ?? null, 'weekday', 1, 7);
    const open = V.time(s.open ?? null, 'open');
    let close = V.time(s.close ?? null, 'close');
    if (close === 0) {
      close = 1440;
    }
    if (open >= close) {
      V.invalid('close', 'Cada franja debe cerrar después de abrir.');
    }
    if (!clean.has(weekday)) {
      clean.set(weekday, []);
    }
    clean.get(weekday).push([open, close]);
  }
  for (const list of clean.values()) {
    list.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < list.length; i++) {
      if (list[i][0] < list[i - 1][1]) {
        V.invalid('slots', 'Dos franjas del mismo día no pueden solaparse.');
      }
    }
  }
  await db.tx(async () => {
    await db.exec('DELETE FROM service_slots');
    for (const [weekday, list] of clean) {
      for (const [open, close] of list) {
        await db.exec('INSERT INTO service_slots (weekday, open_min, close_min) VALUES (?, ?, ?)', [weekday, open, close]);
      }
    }
  });
  return getSchedule();
}

export async function setClosedDay(input, closed) {
  V.only(input, ['date']);
  const day = clock.ymd(V.date(input.date ?? null));
  if (closed) {
    await db.exec('INSERT INTO closed_days (day) VALUES (?) ON CONFLICT DO NOTHING', [day]);
  } else {
    await db.exec('DELETE FROM closed_days WHERE day = ?', [day]);
  }
  return getSchedule();
}

// ---------------------------------------------------------------------------
// Parámetros y opciones de menú (RF-37)
// ---------------------------------------------------------------------------

export async function getSettings() {
  const options = (await db.all('SELECT id, name, active FROM menu_options ORDER BY id'))
    .map((o) => ({ id: o.id, name: o.name, active: o.active }));
  return {
    settings: await settings.all(),
    ranges: settings.RANGES,
    menu_options: options,
    close_pin_set: (await db.value("SELECT 1 FROM secrets WHERE name = 'close_pin'")) !== null,
  };
}

// ---------------------------------------------------------------------------
// PIN de «Cerrar local»: lo fija el administrador; lo usa el personal.
// ---------------------------------------------------------------------------

const PIN_MAX_FAILED = 5;
const PIN_LOCK_MIN = 15;
const PIN_RE = /^\d{4,8}$/;

export async function setClosePin(input) {
  V.only(input, ['pin']);
  const pin = input.pin ?? null;
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) {
    V.invalid('pin', 'El PIN debe tener de 4 a 8 cifras.');
  }
  await db.exec(
    `INSERT INTO secrets (name, value, updated_at) VALUES ('close_pin', ?, ?)
     ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [await auth.hash(pin), clock.sql()],
  );
  return getSettings();
}

/**
 * Comprueba el PIN. Tras 5 fallos en 15 minutos (de cualquier persona)
 * se bloquea: un PIN de pocas cifras no se puede probar a ciegas.
 */
export async function checkClosePin(pin) {
  const key = auth.sha256('close-pin');
  const failed = await db.value(
    'SELECT COUNT(*) FROM login_attempts WHERE email_hash = ? AND NOT success AND created_at > ?',
    [key, clock.sql(clock.plus(clock.now(), -PIN_LOCK_MIN))],
  );
  if (failed >= PIN_MAX_FAILED) {
    fail(429, 'locked', 'Demasiados PIN incorrectos. Espera 15 minutos o pide ayuda al administrador.');
  }
  const hashed = await db.value("SELECT value FROM secrets WHERE name = 'close_pin'");
  if (hashed === null) {
    fail(409, 'no_pin', 'El administrador aún no ha fijado el PIN de «Cerrar local» (Administración → Parámetros).');
  }
  const ok = typeof pin === 'string' && PIN_RE.test(pin) && await auth.verifyHash(hashed, pin);
  await db.exec('INSERT INTO login_attempts (email_hash, ip, success, created_at) VALUES (?, ?, ?, ?)',
    [key, ip(), ok, clock.sql()]);
  if (!ok) {
    fail(403, 'bad_pin', 'PIN incorrecto.');
  }
}

/** Los cambios solo afectan a las reservas nuevas (regla 9). */
export async function saveSettings(input) {
  V.only(input, Object.keys(settings.RANGES));
  const updated = { ...(await settings.all()) };
  for (const [name, value] of Object.entries(input)) {
    const [min, max] = settings.RANGES[name];
    updated[name] = V.int(value, name, min, max);
  }
  if (updated.min_party > updated.max_party) {
    V.invalid('min_party', 'El mínimo de comensales no puede superar el máximo.');
  }
  if (updated.max_group_party <= updated.max_party) {
    V.invalid('max_group_party', 'El máximo de un grupo debe ser mayor que el máximo de comensales de una reserva normal.');
  }
  await db.tx(async () => {
    for (const name of Object.keys(input)) {
      await db.exec('UPDATE settings SET value = ? WHERE name = ?', [updated[name], name]);
    }
  });
  settings.forget();
  return getSettings();
}

export async function saveMenuOption(id, input) {
  V.only(input, ['name', 'active']);
  try {
    if (id === null) {
      await db.exec('INSERT INTO menu_options (name) VALUES (?)', [V.text(input.name ?? null, 'name', 2, 40)]);
    } else {
      if ((await db.value('SELECT 1 FROM menu_options WHERE id = ?', [id])) === null) {
        fail(404, 'not_found', 'Opción no encontrada.');
      }
      if (V.has(input, 'name')) {
        await db.exec('UPDATE menu_options SET name = ? WHERE id = ?', [V.text(input.name, 'name', 2, 40), id]);
      }
      if (V.has(input, 'active')) {
        await db.exec('UPDATE menu_options SET active = ? WHERE id = ?', [V.bool(input.active, 'active'), id]);
      }
    }
  } catch (e) {
    if (db.isDuplicateKey(e)) {
      fail(409, 'duplicate', 'Ya existe una opción con ese nombre.');
    }
    throw e;
  }
  return getSettings();
}

// ---------------------------------------------------------------------------
// Cuentas del personal (RF-38)
// ---------------------------------------------------------------------------

export async function staff() {
  return (await db.all("SELECT id, name, email, role, active FROM users WHERE role IN ('staff','admin') ORDER BY name"))
    .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active }));
}

function role(v) {
  if (!['staff', 'admin'].includes(v)) {
    V.invalid('role', 'El rol debe ser «staff» o «admin».');
  }
  return v;
}

export async function createStaff(input) {
  V.only(input, ['name', 'email', 'password', 'role']);
  const name = V.name(input.name ?? null);
  const email = V.email(input.email ?? null);
  const userRole = role(input.role ?? null);
  const password = auth.checkPasswordPolicy(input.password ?? null);
  try {
    await db.exec(
      'INSERT INTO users (role, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      [userRole, name, email, await auth.hash(password), clock.sql()],
    );
  } catch (e) {
    if (db.isDuplicateKey(e)) {
      fail(409, 'email_taken', 'Ya existe una cuenta con ese correo.', { field: 'email' });
    }
    throw e;
  }
  return staff();
}

/** Una cuenta desactivada no puede iniciar sesión y pierde las sesiones abiertas. */
export async function updateStaff(adminUser, id, input) {
  V.only(input, ['name', 'role', 'active', 'password']);
  const u = await db.one("SELECT id FROM users WHERE id = ? AND role IN ('staff','admin')", [id]);
  if (u === null) {
    fail(404, 'not_found', 'Cuenta no encontrada.');
  }
  const self = id === adminUser.id;
  if (V.has(input, 'name')) {
    await db.exec('UPDATE users SET name = ? WHERE id = ?', [V.name(input.name), id]);
  }
  if (V.has(input, 'role')) {
    const newRole = role(input.role);
    if (self && newRole !== 'admin') {
      fail(409, 'self', 'No puedes quitarte el rol de administrador a ti mismo.');
    }
    await db.exec('UPDATE users SET role = ? WHERE id = ?', [newRole, id]);
  }
  if (V.has(input, 'password')) {
    await db.exec('UPDATE users SET password_hash = ? WHERE id = ?', [await auth.hash(auth.checkPasswordPolicy(input.password)), id]);
  }
  if (V.has(input, 'active')) {
    const active = V.bool(input.active, 'active');
    if (self && !active) {
      fail(409, 'self', 'No puedes desactivar tu propia cuenta.');
    }
    await db.exec('UPDATE users SET active = ? WHERE id = ?', [active, id]);
    if (!active) {
      await db.exec('DELETE FROM sessions WHERE user_id = ?', [id]);
    }
  }
  return staff();
}
