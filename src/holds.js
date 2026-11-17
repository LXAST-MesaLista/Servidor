// RF-45: bloqueo de mesas o franjas por un evento privado o una avería.
//
// Un bloqueo ocupa una mesa (o todas) durante un intervalo y aparece en la
// vista table_blocks con estado 'hold': la disponibilidad, los clientes sin
// reserva y el cambio o la unión de mesas lo tienen en cuenta sin más código.
// No se crea si alguna reserva confirmada o en curso usa esas mesas en ese
// intervalo: primero hay que moverla o cancelarla.

import * as db from './db.js';
import * as clock from './clock.js';
import * as schedule from './schedule.js';
import * as V from './validate.js';
import { code, load } from './booking.js';
import { fail } from './http.js';

function present(h) {
  const start = clock.at(h.starts_at);
  const end = clock.at(h.ends_at);
  const now = clock.now();
  return {
    id: h.id,
    table: h.table_id === null ? null : code(h), // S-1…; null: todas
    date: clock.ymd(start),
    from: clock.hm(start),
    to: clock.hm(end),
    until: clock.ymdhm(end),
    reason: h.reason,
    active: start <= now && now < end,
  };
}

/** Bloqueos que no han terminado, del más próximo al más lejano. */
export async function upcoming() {
  const rows = await db.all(
    `SELECT h.*, t.number, t.zone FROM table_holds h LEFT JOIN dining_tables t ON t.id = h.table_id
      WHERE h.ends_at > ? ORDER BY h.starts_at, t.zone, t.number`,
    [clock.sql()],
  );
  return rows.map(present);
}

/** Bloqueos que afectan a una fecha (para la agenda). */
export async function forDate(day) {
  const from = clock.startOfDay(day);
  const rows = await db.all(
    `SELECT h.*, t.number, t.zone FROM table_holds h LEFT JOIN dining_tables t ON t.id = h.table_id
      WHERE h.starts_at < ? AND h.ends_at > ? ORDER BY h.starts_at, t.zone, t.number`,
    [clock.sql(clock.addDays(from, 1)), clock.sql(from)],
  );
  return rows.map(present);
}

/**
 * Crea el bloqueo. Datos: date, from y to ("HH:MM"; to "00:00" = medianoche),
 * reason, y table_ids (lista) o all = true para todas las mesas.
 */
export async function create(staffId, input) {
  V.only(input, ['date', 'from', 'to', 'reason', 'table_ids', 'all']);
  const day = V.date(input.date ?? null);
  const from = V.time(input.from ?? null, 'from');
  let to = V.time(input.to ?? null, 'to');
  if (to === 0) {
    to = 1440;
  }
  if (from >= to) {
    V.invalid('to', 'El bloqueo debe terminar después de empezar.');
  }
  const reason = V.text(input.reason ?? null, 'reason', 2, 120);
  const all = V.has(input, 'all') && V.bool(input.all, 'all');
  const ids = all ? [] : V.idList(input.table_ids ?? null, 'table_ids', 100);
  if (!all && ids.length === 0) {
    V.invalid('table_ids', 'Elige al menos una mesa o «todas las mesas».');
  }
  const start = schedule.at(day, from);
  const end = schedule.at(day, to);
  if (end <= clock.now()) {
    V.invalid('to', 'Ese intervalo ya ha pasado.');
  }

  return db.tx(async () => {
    // Mismo bloqueo de filas que las reservas: nadie reserva esas mesas mientras tanto.
    const tables = new Map();
    for (const t of await db.all('SELECT id, number, zone FROM dining_tables WHERE deleted_at IS NULL ORDER BY id FOR UPDATE')) {
      tables.set(t.id, code(t));
    }
    for (const id of ids) {
      if (!tables.has(id)) {
        fail(404, 'table_not_found', 'Alguna de esas mesas no existe.');
      }
    }
    const affected = all ? [...tables.keys()] : ids;
    const clash = await db.all(
      `SELECT DISTINCT reservation_id FROM table_blocks
        WHERE table_id = ANY(?::int[])
          AND status IN ('confirmed','seated')
          AND block_start < ? AND end_at > ?`,
      [affected, clock.sql(end), clock.sql(start)],
    );
    if (clash.length > 0) {
      const list = [];
      for (const row of clash) {
        const r = await load(row.reservation_id);
        const who = r.guest_name ?? r.user_name ?? 'sin nombre';
        list.push(`${clock.hm(clock.at(r.start_at))} · mesa ${r.table_codes.join('+')} · ${who}`);
      }
      fail(409, 'reservations_in_hold',
        `Hay reservas en esas mesas durante el bloqueo. Muévelas o cancélalas antes: ${list.join('; ')}.`,
        { reservations: clash.map((row) => row.reservation_id) });
    }
    const now = clock.sql();
    for (const id of all ? [null] : ids) {
      await db.exec(
        'INSERT INTO table_holds (table_id, starts_at, ends_at, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, clock.sql(start), clock.sql(end), reason, staffId, now],
      );
    }
    return upcoming();
  });
}

export async function remove(id) {
  if ((await db.exec('DELETE FROM table_holds WHERE id = ?', [id])) === 0) {
    fail(404, 'not_found', 'Bloqueo no encontrado.');
  }
  return upcoming();
}
