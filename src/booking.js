// Reglas de las reservas: disponibilidad, asignación de mesa, creación,
// modificación, cancelación, vinculación, llegadas y estado en sala.
//
// Concurrencia (RF-09): toda operación que asigna una mesa bloquea antes con
// SELECT ... FOR UPDATE las filas de las mesas candidatas y después comprueba
// los solapamientos. Dos solicitudes que pueden acabar en la misma mesa
// bloquean esa fila, así que la segunda espera a que la primera confirme y ya
// ve su reserva. Las mesas se bloquean al final, justo antes de insertar,
// para que la transacción dure lo mínimo.
//
// Orden de bloqueo: usuario → reserva → mesas (por id).

import { timingSafeEqual } from 'node:crypto';
import * as db from './db.js';
import * as clock from './clock.js';
import * as settings from './settings.js';
import * as schedule from './schedule.js';
import * as V from './validate.js';
import * as qr from './qr.js';
import * as mail from './mail.js';
import * as payments from './payments.js';
import * as present from './present.js';
import * as admin from './admin.js';
import { fail } from './http.js';

// Ocupan la mesa: reservas confirmadas, en curso y pendientes de pago (RF-44), y los bloqueos (RF-45).
const BLOCKING = ['confirmed', 'seated', 'hold', 'pending_payment'];

/** Compara tuplas como [capacidad, zona, número]: números por valor, textos por orden. */
function compareTuples(a, b) {
  for (let i = 0; i < a.length; i++) {
    const x = typeof a[i] === 'boolean' ? Number(a[i]) : a[i];
    const y = typeof b[i] === 'boolean' ? Number(b[i]) : b[i];
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

const sum = (list) => list.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// Consultas auxiliares
// ---------------------------------------------------------------------------

/**
 * Código visible de una mesa: inicial de la zona y número dentro de ella
 * (S-1 sala, T-1 terraza, E-1 extra). Igual que la columna code_live.
 */
export function code(t) {
  return `${[...String(t.zone)][0].toUpperCase()}-${Number(t.number)}`;
}

/** Mesas activas que admiten party, la de menor capacidad máxima primero (RF-08). */
async function suitableTables(party, lock) {
  const rows = await db.all(
    `SELECT id, number, zone, min_capacity, max_capacity FROM dining_tables
      WHERE active AND NOT join_only AND min_capacity <= ? AND max_capacity >= ?
      ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    [party, party],
  );
  return rows.sort((a, b) => compareTuples([a.max_capacity, a.zone, a.number], [b.max_capacity, b.zone, b.number]));
}

/**
 * Ids de las mesas con alguna reserva o bloqueo que las ocupa en [start, end).
 * Cuenta la mesa principal, las unidas y los bloqueos (vista table_blocks).
 */
async function blockedTables(tableIds, start, end, excludeId = null) {
  if (tableIds.length === 0) {
    return [];
  }
  let sql = `SELECT DISTINCT table_id FROM table_blocks
              WHERE table_id = ANY(?::int[])
                AND status = ANY(?::text[])
                AND block_start < ? AND end_at > ?`;
  const params = [tableIds, BLOCKING, clock.sql(end), clock.sql(start)];
  if (excludeId !== null) {
    // Los bloqueos no tienen reserva (NULL): nunca se excluyen.
    sql += ' AND (reservation_id IS NULL OR reservation_id <> ?)';
    params.push(excludeId);
  }
  return (await db.all(sql, params)).map((r) => r.table_id);
}

/** Ids de las mesas ocupadas ahora en sala (con una reserva «en curso»), unidas incluidas. */
async function occupiedTables(excludeId = null) {
  let sql = "SELECT DISTINCT table_id FROM table_blocks WHERE status = 'seated'";
  const params = [];
  if (excludeId !== null) {
    sql += ' AND reservation_id <> ?';
    params.push(excludeId);
  }
  return (await db.all(sql, params)).map((r) => r.table_id);
}

/** Mesas unidas (adicionales) de una reserva: Map id → fila. */
async function extraTables(reservationId, lock = false) {
  const rows = await db.all(
    `SELECT t.id, t.number, t.zone, t.min_capacity, t.max_capacity, t.active
       FROM reservation_tables rt JOIN dining_tables t ON t.id = rt.table_id
      WHERE rt.reservation_id = ? ORDER BY t.id${lock ? ' FOR UPDATE OF t' : ''}`,
    [reservationId],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Mesa adecuada que nadie bloquea en [start, end), bloqueando las candidatas.
 * Con freeNow, además debe estar libre en sala en este momento.
 */
async function pickTable(party, start, end, excludeId, freeNow = false) {
  const tables = await suitableTables(party, true);
  let busy = await blockedTables(tables.map((t) => t.id), start, end, excludeId);
  if (freeNow) {
    busy = busy.concat(await occupiedTables(excludeId));
  }
  return tables.find((t) => !busy.includes(t.id)) ?? null;
}

/** RF-24: marca las no presentadas con la hora del servidor (también lo hace worker.js cada minuto). */
export async function markNoShows() {
  await db.run('CALL sp_mark_no_shows(?::timestamp)', [clock.sql()]);
  await notifyExpiredPayments();
  await syncGroupCancellations();
}

/**
 * RF-43: si el cliente cancela la reserva de un grupo ya aceptado (pagada o
 * pendiente de pago), la solicitud pasa a «cancelada»: el panel la muestra
 * como «Cancelada por el cliente» y deja de salir en «Mis reservas». Se
 * llama al cancelar y también cada minuto (worker.js), lo que corrige las
 * que se cancelaron antes de existir esta comprobación.
 */
async function syncGroupCancellations(reservationId = null) {
  await db.exec(
    `UPDATE group_requests g SET status = 'cancelled'
       FROM reservations r
      WHERE r.id = g.reservation_id AND g.status = 'accepted'
        AND r.status = 'cancelled' AND r.cancelled_by = 'holder'
        ${reservationId === null ? '' : 'AND r.id = ?'}`,
    reservationId === null ? [] : [reservationId],
  );
}

/**
 * RF-44: aviso y correo de las reservas de grupo que el sistema ha liberado
 * por no pagar la señal. Las cancela el procedimiento (también desde
 * worker.js); el aviso en la app sirve de marca de «ya avisada».
 */
async function notifyExpiredPayments() {
  const ids = await db.all(
    `SELECT r.id FROM reservations r
      WHERE r.status = 'cancelled' AND r.cancelled_by = 'system' AND r.user_id IS NOT NULL
        AND r.cancelled_at > ?
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.reservation_id = r.id AND n.created_at >= r.cancelled_at)`,
    [clock.sql(clock.addDays(clock.now(), -1))],
  );
  for (const { id } of ids) {
    await db.tx(async () => {
      const r = await db.one('SELECT * FROM reservations WHERE id = ? FOR UPDATE', [id]);
      if ((await db.value('SELECT 1 FROM notifications WHERE reservation_id = ? AND created_at >= ?', [r.id, r.cancelled_at])) !== null) {
        return;
      }
      const start = clock.at(r.start_at);
      // worker.js usa la hora real: la marca nunca queda antes de la cancelación.
      const stamp = clock.sql() > r.cancelled_at ? clock.sql() : r.cancelled_at;
      await db.exec(
        'INSERT INTO notifications (user_id, reservation_id, message, created_at) VALUES (?, ?, ?, ?)',
        [r.user_id, r.id,
          `No se pagó la señal a tiempo y se ha liberado la reserva de grupo del ${clock.dmy(start)} a las ${clock.hm(start)}.`,
          stamp],
      );
      const u = await db.one('SELECT name, email FROM users WHERE id = ?', [r.user_id]);
      await mail.queueReservation('payment_expired', u.email, u.name, r);
    });
  }
}

async function futureConfirmedCount(userId) {
  return db.value(
    "SELECT COUNT(*) FROM reservations WHERE user_id = ? AND status = 'confirmed' AND start_at > ?",
    [userId, clock.sql()],
  );
}

function idForRequest(userId, requestId) {
  return db.value('SELECT id FROM reservations WHERE user_id = ? AND request_id = ?', [userId, requestId]);
}

/**
 * Reserva con su mesa, sus mesas unidas y sus opciones de menú, o null.
 * table_codes lista todas sus mesas (S-1, …) y capacity es la suma de sus plazas.
 */
export async function load(id) {
  const r = await db.one(
    `SELECT r.*, t.number AS table_number, t.zone, t.max_capacity,
            u.name AS user_name, u.email AS user_email, u.phone AS user_phone,
            (SELECT p.status FROM payments p
              WHERE p.reservation_id = r.id AND p.status IN ('captured','refund_pending','refunded')
              ORDER BY p.id DESC LIMIT 1) AS payment_status
       FROM reservations r
       JOIN dining_tables t ON t.id = r.table_id
       LEFT JOIN users u ON u.id = r.user_id
      WHERE r.id = ?`,
    [id],
  );
  if (r === null) {
    return null;
  }
  r.menu_options = (await db.all(
    'SELECT option_id FROM reservation_menu_options WHERE reservation_id = ? ORDER BY option_id', [id],
  )).map((row) => row.option_id);
  const extra = [...(await extraTables(id)).values()];
  r.table_code = code({ zone: r.zone, number: r.table_number });
  r.extra_tables = extra.map(code);
  r.table_codes = [r.table_code, ...r.extra_tables];
  r.capacity = r.max_capacity + sum(extra.map((t) => t.max_capacity));
  return r;
}

async function mustLoad(id) {
  return (await load(id)) ?? fail(404, 'not_found', 'Reserva no encontrada.');
}

// ---------------------------------------------------------------------------
// Validación de solicitudes
// ---------------------------------------------------------------------------

async function checkParty(party) {
  const minParty = await settings.get('min_party');
  const maxParty = await settings.get('max_party');
  if (party < minParty || party > maxParty) {
    fail(422, 'invalid_party', `El número de comensales debe estar entre ${minParty} y ${maxParty}.`, { field: 'party' });
  }
}

/**
 * Regla 3: hora de inicio permitida, día abierto, comensales en el rango y
 * antelación. El personal no tiene antelación mínima (regla 8).
 */
async function checkRequest(day, minutes, party, durationMin, isStaff) {
  await checkParty(party);
  if (await schedule.isClosed(day)) {
    fail(422, 'closed', 'El restaurante está cerrado ese día.', { field: 'date' });
  }
  if (!(await schedule.startTimes(day, durationMin)).includes(minutes)) {
    fail(422, 'invalid_time', 'Esa hora de inicio no está permitida.', { field: 'time' });
  }
  const start = schedule.at(day, minutes);
  const now = clock.now();
  if (isStaff) {
    if (start <= now) {
      fail(422, 'past', 'Esa hora ya ha pasado.', { field: 'time' });
    }
  } else {
    const minAdvance = await settings.get('min_advance_min');
    if (start < clock.plus(now, minAdvance)) {
      fail(422, 'too_soon', `Hay que reservar con al menos ${minAdvance} minutos de antelación.`, { field: 'time' });
    }
  }
  const maxDays = await settings.get('max_advance_days');
  if (start > clock.addDays(now, maxDays)) {
    fail(422, 'too_far', `Solo se puede reservar con ${maxDays} días de antelación como máximo.`, { field: 'date' });
  }
  return start;
}

/**
 * Opciones de menú y nota (RF-12, RF-13). Sin consentimiento explícito se
 * guardan sin ellas (RP-04), pero antes se validan igualmente (RS-08).
 * Devuelve [opciones, nota, consentimiento].
 */
async function extras(input) {
  const consent = V.has(input, 'consent') ? V.bool(input.consent, 'consent') : false;
  const options = V.has(input, 'menu_options') && input.menu_options !== null
    ? V.idList(input.menu_options, 'menu_options', 10) : [];
  let note = null;
  if (V.has(input, 'note') && input.note !== null) {
    note = V.text(input.note, 'note', 0, 200, true);
    note = note === '' ? null : note;
  }
  const valid = await settings.menuOptions();
  for (const o of options) {
    if (!valid.has(o)) {
      V.invalid('menu_options', 'Alguna opción de menú no existe.');
    }
  }
  if (!consent) {
    return [[], null, false];
  }
  return [options, note, options.length > 0 || note !== null];
}

async function saveExtras(id, options, note, consent) {
  await db.exec('DELETE FROM reservation_menu_options WHERE reservation_id = ?', [id]);
  for (const o of options) {
    await db.exec('INSERT INTO reservation_menu_options (reservation_id, option_id) VALUES (?, ?)', [id, o]);
  }
  await db.exec('UPDATE reservations SET note = ?, consent_at = ? WHERE id = ?',
    [note, consent ? clock.sql() : null, id]);
}

async function insertReservation(f) {
  return db.insert(
    `INSERT INTO reservations
       (source, user_id, request_id, code, guest_name, guest_phone, table_id, party_size,
        start_at, end_at, arrived_at, status, arrival_before_min, arrival_after_min,
        change_deadline_h, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      f.source, f.user_id ?? null, f.request_id ?? null, f.code ?? null,
      f.guest_name ?? null, f.guest_phone ?? null, f.table_id, f.party,
      clock.sql(f.start), clock.sql(f.end), f.arrived ? clock.sql(f.arrived) : null,
      f.status, await settings.get('arrival_before_min'), await settings.get('arrival_after_min'),
      await settings.get('change_deadline_h'), f.created_by ?? null, clock.sql(),
    ],
  );
}

// ---------------------------------------------------------------------------
// Disponibilidad (RF-06)
// ---------------------------------------------------------------------------

/**
 * Horas de inicio ("HH:MM") con alguna mesa adecuada libre durante toda la
 * reserva. Para el personal no cuenta la antelación mínima (regla 8).
 */
export async function availability(day, party, isStaff = false) {
  await checkParty(party);
  const duration = await settings.get('duration_min');
  const now = clock.now();
  const earliest = isStaff ? new Date(now.getTime() + 1000) : clock.plus(now, await settings.get('min_advance_min'));
  const latest = clock.addDays(now, await settings.get('max_advance_days'));

  const times = (await schedule.startTimes(day, duration)).filter((t) => {
    const s = schedule.at(day, t);
    return s >= earliest && s <= latest;
  });
  const tableIds = (await suitableTables(party, false)).map((t) => t.id);
  if (times.length === 0 || tableIds.length === 0) {
    return [];
  }

  const from = clock.sql(schedule.at(day, times[0]));
  const to = clock.sql(schedule.at(day, times[times.length - 1] + duration));
  const busy = new Map();
  const rows = await db.all(
    `SELECT table_id, block_start, end_at FROM table_blocks
      WHERE table_id = ANY(?::int[])
        AND status = ANY(?::text[])
        AND block_start < ? AND end_at > ?`,
    [tableIds, BLOCKING, to, from],
  );
  for (const row of rows) {
    if (!busy.has(row.table_id)) {
      busy.set(row.table_id, []);
    }
    busy.get(row.table_id).push([row.block_start, row.end_at]);
  }

  // Las fechas "AAAA-MM-DD HH:MM:SS" se comparan bien como texto.
  const free = [];
  for (const t of times) {
    const s = clock.sql(schedule.at(day, t));
    const e = clock.sql(schedule.at(day, t + duration));
    const someFree = tableIds.some((id) => !(busy.get(id) ?? []).some(([bs, be]) => bs < e && be > s));
    if (someFree) {
      free.push(schedule.hhmm(t));
    }
  }
  return free;
}

// ---------------------------------------------------------------------------
// Cliente: reservar, modificar, cancelar, vincular
// ---------------------------------------------------------------------------

/**
 * RF-07 a RF-13. Devuelve [reserva, creada]. Si la app repite una solicitud
 * ya procesada (mismo request_id), devuelve la reserva existente sin crear
 * otra (RF-10).
 */
export async function createForClient(user, input) {
  V.only(input, ['request_id', 'date', 'time', 'party', 'menu_options', 'note', 'consent']);
  const userId = user.id;
  const requestId = V.uuid(input.request_id ?? null);
  const existing = await idForRequest(userId, requestId);
  if (existing !== null) {
    return [await mustLoad(existing), false];
  }

  const day = V.date(input.date ?? null);
  const minutes = V.time(input.time ?? null);
  const party = V.int(input.party ?? null, 'party', 1, 255);
  const [options, note, consent] = await extras(input);
  const duration = await settings.get('duration_min');
  const start = await checkRequest(day, minutes, party, duration, false);
  const end = clock.plus(start, duration);

  let id;
  let created;
  try {
    [id, created] = await db.tx(async () => {
      await db.value('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
      const again = await idForRequest(userId, requestId);
      if (again !== null) {
        return [again, false];
      }
      const max = await settings.get('max_future_per_client');
      if ((await futureConfirmedCount(userId)) >= max) {
        fail(409, 'limit', `Ya tienes ${max} reservas confirmadas pendientes, que es el máximo.`);
      }
      const table = await pickTable(party, start, end, null);
      if (table === null) {
        fail(409, 'conflict', 'Esa hora ya no está disponible. Elige otra.');
      }
      const newId = await insertReservation({
        source: 'app', user_id: userId, request_id: requestId,
        table_id: table.id, party, start, end, status: 'confirmed',
      });
      await saveExtras(newId, options, note, consent);
      await mail.queueReservation('confirmed', user.email, user.name,
        { id: newId, start_at: clock.sql(start), party_size: party });
      return [newId, true];
    });
  } catch (e) {
    // Dos envíos simultáneos de la misma solicitud: gana uno y el otro la devuelve.
    if (db.isDuplicateKey(e)) {
      const winner = await idForRequest(userId, requestId);
      if (winner !== null) {
        return [await mustLoad(winner), false];
      }
    }
    throw e;
  }
  return [await mustLoad(id), created];
}

/** RS-03: un cliente solo ve y toca sus reservas; las demás «no existen». */
async function lockOwned(userId, id) {
  const r = await db.one('SELECT * FROM reservations WHERE id = ? FOR UPDATE', [id]);
  if (r === null || r.user_id !== userId) {
    fail(404, 'not_found', 'Reserva no encontrada.');
  }
  return r;
}

export async function getOwned(userId, id) {
  const r = await load(id);
  if (r === null || r.user_id !== userId) {
    fail(404, 'not_found', 'Reserva no encontrada.');
  }
  return r;
}

export async function listOwned(userId) {
  const ids = await db.all(
    `SELECT id FROM reservations WHERE user_id = ?
      ORDER BY status IN ('confirmed','seated') DESC,
               CASE WHEN status IN ('confirmed','seated') THEN start_at END ASC,
               start_at DESC`,
    [userId],
  );
  const out = [];
  for (const { id } of ids) {
    out.push(await load(id));
  }
  return out;
}

/** Plazo de modificación y de cancelación (regla 12). */
function checkDeadline(r) {
  const hours = r.change_deadline_h;
  const limit = clock.plus(clock.at(r.start_at), -60 * hours);
  if (clock.now() > limit) {
    fail(409, 'deadline', `Faltan menos de ${hours} horas para la reserva: ya no se puede cambiar ni cancelar desde la app. Llama al restaurante.`);
  }
}

/**
 * RF-13 y RF-15: cambia fecha, hora, comensales u opciones. El cambio se
 * aplica entero o no se aplica (regla 7) y siempre renueva el QR (RF-18).
 */
export async function modifyByHolder(user, id, input) {
  V.only(input, ['date', 'time', 'party', 'menu_options', 'note', 'consent']);
  const userId = user.id;
  const day = V.has(input, 'date') ? V.date(input.date) : null;
  const minutes = V.has(input, 'time') ? V.time(input.time) : null;
  const party = V.has(input, 'party') ? V.int(input.party, 'party', 1, 255) : null;
  const touchExtras = V.has(input, 'menu_options') || V.has(input, 'note') || V.has(input, 'consent');
  const [options, note, consent] = touchExtras ? await extras(input) : [[], null, false];

  await db.tx(async () => {
    await db.value('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
    const r = await lockOwned(userId, id);
    if (r.status !== 'confirmed') {
      fail(409, 'not_modifiable', 'Solo se pueden modificar las reservas confirmadas.');
    }
    checkDeadline(r);

    const oldStart = clock.at(r.start_at);
    const oldEnd = clock.at(r.end_at);
    const oldMinutes = clock.minutesOf(oldStart);
    const newDay = day ?? clock.startOfDay(oldStart);
    const newMinutes = minutes ?? oldMinutes;
    const newParty = party ?? r.party_size;
    const changesSlot = clock.ymd(newDay) !== clock.ymd(oldStart)
      || newMinutes !== oldMinutes
      || newParty !== r.party_size;
    if (!changesSlot && !touchExtras) {
      return;
    }

    let start = oldStart;
    let end = oldEnd;
    let tableId = r.table_id;
    if (changesSlot && ((await extraTables(id)).size > 0 || r.deposit_cents !== null)) {
      fail(409, 'joined_tables', 'El restaurante ha unido mesas para tu reserva: para cambiar la hora o los comensales, llama al restaurante.');
    }
    if (changesSlot) {
      // La reserva conserva su duración aunque el parámetro haya cambiado (regla 9).
      const duration = clock.minutesBetween(oldStart, oldEnd);
      start = await checkRequest(newDay, newMinutes, newParty, duration, false);
      end = clock.plus(start, duration);
      const table = await pickTable(newParty, start, end, id);
      if (table === null) {
        fail(409, 'conflict', 'No hay mesa libre para ese cambio. Tu reserva sigue como estaba.');
      }
      tableId = table.id;
    }

    await db.exec(
      `UPDATE reservations
          SET table_id = ?, party_size = ?, start_at = ?, end_at = ?, qr_version = qr_version + 1
        WHERE id = ?`,
      [tableId, newParty, clock.sql(start), clock.sql(end), id],
    );
    if (touchExtras) {
      await saveExtras(id, options, note, consent);
    }
    await mail.queueReservation('modified', user.email, user.name,
      { id, start_at: clock.sql(start), party_size: newParty });
  });
  return mustLoad(id);
}

/**
 * RF-16. Una segunda cancelación responde con éxito y no cambia nada (CA-16-5).
 * RF-44: dentro del plazo se devuelve la señal pagada; una reserva de grupo
 * aún sin pagar se puede cancelar siempre (no hay nada que devolver).
 */
export async function cancelByHolder(user, id) {
  await db.tx(async () => {
    const r = await lockOwned(user.id, id);
    if (r.status === 'cancelled') {
      return;
    }
    if (!['confirmed', 'pending_payment'].includes(r.status)) {
      fail(409, 'not_cancellable', 'Esta reserva ya no se puede cancelar.');
    }
    if (r.status === 'confirmed') {
      checkDeadline(r);
    }
    await db.exec(
      "UPDATE reservations SET status = 'cancelled', cancelled_by = 'holder', cancelled_at = ?, payment_due_at = NULL WHERE id = ?",
      [clock.sql(), id],
    );
    await syncGroupCancellations(id);
    const refund = await payments.markRefund(id);
    await mail.queueReservation('cancelled_holder', user.email, user.name, r,
      refund > 0 ? `Te devolvemos la señal de ${payments.euros(refund)} en tu cuenta de PayPal.` : '');
  });
  return mustLoad(id);
}

/** Mismo teléfono, sin tener en cuenta el prefijo de España (+34 / 0034). */
function samePhone(a, b) {
  if (a === null) {
    return false;
  }
  const norm = (p) => {
    let d = p.replace(/\D/g, '');
    if (d.startsWith('0034')) {
      d = d.slice(4);
    } else if (d.length === 11 && d.startsWith('34')) {
      d = d.slice(2);
    }
    return Buffer.from(d);
  };
  const x = norm(a);
  const y = norm(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * RF-30: vincula una reserva presencial con su código y el teléfono con el
 * que se registró. Renueva el QR, así que el del ticket deja de valer.
 * RS-13: tras 5 intentos fallidos en 15 minutos, la cuenta queda bloqueada.
 */
export async function link(user, input) {
  V.only(input, ['code', 'phone']);
  const userId = user.id;
  const failed = await db.value(
    'SELECT COUNT(*) FROM link_attempts WHERE user_id = ? AND NOT success AND created_at > ?',
    [userId, clock.sql(clock.plus(clock.now(), -15))],
  );
  if (failed >= 5) {
    fail(429, 'locked', 'Demasiados intentos fallidos. Vuelve a intentarlo dentro de 15 minutos.');
  }
  const reservationCode = qr.normalizeCode(input.code ?? null);
  const phone = V.phone(input.phone ?? null);

  const linkedId = await db.tx(async () => {
    await db.value('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
    const r = await db.one('SELECT * FROM reservations WHERE code = ? FOR UPDATE', [reservationCode]);
    const ok = r !== null
      && r.source === 'local'
      && r.user_id === null
      && r.status === 'confirmed'
      && clock.at(r.start_at) > clock.now()
      && samePhone(r.guest_phone, phone);
    if (!ok) {
      return null;
    }
    // Regla 11: la reserva vinculada cuenta para el límite del cliente.
    const max = await settings.get('max_future_per_client');
    if ((await futureConfirmedCount(userId)) >= max) {
      fail(409, 'limit', `Ya tienes ${max} reservas confirmadas pendientes, que es el máximo.`);
    }
    await db.exec('UPDATE reservations SET user_id = ?, qr_version = qr_version + 1 WHERE id = ?', [userId, r.id]);
    return r.id;
  });

  await db.exec('INSERT INTO link_attempts (user_id, success, created_at) VALUES (?, ?, ?)',
    [userId, linkedId !== null, clock.sql()]);
  if (linkedId === null) {
    fail(404, 'link_failed', 'No hay ninguna reserva pendiente con ese código y ese teléfono.');
  }
  return mustLoad(linkedId);
}

// ---------------------------------------------------------------------------
// Personal: reservas presenciales, cancelaciones, llegadas, sala
// ---------------------------------------------------------------------------

/** RF-28 y RF-29: reserva a nombre de un cliente, sin cuenta, con código y ticket. */
export async function createLocal(staffId, input) {
  V.only(input, ['name', 'phone', 'date', 'time', 'party', 'menu_options', 'note', 'consent']);
  const guestName = V.name(input.name ?? null);
  const guestPhone = V.phone(input.phone ?? null);
  const day = V.date(input.date ?? null);
  const minutes = V.time(input.time ?? null);
  const party = V.int(input.party ?? null, 'party', 1, 255);
  const [options, note, consent] = await extras(input);
  const duration = await settings.get('duration_min');
  const start = await checkRequest(day, minutes, party, duration, true);
  const end = clock.plus(start, duration);

  const id = await db.tx(async () => {
    const table = await pickTable(party, start, end, null);
    if (table === null) {
      fail(409, 'conflict', 'Esa hora ya no está disponible. Elige otra.');
    }
    let newCode;
    do {
      newCode = qr.newCode();
    } while ((await db.value('SELECT 1 FROM reservations WHERE code = ?', [newCode])) !== null);
    const newId = await insertReservation({
      source: 'local', code: newCode, guest_name: guestName, guest_phone: guestPhone,
      table_id: table.id, party, start, end, status: 'confirmed', created_by: staffId,
    });
    await saveExtras(newId, options, note, consent);
    return newId;
  });
  return mustLoad(id);
}

/** Mesas activas ordenadas por id (Map id → fila), opcionalmente bloqueadas FOR UPDATE. */
async function activeTables(lock) {
  const rows = await db.all(`SELECT * FROM dining_tables WHERE active ORDER BY id${lock ? ' FOR UPDATE' : ''}`);
  return new Map(rows.map((t) => [t.id, t]));
}

/** RF-43: mesas activas para la hora de una solicitud de grupo, con las libres marcadas. */
export async function groupTables(requestId) {
  await markNoShows();
  const g = await db.one('SELECT day, time_min FROM group_requests WHERE id = ?', [requestId])
    ?? fail(404, 'not_found', 'Solicitud no encontrada.');
  const start = schedule.at(clock.at(g.day), g.time_min);
  const end = clock.plus(start, await settings.get('duration_min'));
  const tables = await activeTables(false);
  const busy = await blockedTables([...tables.keys()], start, end);
  return [...tables.values()].map((t) => ({
    id: t.id,
    number: t.number,
    code: code(t),
    zone: t.zone,
    max_capacity: t.max_capacity,
    join_only: t.join_only,
    free: !busy.includes(t.id),
  }));
}

/**
 * RF-43: el personal acepta una solicitud de grupo eligiendo las mesas (la
 * primera es la principal y las demás quedan unidas). Con señal (RF-44) la
 * reserva nace «pendiente de pago» y retiene las mesas deposit_hold_min
 * minutos; sin pasarela o sin importe por persona, nace confirmada.
 */
export async function acceptGroup(staffId, requestId, input) {
  V.only(input, ['table_ids', 'reply']);
  let wanted = V.idList(input.table_ids ?? null, 'table_ids', 10);
  if (wanted.length === 0) {
    V.invalid('table_ids', 'Elige al menos una mesa.');
  }
  const reply = input.reply !== undefined && input.reply !== null ? V.text(input.reply, 'reply', 0, 200, true) : '';
  await markNoShows();
  const userId = await db.value('SELECT user_id FROM group_requests WHERE id = ?', [requestId]);
  const depositPerPerson = await settings.get('deposit_per_person');
  const withDeposit = await payments.enabled();

  const id = await db.tx(async () => {
    if (userId !== null) {
      await db.value('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
    }
    const g = await db.one('SELECT * FROM group_requests WHERE id = ? FOR UPDATE', [requestId]);
    if (g === null) {
      fail(404, 'not_found', 'Solicitud no encontrada.');
    }
    if (g.status !== 'pending') {
      fail(409, 'not_pending', 'Esta solicitud ya está respondida o cancelada.');
    }
    if (g.user_id === null) {
      fail(409, 'no_user', 'El cliente ha eliminado su cuenta.');
    }
    const party = g.party_size;
    const start = schedule.at(clock.at(g.day), g.time_min);
    const end = clock.plus(start, await settings.get('duration_min'));
    const now = clock.now();
    if (start <= now) {
      fail(409, 'past', 'La hora de esta solicitud ya ha pasado. Recházala.');
    }

    const tables = await activeTables(true);
    for (const tid of wanted) {
      if (!tables.has(tid)) {
        fail(404, 'table_not_found', 'Alguna de esas mesas no existe o está fuera de servicio.');
      }
    }
    const capacity = sum(wanted.map((tid) => tables.get(tid).max_capacity));
    if (capacity < party) {
      fail(409, 'over_capacity', `Esas mesas suman ${capacity} plazas para ${party} personas. Añade más mesas.`);
    }
    const busy = await blockedTables(wanted, start, end);
    if (busy.length > 0) {
      fail(409, 'table_busy', `No están libres a esa hora: mesa ${busy.map((tid) => code(tables.get(tid))).join(', ')}.`);
    }
    // La principal es la primera elegida que no sea extra.
    const main = wanted.find((tid) => !tables.get(tid).join_only);
    if (main === undefined) {
      fail(409, 'join_only', 'Las mesas extra solo se unen a otra mesa: elige también una mesa de sala o de terraza.');
    }
    wanted = [main, ...wanted.filter((tid) => tid !== main)];

    const deposit = withDeposit ? depositPerPerson * 100 * party : 0;
    const newId = await insertReservation({
      source: 'app', user_id: g.user_id, table_id: wanted[0], party,
      start, end, status: deposit > 0 ? 'pending_payment' : 'confirmed', created_by: staffId,
    });
    let due = null;
    if (deposit > 0) {
      due = clock.min(clock.plus(now, await settings.get('deposit_hold_min')), start);
      await db.exec('UPDATE reservations SET deposit_cents = ?, payment_due_at = ? WHERE id = ?', [deposit, clock.sql(due), newId]);
    }
    for (const tid of wanted.slice(1)) {
      await db.exec('INSERT INTO reservation_tables (reservation_id, table_id) VALUES (?, ?)', [newId, tid]);
    }
    if (g.note !== null) {
      await db.exec('UPDATE reservations SET note = ?, consent_at = ? WHERE id = ?', [g.note, g.consent_at, newId]);
    }
    await db.exec(
      "UPDATE group_requests SET status = 'accepted', reply = ?, reservation_id = ?, decided_by = ?, decided_at = ? WHERE id = ?",
      [reply === '' ? null : reply, newId, staffId, clock.sql(), requestId],
    );

    const u = await db.one('SELECT name, email FROM users WHERE id = ?', [g.user_id]);
    const whenText = `del ${clock.dmy(start)} a las ${clock.hm(start)}`;
    const replyText = reply === '' ? '' : ` Mensaje del restaurante: «${reply}».`;
    const summary = { id: newId, start_at: clock.sql(start), party_size: party };
    let message;
    if (deposit > 0) {
      const text = `Señal: ${payments.euros(deposit)}. Tienes hasta las ${clock.hm(due)} del `
        + `${clock.dmy(due)} para pagarla; si no, la reserva se libera.${replyText}`;
      message = `Han aceptado tu grupo ${whenText}. Paga la señal de ${payments.euros(deposit)} antes de las ${clock.hm(due)}.`;
      await mail.queueReservation('group_accepted', u.email, u.name, summary, text);
    } else {
      message = `Han aceptado tu grupo ${whenText}: la reserva está confirmada.`;
      await mail.queueReservation('confirmed', u.email, u.name, summary, replyText.trim());
    }
    await db.exec('INSERT INTO notifications (user_id, reservation_id, message, created_at) VALUES (?, ?, ?, ?)',
      [g.user_id, newId, V.cut(message, 255), clock.sql()]);
    return newId;
  });
  return mustLoad(id);
}

/**
 * RF-31 y RF-32: el personal cancela sin plazo; el titular con cuenta recibe
 * aviso y correo. RF-44: la señal pagada se devuelve salvo que el personal
 * indique lo contrario (p. ej. el cliente avisa fuera de plazo).
 */
export async function cancelByRestaurant(id, input = {}) {
  V.only(input, ['refund']);
  const refund = V.has(input, 'refund') ? V.bool(input.refund, 'refund') : true;
  await db.tx(async () => {
    const r = await db.one('SELECT * FROM reservations WHERE id = ? FOR UPDATE', [id]);
    if (r === null) {
      fail(404, 'not_found', 'Reserva no encontrada.');
    }
    if (r.status === 'cancelled') {
      return;
    }
    if (!['confirmed', 'pending_payment'].includes(r.status)) {
      fail(409, 'not_cancellable', 'Solo se pueden cancelar las reservas confirmadas o pendientes de pago.');
    }
    await restaurantCancel(r, refund);
  });
  return mustLoad(id);
}

async function restaurantCancel(r, refund = true) {
  await db.exec(
    "UPDATE reservations SET status = 'cancelled', cancelled_by = 'restaurant', cancelled_at = ?, payment_due_at = NULL WHERE id = ?",
    [clock.sql(), r.id],
  );
  const refunded = refund ? await payments.markRefund(r.id) : 0;
  if (r.user_id === null) {
    return; // Reserva presencial sin vincular: el personal avisa por teléfono (regla 14).
  }
  const u = await db.one('SELECT name, email FROM users WHERE id = ?', [r.user_id]);
  const start = clock.at(r.start_at);
  await db.exec(
    'INSERT INTO notifications (user_id, reservation_id, message, created_at) VALUES (?, ?, ?, ?)',
    [r.user_id, r.id, `El restaurante ha cancelado tu reserva del ${clock.dmy(start)} a las ${clock.hm(start)}.`, clock.sql()],
  );
  const paid = await payments.capturedFor(r.id);
  let extra = '';
  if (refunded > 0) {
    extra = `Te devolvemos la señal de ${payments.euros(refunded)} en tu cuenta de PayPal.`;
  } else if (paid !== null) {
    extra = 'La señal pagada no se devuelve: la cancelación se ha hecho fuera de plazo.';
  }
  await mail.queueReservation('cancelled_restaurant', u.email, u.name, r, extra);
}

/** RF-19 y RF-20: llegada con el QR (de la app o del ticket). */
export async function arriveByQr(content, early) {
  if (typeof content !== 'string' || content.length > 120) {
    fail(422, 'qr_invalid', 'QR no válido.');
  }
  const parsed = qr.parse(content.trim());
  if (parsed === null) {
    fail(422, 'qr_invalid', 'QR no válido: no lo ha generado MesaLista o está alterado.');
  }
  const [id, version] = parsed;
  return arrive(id, version, early);
}

const ARRIVAL_ERRORS = {
  seated: ['already_seated', 'Esta llegada ya se registró: la reserva está en curso.'],
  completed: ['completed', 'Esta reserva ya está completada.'],
  cancelled: ['cancelled', 'Esta reserva está cancelada.'],
  no_show: ['no_show', 'La ventana de llegada se cerró y la reserva está «no presentada». Si hay mesa, siéntalo como cliente sin reserva.'],
  pending_payment: ['pending_payment', 'Esta reserva de grupo aún no ha pagado la señal: no está confirmada.'],
};

/**
 * Registra la llegada de una reserva confirmada (RF-19 a RF-23).
 * Dentro de la ventana de llegada, si la mesa asignada sigue ocupada se
 * reasigna a otra libre; si no hay ninguna, se avisa al personal. Antes de
 * la ventana solo se acepta con early y con la mesa libre hasta el inicio.
 */
export async function arrive(id, qrVersion, early) {
  await markNoShows();
  const arrivedId = await db.tx(async () => {
    const r = await db.one('SELECT * FROM reservations WHERE id = ? FOR UPDATE', [id]);
    if (r === null) {
      fail(404, 'not_found', 'Reserva no encontrada.');
    }
    if (qrVersion !== null && r.qr_version !== qrVersion) {
      fail(409, 'qr_outdated', 'Este QR ya no es válido: la reserva se modificó o se vinculó a una cuenta. Pide el QR vigente.');
    }
    if (r.status !== 'confirmed') {
      const [errorCode, message] = ARRIVAL_ERRORS[r.status];
      fail(409, errorCode, message);
    }

    const now = clock.now();
    const start = clock.at(r.start_at);
    const end = clock.at(r.end_at);
    const open = clock.plus(start, -r.arrival_before_min);
    let tableId = r.table_id;
    const table = await db.one('SELECT id, number, zone, active FROM dining_tables WHERE id = ? FOR UPDATE', [tableId]);
    const extra = await extraTables(id, true);
    // Mesas de la reserva que no están libres ahora (la principal y las unidas).
    const busy = [];
    const occupied = await occupiedTables(id);
    for (const t of [table, ...extra.values()]) {
      if (t.active !== true || occupied.includes(t.id)
        || (now < start && (await blockedTables([t.id], now, start, id)).length > 0)) {
        busy.push(code(t));
      }
    }
    const busyNow = busy.length > 0;
    const busyText = `${busy.length === 1 ? 'La mesa ' : 'Las mesas '}${busy.join(', ')}`;

    if (now < open) {
      if (!early) {
        fail(409, 'too_early', `Llegada anticipada: la ventana de llegada empieza a las ${clock.hm(open)}.`,
          { early_possible: !busyNow, reservation_id: r.id });
      }
      if (busyNow) {
        fail(409, 'table_busy', `${busyText} no está libre hasta la hora de la reserva. Esperad a la ventana de llegada.`);
      }
    } else if (busyNow && extra.size > 0) {
      // Mesas unidas: no se recolocan solas; el personal decide (cambiar mesa).
      fail(409, 'no_table', `${busyText} de este grupo sigue ocupada. Usa «Cambiar mesa» o «Unir mesas» para sentarlos en otras.`,
        { alert: true });
    } else if (busyNow) {
      const other = await pickTable(r.party_size, clock.min(now, start), end, r.id, true);
      if (other === null) {
        fail(409, 'no_table', `La mesa ${code(table)} sigue ocupada y no hay otra mesa libre para ${r.party_size} personas. Avisa al responsable de sala.`,
          { alert: true });
      }
      tableId = other.id;
    }

    await db.exec("UPDATE reservations SET status = 'seated', arrived_at = ?, table_id = ? WHERE id = ?",
      [clock.sql(now), tableId, r.id]);
    return r.id;
  });
  return mustLoad(arrivedId);
}

/** RF-25: la reserva en curso pasa a «completada» y la mesa queda libre. */
export async function complete(id) {
  await db.tx(async () => {
    const r = await db.one('SELECT status FROM reservations WHERE id = ? FOR UPDATE', [id]);
    if (r === null) {
      fail(404, 'not_found', 'Reserva no encontrada.');
    }
    if (r.status === 'completed') {
      return;
    }
    if (r.status !== 'seated') {
      fail(409, 'not_seated', 'Solo se pueden terminar las reservas en curso.');
    }
    await db.exec("UPDATE reservations SET status = 'completed', completed_at = ? WHERE id = ?", [clock.sql(), id]);
  });
  return mustLoad(id);
}

/** RF-26: más comensales en una reserva en curso, hasta la capacidad de todas sus mesas. */
export async function increaseParty(id, input) {
  V.only(input, ['party']);
  const party = V.int(input.party ?? null, 'party', 1, 255);
  await db.tx(async () => {
    const r = await db.one('SELECT status, party_size FROM reservations WHERE id = ? FOR UPDATE', [id]);
    if (r === null) {
      fail(404, 'not_found', 'Reserva no encontrada.');
    }
    if (r.status !== 'seated') {
      fail(409, 'not_seated', 'Solo se puede cambiar el número de comensales de una reserva en curso.');
    }
    if (party <= r.party_size) {
      fail(422, 'invalid_party', 'Indica un número de comensales mayor que el actual.', { field: 'party' });
    }
    const { capacity } = await mustLoad(id);
    if (party > capacity) {
      fail(409, 'over_capacity', `Sus mesas admiten como máximo ${capacity} comensales. Une otra mesa para sentar a más.`);
    }
    await db.exec('UPDATE reservations SET party_size = ? WHERE id = ?', [party, id]);
  });
  return mustLoad(id);
}

// ---------------------------------------------------------------------------
// Cambiar y unir mesas (panel del personal)
// ---------------------------------------------------------------------------

/**
 * Intervalo que tiene que estar libre para sentar o mover una reserva: el
 * suyo si aún no ha llegado; desde ahora hasta su fin si ya está en curso.
 */
function interval(r) {
  const end = clock.at(r.end_at);
  if (r.status === 'seated') {
    const now = clock.now();
    return [now, clock.max(end, clock.plus(now, 1))];
  }
  return [clock.at(r.block_start), end];
}

/** Ids de las mesas libres para la reserva r durante su intervalo (y ahora, si está en curso). */
async function freeFor(r, tableIds) {
  const [from, to] = interval(r);
  let busy = await blockedTables(tableIds, from, to, r.id);
  if (r.status === 'seated') {
    busy = busy.concat(await occupiedTables(r.id));
  }
  return tableIds.filter((tid) => !busy.includes(tid));
}

async function lockMovable(id) {
  const r = await db.one('SELECT * FROM reservations WHERE id = ? FOR UPDATE', [id]);
  if (r === null) {
    fail(404, 'not_found', 'Reserva no encontrada.');
  }
  if (!['confirmed', 'seated', 'pending_payment'].includes(r.status)) {
    fail(409, 'not_movable', 'Solo se pueden cambiar las mesas de una reserva confirmada o en curso.');
  }
  return r;
}

/** Señal para que los paneles abiertos recarguen (RF-34): cambia updated_at. */
async function touch(id) {
  await db.exec('UPDATE reservations SET updated_at = LOCALTIMESTAMP(6) WHERE id = ?', [id]);
}

/** Mesas a las que se puede mover o que se pueden unir a una reserva. */
export async function freeTablesFor(id) {
  await markNoShows();
  const r = await mustLoad(id);
  if (!['confirmed', 'seated', 'pending_payment'].includes(r.status)) {
    fail(409, 'not_movable', 'Solo se pueden cambiar las mesas de una reserva confirmada o en curso.');
  }
  const own = [r.table_id, ...(await extraTables(id)).keys()];
  const tables = await activeTables(false);
  const candidates = [...tables.keys()].filter((tid) => !own.includes(tid));
  const free = await freeFor(r, candidates);
  const extraCapacity = r.capacity - r.max_capacity;
  return free.map((tid) => {
    const t = tables.get(tid);
    return {
      id: tid,
      number: t.number,
      code: code(t),
      zone: t.zone,
      max_capacity: t.max_capacity,
      join_only: t.join_only,
      // Si se cambia la mesa principal por esta, ¿caben todos? (una extra nunca es la principal)
      fits_as_main: !t.join_only && t.max_capacity + extraCapacity >= r.party_size,
    };
  });
}

/** Mueve la reserva de su mesa principal a otra libre. Las mesas unidas se mantienen. */
export async function changeTable(id, input) {
  V.only(input, ['table_id']);
  const target = V.int(input.table_id ?? null, 'table_id', 1, V.MAX_ID);
  await db.tx(async () => {
    const r = await lockMovable(id);
    const tables = await activeTables(true);
    const extra = await extraTables(id, true);
    if (!tables.has(target)) {
      fail(404, 'table_not_found', 'Esa mesa no existe o está fuera de servicio.');
    }
    const t = tables.get(target);
    if (target === r.table_id || extra.has(target)) {
      fail(409, 'same_table', 'La reserva ya está en esa mesa.');
    }
    if (t.join_only) {
      fail(409, 'join_only', `La mesa ${code(t)} es extra: solo se puede unir a otra mesa, no ser la principal.`);
    }
    const capacity = t.max_capacity + sum([...extra.values()].map((e) => e.max_capacity));
    if (capacity < r.party_size) {
      fail(409, 'over_capacity', `En la mesa ${code(t)} no caben ${r.party_size} personas. Elige otra o une mesas.`);
    }
    if ((await freeFor(r, [target])).length === 0) {
      fail(409, 'table_busy', `La mesa ${code(t)} no está libre durante la reserva.`);
    }
    await db.exec('UPDATE reservations SET table_id = ? WHERE id = ?', [target, id]);
  });
  return mustLoad(id);
}

/** Une una o varias mesas libres a la reserva (grupos que no caben en una sola). */
export async function joinTables(id, input) {
  V.only(input, ['table_ids']);
  const wanted = V.idList(input.table_ids ?? null, 'table_ids', 10);
  if (wanted.length === 0) {
    V.invalid('table_ids', 'Elige al menos una mesa para unir.');
  }
  await db.tx(async () => {
    const r = await lockMovable(id);
    const tables = await activeTables(true);
    const extra = await extraTables(id, true);
    for (const tid of wanted) {
      if (!tables.has(tid)) {
        fail(404, 'table_not_found', 'Alguna de esas mesas no existe o está fuera de servicio.');
      }
      if (tid === r.table_id || extra.has(tid)) {
        fail(409, 'same_table', `La mesa ${code(tables.get(tid))} ya es de esta reserva.`);
      }
    }
    const free = await freeFor(r, wanted);
    const busy = wanted.filter((tid) => !free.includes(tid));
    if (busy.length > 0) {
      fail(409, 'table_busy', `No están libres durante la reserva: mesa ${busy.map((tid) => code(tables.get(tid))).join(', ')}.`);
    }
    for (const tid of wanted) {
      await db.exec('INSERT INTO reservation_tables (reservation_id, table_id) VALUES (?, ?)', [id, tid]);
    }
    await touch(id);
  });
  return mustLoad(id);
}

/** Separa una mesa unida, si las que quedan siguen teniendo sitio para todos. */
export async function separateTable(id, input) {
  V.only(input, ['table_id']);
  const tid = V.int(input.table_id ?? null, 'table_id', 1, V.MAX_ID);
  await db.tx(async () => {
    const r = await lockMovable(id);
    const extra = await extraTables(id, true);
    if (!extra.has(tid)) {
      fail(409, 'not_joined', 'Esa mesa no está unida a esta reserva.');
    }
    const main = await db.value('SELECT max_capacity FROM dining_tables WHERE id = ?', [r.table_id]);
    extra.delete(tid);
    const left = main + sum([...extra.values()].map((t) => t.max_capacity));
    if (left < r.party_size) {
      fail(409, 'over_capacity', `Sin esa mesa solo quedan ${left} plazas para ${r.party_size} personas.`);
    }
    await db.exec('DELETE FROM reservation_tables WHERE reservation_id = ? AND table_id = ?', [id, tid]);
    await touch(id);
  });
  return mustLoad(id);
}

/**
 * Mesas libres ahora para un cliente sin reserva durante toda la duración
 * de reserva. Todas, no solo las de su tamaño: fits indica las que bastan
 * solas; para grupos grandes se eligen varias y se unen.
 */
export async function walkInTables(party) {
  await markNoShows();
  const now = clock.now();
  const end = clock.plus(now, await settings.get('duration_min'));
  const tables = await activeTables(false);
  const busy = (await blockedTables([...tables.keys()], now, end)).concat(await occupiedTables());
  const free = [];
  for (const t of tables.values()) {
    if (!busy.includes(t.id)) {
      // Una mesa extra nunca basta sola: solo se une a otras.
      free.push({ ...t, fits: !t.join_only && t.min_capacity <= party && party <= t.max_capacity, code: code(t) });
    }
  }
  return free.sort((a, b) => compareTuples(
    [b.fits, a.join_only, a.max_capacity, a.code],
    [a.fits, b.join_only, b.max_capacity, b.code],
  ));
}

/**
 * RF-33: sienta a clientes sin reserva; la reserva nace «en curso». Con
 * table_ids se sientan en varias mesas unidas (la mayor es la principal).
 */
export async function walkIn(staffId, input) {
  V.only(input, ['party', 'table_id', 'table_ids']);
  const party = V.int(input.party ?? null, 'party', 1, 50);
  let wanted = input.table_id !== undefined && input.table_id !== null ? V.int(input.table_id, 'table_id', 1, V.MAX_ID) : null;
  const several = input.table_ids !== undefined && input.table_ids !== null ? V.idList(input.table_ids, 'table_ids', 10) : null;
  await markNoShows();
  const now = clock.now();
  const end = clock.plus(now, await settings.get('duration_min'));

  const id = await db.tx(async () => {
    if (several !== null && several.length > 1) {
      const tables = await activeTables(true);
      for (const tid of several) {
        if (!tables.has(tid)) {
          fail(404, 'table_not_found', 'Alguna de esas mesas no existe o está fuera de servicio.');
        }
      }
      const taken = (await blockedTables(several, now, end)).concat(await occupiedTables());
      const busy = several.filter((tid) => taken.includes(tid));
      if (busy.length > 0) {
        fail(409, 'table_busy', `No están libres durante toda la reserva: mesa ${busy.map((tid) => code(tables.get(tid))).join(', ')}.`);
      }
      const capacity = sum(several.map((tid) => tables.get(tid).max_capacity));
      if (capacity < party) {
        fail(409, 'over_capacity', `Esas mesas suman ${capacity} plazas para ${party} personas. Une alguna más.`);
      }
      // La principal es la mayor de las que no son extra.
      const ordered = [...several].sort((a, b) => compareTuples(
        [tables.get(a).join_only, -tables.get(a).max_capacity],
        [tables.get(b).join_only, -tables.get(b).max_capacity],
      ));
      if (tables.get(ordered[0]).join_only) {
        fail(409, 'join_only', 'Las mesas extra solo se unen a otra mesa: elige también una mesa de sala o de terraza.');
      }
      const [main, ...rest] = ordered;
      const newId = await insertReservation({
        source: 'walkin', table_id: main, party, start: now, end, arrived: now, status: 'seated', created_by: staffId,
      });
      for (const tid of rest) {
        await db.exec('INSERT INTO reservation_tables (reservation_id, table_id) VALUES (?, ?)', [newId, tid]);
      }
      return newId;
    }
    if (several !== null && several.length === 1) {
      wanted = several[0];
    }
    if (wanted !== null && (await db.value('SELECT join_only FROM dining_tables WHERE id = ?', [wanted])) === true) {
      fail(409, 'join_only', 'Las mesas extra solo se unen a otra mesa: elige también una mesa de sala o de terraza.');
    }
    const tables = await suitableTables(party, true);
    const busy = (await blockedTables(tables.map((t) => t.id), now, end)).concat(await occupiedTables());
    let free = tables.filter((t) => !busy.includes(t.id));
    if (wanted !== null) {
      free = free.filter((t) => t.id === wanted);
    }
    if (free.length === 0) {
      fail(409, 'no_table', wanted !== null
        ? 'Esa mesa no está libre para ese grupo durante toda la duración de la reserva.'
        : `No hay ninguna mesa libre para ${party} personas durante toda la duración de la reserva. Puedes unir varias mesas.`);
    }
    return insertReservation({
      source: 'walkin', table_id: free[0].id, party, start: now, end, arrived: now, status: 'seated', created_by: staffId,
    });
  });
  return mustLoad(id);
}

/** Escapa % _ y \ para usar un texto dentro de LIKE. */
export const likeEscape = (s) => s.replace(/[%_\\]/g, '\\$&');

/** RF-22 y RF-27: reservas de una fecha, con búsqueda opcional por nombre o teléfono. */
export async function agenda(day, q) {
  await markNoShows();
  let sql = `SELECT r.id FROM reservations r LEFT JOIN users u ON u.id = r.user_id
              WHERE r.start_at >= ? AND r.start_at < ?`;
  const from = clock.startOfDay(day);
  const params = [clock.sql(from), clock.sql(clock.addDays(from, 1))];
  if (q !== null && q !== '') {
    const like = `%${likeEscape(q)}%`;
    const conds = ['search_key(r.guest_name) LIKE search_key(?)', 'search_key(u.name) LIKE search_key(?)'];
    params.push(like, like);
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 3) {
      conds.push('r.guest_phone LIKE ?', "REPLACE(u.phone, '+', '') LIKE ?");
      params.push(`%${digits}%`, `%${digits}%`);
    }
    sql += ` AND (${conds.join(' OR ')})`;
  }
  sql += ' ORDER BY r.start_at, r.id';
  const out = [];
  for (const { id } of await db.all(sql, params)) {
    out.push(await load(id));
  }
  return out;
}

/** RF-34: estado en sala de cada mesa (libre, ocupada o fuera de servicio). */
export async function room() {
  await markNoShows();
  const now = clock.now();
  const tables = await db.all(
    `SELECT id, number, zone, min_capacity, max_capacity, active, join_only, pos_x, pos_y, shape
       FROM dining_tables WHERE deleted_at IS NULL ORDER BY join_only, zone, number`,
  );
  // Una reserva con mesas unidas aparece en cada una de sus mesas.
  const loaded = new Map();
  const get = async (rid) => {
    if (!loaded.has(rid)) {
      loaded.set(rid, await load(rid));
    }
    return loaded.get(rid);
  };
  const seated = new Map();
  for (const row of await db.all("SELECT reservation_id, table_id FROM table_blocks WHERE status = 'seated'")) {
    seated.set(row.table_id, await get(row.reservation_id));
  }
  const next = new Map();
  const upcoming = await db.all(
    `SELECT reservation_id, table_id FROM table_blocks
      WHERE status IN ('confirmed','pending_payment') AND start_at >= ? AND start_at < ?
      ORDER BY start_at`,
    [clock.sql(clock.plus(now, -60)), clock.sql(clock.addDays(clock.startOfDay(now), 1))],
  );
  for (const row of upcoming) {
    if (!next.has(row.table_id)) {
      next.set(row.table_id, await get(row.reservation_id));
    }
  }
  // RF-45: bloqueos en vigor ahora (NULL = todas las mesas).
  const holds = new Map();
  const active = await db.all(
    'SELECT table_id, reason, ends_at FROM table_holds WHERE starts_at <= ? AND ends_at > ? ORDER BY ends_at DESC',
    [clock.sql(now), clock.sql(now)],
  );
  for (const h of active) {
    const hold = { reason: h.reason, until: clock.hm(clock.at(h.ends_at)) };
    for (const tid of h.table_id === null ? tables.map((t) => t.id) : [h.table_id]) {
      holds.set(tid, hold);
    }
  }
  return tables.map((t) => {
    const current = seated.get(t.id) ?? null;
    let tableState = 'free';
    if (t.active !== true) {
      tableState = 'out_of_service';
    } else if (current !== null) {
      tableState = 'occupied';
    } else if (holds.has(t.id)) {
      tableState = 'blocked';
    }
    return {
      id: t.id,
      number: t.number,
      code: code(t),
      zone: t.zone,
      min_capacity: t.min_capacity,
      max_capacity: t.max_capacity,
      join_only: t.join_only, // extra: sin plano, solo para unir
      // Mesa unida a otra en una reserva en curso: el panel la muestra dentro de la principal.
      joined_to: current !== null && current.table_id !== t.id ? current.table_code : null,
      // Mapa: sin posición guardada, el panel coloca la mesa en una cuadrícula.
      pos_x: t.pos_x,
      pos_y: t.pos_y,
      shape: t.shape,
      state: tableState,
      hold: holds.get(t.id) ?? null,
      current: current !== null ? present.staff(current) : null,
      next: next.has(t.id) ? present.staff(next.get(t.id)) : null,
    };
  });
}

/**
 * Marca de cambios para que el panel sepa cuándo recargar sin recargar la
 * página (RF-34). Incluye los bloqueos y el minuto actual: un bloqueo que
 * empieza o una reserva que se acerca cambian la sala sin tocar la base de datos.
 */
export async function version() {
  const data = await db.value(
    `SELECT CONCAT(
        GREATEST(COALESCE((SELECT MAX(updated_at) FROM reservations), '2000-01-01'),
                 COALESCE((SELECT MAX(updated_at) FROM dining_tables), '2000-01-01')),
        '|', (SELECT COUNT(*) FROM table_holds), '|', COALESCE((SELECT MAX(id) FROM table_holds), 0),
        '|', (SELECT COUNT(*) FROM group_requests WHERE status = 'pending'), '|', COALESCE((SELECT MAX(id) FROM group_requests), 0))`,
  );
  return `${data}|${clock.hm(clock.now())}`;
}

// ---------------------------------------------------------------------------
// Administración de mesas (RF-35)
// ---------------------------------------------------------------------------

/**
 * Crea (id null) o modifica una mesa. Si una mesa se desactiva o deja de
 * admitir a alguna de sus reservas futuras, estas pasan a otra mesa
 * adecuada y, si no hay ninguna, se cancelan con aviso al titular (DP-04).
 */
export async function saveTable(id, input) {
  V.only(input, ['number', 'zone', 'min_capacity', 'max_capacity', 'active', 'join_only']);
  await markNoShows();
  return db.tx(async () => {
    const all = await db.all('SELECT * FROM dining_tables WHERE deleted_at IS NULL ORDER BY id FOR UPDATE');
    let current = null;
    if (id !== null) {
      current = all.find((t) => t.id === id) ?? null;
      if (current === null) {
        fail(404, 'not_found', 'Mesa no encontrada.');
      }
    }
    const pick = (key, validate, keep) => (V.has(input, key) ? validate(input[key]) : current !== null ? keep : validate(null));
    const number = pick('number', (v) => V.int(v, 'number', 1, 999), current?.number);
    const zone = pick('zone', (v) => V.text(v, 'zone', 1, 40), current?.zone);
    const min = pick('min_capacity', (v) => V.int(v, 'min_capacity', 1, 50), current?.min_capacity);
    const max = pick('max_capacity', (v) => V.int(v, 'max_capacity', 1, 50), current?.max_capacity);
    const active = V.has(input, 'active') ? V.bool(input.active, 'active') : (current ? current.active : true);
    const joinOnly = V.has(input, 'join_only') ? V.bool(input.join_only, 'join_only') : (current ? current.join_only : false);
    if (min > max) {
      V.invalid('min_capacity', 'La capacidad mínima no puede ser mayor que la máxima.');
    }
    const newCode = code({ zone, number });
    if (all.some((t) => code(t) === newCode && t.id !== id)) {
      fail(409, 'duplicate', `Ya existe la mesa ${newCode}. Las mesas se nombran con la inicial de la zona y el número.`);
    }

    if (current === null) {
      const newId = await db.insert(
        'INSERT INTO dining_tables (number, zone, min_capacity, max_capacity, active, join_only) VALUES (?, ?, ?, ?, ?, ?)',
        [number, zone, min, max, active, joinOnly],
      );
      return { table_id: newId, moved: 0, cancelled: 0 };
    }

    const changesUse = !active || min !== current.min_capacity || max !== current.max_capacity
      || joinOnly !== current.join_only;
    const seatedCount = await db.value("SELECT COUNT(*) FROM table_blocks WHERE table_id = ? AND status = 'seated'", [id]);
    if (seatedCount > 0 && changesUse) {
      fail(409, 'table_in_use', 'La mesa tiene una reserva en curso. Termínala antes de desactivarla o cambiar su capacidad.');
    }
    // Mesas de un grupo (principal o unida): no se recolocan solas.
    const joined = await db.value(
      `SELECT COUNT(*) FROM table_blocks tb
        WHERE tb.table_id = ? AND tb.status = 'confirmed'
          AND EXISTS (SELECT 1 FROM reservation_tables rt WHERE rt.reservation_id = tb.reservation_id)`,
      [id],
    );
    if (joined > 0 && changesUse) {
      fail(409, 'table_joined', 'La mesa forma parte de una reserva con mesas unidas. Sepárala o cambia la reserva de mesa antes.');
    }
    await db.exec(
      `UPDATE dining_tables SET number = ?, zone = ?, min_capacity = ?, max_capacity = ?, active = ?, join_only = ?,
              pos_x = CASE WHEN ?::boolean THEN NULL ELSE pos_x END, pos_y = CASE WHEN ?::boolean THEN NULL ELSE pos_y END
        WHERE id = ?`,
      [number, zone, min, max, active, joinOnly, joinOnly, joinOnly, id],
    );
    const [moved, cancelled] = await reaccommodate(id);
    return { table_id: id, moved, cancelled };
  });
}

/** Recoloca las reservas confirmadas que su mesa ya no puede atender. */
async function reaccommodate(tableId) {
  const t = await db.one('SELECT active, join_only, min_capacity, max_capacity FROM dining_tables WHERE id = ?', [tableId]);
  const rows = await db.all(
    "SELECT * FROM reservations WHERE table_id = ? AND status = 'confirmed' ORDER BY start_at FOR UPDATE",
    [tableId],
  );
  let moved = 0;
  let cancelled = 0;
  for (const r of rows) {
    const party = r.party_size;
    if (t.active && !t.join_only && party >= t.min_capacity && party <= t.max_capacity) {
      continue;
    }
    const other = await pickTable(party, clock.at(r.start_at), clock.at(r.end_at), r.id);
    if (other !== null && other.id !== tableId) {
      await db.exec('UPDATE reservations SET table_id = ? WHERE id = ?', [other.id, r.id]);
      moved++;
    } else {
      await restaurantCancel(r);
      cancelled++;
    }
  }
  return [moved, cancelled];
}

/**
 * Elimina una mesa. No se puede si tiene reservas pendientes o en curso
 * (hay que moverlas antes). Si nunca se ha usado se borra; si tiene
 * reservas antiguas, queda marcada como eliminada para conservar el
 * historial, y su código (p. ej. S-9) vuelve a quedar libre.
 */
export async function deleteTable(id) {
  await markNoShows();
  return db.tx(async () => {
    const t = await db.one('SELECT * FROM dining_tables WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id])
      ?? fail(404, 'not_found', 'Mesa no encontrada.');
    const pending = await db.all(
      `SELECT DISTINCT reservation_id FROM table_blocks
        WHERE table_id = ? AND reservation_id IS NOT NULL
          AND (status = 'seated' OR (status IN ('confirmed','pending_payment') AND end_at > ?))`,
      [id, clock.sql()],
    );
    if (pending.length > 0) {
      fail(409, 'table_in_use', `La mesa ${code(t)} tiene ${pending.length} reserva(s) pendiente(s) o en curso. `
        + 'Muévelas a otra mesa («Mesas…» en la agenda) o cancélalas antes de eliminarla.');
    }
    const used = await db.value(
      'SELECT 1 FROM reservations WHERE table_id = ? UNION SELECT 1 FROM reservation_tables WHERE table_id = ? LIMIT 1',
      [id, id],
    );
    if (used === null) {
      await db.exec('DELETE FROM dining_tables WHERE id = ?', [id]); // sus bloqueos se borran en cascada
    } else {
      await db.exec('DELETE FROM table_holds WHERE table_id = ?', [id]);
      await db.exec('UPDATE dining_tables SET deleted_at = ?, active = false, pos_x = NULL, pos_y = NULL WHERE id = ?', [clock.sql(), id]);
    }
    return { deleted: code(t) };
  });
}

/**
 * «Cerrar local»: termina todas las reservas en curso y deja libres todas
 * las mesas. Protegido con el PIN del restaurante (admin.checkClosePin).
 */
export async function closeLocal(staffUser, input) {
  V.only(input, ['pin']);
  await admin.checkClosePin(input.pin ?? null);
  const n = await db.tx(() => db.exec(
    "UPDATE reservations SET status = 'completed', completed_at = ? WHERE status = 'seated'",
    [clock.sql()],
  ));
  console.error(`MesaLista: «Cerrar local» por el usuario ${staffUser.id} (${n} reservas terminadas)`);
  return { completed: n };
}

// ---------------------------------------------------------------------------
// Cuentas de cliente (RF-05, RP-02)
// ---------------------------------------------------------------------------

/**
 * Elimina la cuenta: las reservas confirmadas pasan a «cancelada» y todas
 * se conservan sin datos personales.
 */
export async function deleteClient(user) {
  const userId = user.id;
  await db.tx(async () => {
    await db.value('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
    // RF-44: se devuelve la señal de las reservas que aún estaban en plazo de cancelación.
    const now = clock.now();
    const confirmed = await db.all(
      "SELECT id, start_at, change_deadline_h FROM reservations WHERE user_id = ? AND status = 'confirmed' FOR UPDATE",
      [userId],
    );
    for (const r of confirmed) {
      if (now <= clock.plus(clock.at(r.start_at), -60 * r.change_deadline_h)) {
        await payments.markRefund(r.id);
      }
    }
    await db.exec(
      `UPDATE reservations SET status = 'cancelled', cancelled_by = 'holder', cancelled_at = ?, payment_due_at = NULL
        WHERE user_id = ? AND status IN ('confirmed','pending_payment')`,
      [clock.sql(), userId],
    );
    await db.exec(
      `DELETE FROM reservation_menu_options rmo
        USING reservations r WHERE r.id = rmo.reservation_id AND r.user_id = ?`,
      [userId],
    );
    await db.exec(
      'UPDATE reservations SET note = NULL, guest_name = NULL, guest_phone = NULL, request_id = NULL WHERE user_id = ?',
      [userId],
    );
    await db.exec('DELETE FROM email_outbox WHERE to_email = ?', [user.email]);
    await db.exec('DELETE FROM users WHERE id = ?', [userId]); // sesiones, avisos e intentos en cascada
  });
}
