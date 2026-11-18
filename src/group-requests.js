// RF-43: los grupos de más comensales que el máximo (10) envían una solicitud
// desde la app; el personal la acepta (eligiendo mesas, booking.acceptGroup)
// o la rechaza. Aceptada con señal (RF-44), la reserva queda «pendiente de pago».

import * as db from './db.js';
import * as clock from './clock.js';
import * as settings from './settings.js';
import * as schedule from './schedule.js';
import * as V from './validate.js';
import * as mail from './mail.js';
import * as push from './push.js';
import { fail } from './http.js';

const MAX_PENDING = 3;

/** Horas que se pueden pedir para una fecha (las de inicio permitidas, sin mirar mesas). */
export async function times(day) {
  const now = clock.now();
  const earliest = clock.plus(now, await settings.get('min_advance_min'));
  const latest = clock.addDays(now, await settings.get('max_advance_days'));
  const out = [];
  for (const t of await schedule.startTimes(day, await settings.get('duration_min'))) {
    const s = schedule.at(day, t);
    if (s >= earliest && s <= latest) {
      out.push(schedule.hhmm(t));
    }
  }
  return out;
}

function present(g) {
  return {
    id: g.id,
    date: g.day,
    time: schedule.hhmm(g.time_min),
    party: g.party_size,
    note: g.note,
    status: g.status,
    reply: g.reply,
    reservation_id: g.reservation_id,
    created_at: g.created_at.slice(0, 16),
  };
}

export async function create(user, input) {
  V.only(input, ['date', 'time', 'party', 'note', 'consent']);
  const day = V.date(input.date ?? null);
  const minutes = V.time(input.time ?? null);
  const min = (await settings.get('max_party')) + 1;
  const max = await settings.get('max_group_party');
  const party = V.int(input.party ?? null, 'party', min, Math.max(min, max));
  const consent = V.has(input, 'consent') && V.bool(input.consent, 'consent');
  let note = null;
  if (V.has(input, 'note') && input.note !== null) {
    note = V.text(input.note, 'note', 0, 200, true);
    note = note === '' ? null : note;
  }
  if (!consent) {
    note = null; // RP-04: sin consentimiento no se guarda la nota
  }
  if (!(await times(day)).includes(schedule.hhmm(minutes))) {
    fail(422, 'invalid_time', 'Esa hora no se puede pedir: el restaurante está cerrado, ya ha pasado o falta demasiado.', { field: 'time' });
  }
  const pending = await db.value("SELECT COUNT(*) FROM group_requests WHERE user_id = ? AND status = 'pending'", [user.id]);
  if (pending >= MAX_PENDING) {
    fail(409, 'limit', `Ya tienes ${MAX_PENDING} solicitudes de grupo pendientes. Espera a que el restaurante responda.`);
  }
  await db.exec(
    'INSERT INTO group_requests (user_id, day, time_min, party_size, note, consent_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [user.id, clock.ymd(day), minutes, party, note, note !== null ? clock.sql() : null, clock.sql()],
  );
  return forClient(user.id);
}

/**
 * Solicitudes del cliente aún vigentes: las pendientes y las que el
 * restaurante ha decidido en los últimos 30 días. Las que el propio cliente
 * ha cancelado desaparecen de la lista en cuanto las cancela.
 */
export async function forClient(userId) {
  const rows = await db.all(
    `SELECT * FROM group_requests WHERE user_id = ?
        AND status <> 'cancelled'
        AND (status = 'pending' OR created_at > ?)
      ORDER BY status = 'pending' DESC, day, time_min`,
    [userId, clock.sql(clock.addDays(clock.now(), -30))],
  );
  return rows.map(present);
}

export async function cancelOwn(user, id) {
  const n = await db.exec(
    "UPDATE group_requests SET status = 'cancelled', decided_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'",
    [clock.sql(), id, user.id],
  );
  if (n === 0 && (await db.value('SELECT 1 FROM group_requests WHERE id = ? AND user_id = ?', [id, user.id])) === null) {
    fail(404, 'not_found', 'Solicitud no encontrada.');
  }
  return forClient(user.id);
}

/** El personal rechaza una solicitud indicando el motivo (se envía al cliente). */
export async function reject(staffId, id, input) {
  V.only(input, ['reply']);
  const reply = V.text(input.reply ?? null, 'reply', 1, 200, true);
  await db.tx(async () => {
    const g = await db.one('SELECT * FROM group_requests WHERE id = ? FOR UPDATE', [id]);
    if (g === null) {
      fail(404, 'not_found', 'Solicitud no encontrada.');
    }
    if (g.status !== 'pending') {
      fail(409, 'not_pending', 'Esta solicitud ya está respondida o cancelada.');
    }
    await db.exec("UPDATE group_requests SET status = 'rejected', reply = ?, decided_by = ?, decided_at = ? WHERE id = ?",
      [reply, staffId, clock.sql(), id]);
    if (g.user_id === null) {
      return;
    }
    const start = schedule.at(clock.at(g.day), g.time_min);
    await db.exec('INSERT INTO notifications (user_id, reservation_id, message, created_at) VALUES (?, NULL, ?, ?)', [
      g.user_id,
      V.cut(`El restaurante no puede atender tu grupo del ${clock.dmy(start)} a las ${clock.hm(start)}: ${reply}`, 255),
      clock.sql(),
    ]);
    const u = await db.one('SELECT name, email FROM users WHERE id = ?', [g.user_id]);
    await mail.queue(u.email, 'Solicitud de grupo no aceptada',
      `Hola, ${u.name}:\n\nLo sentimos: el restaurante no puede atender tu solicitud de grupo de `
      + `${g.party_size} comensales para el ${mail.when(start)}.\n\n`
      + `Motivo: ${reply}\n\nPuedes enviar otra solicitud para otra fecha desde la app MesaLista.\n`);
    await push.queueForEmail(u.email, 'Solicitud de grupo no aceptada',
      `${g.party_size} comensales · ${push.capitalize(mail.when(start))}`, { type: 'group_rejected' });
  });
}

/**
 * Para el panel: pendientes primero y las demás de los últimos 30 días,
 * también las que ha cancelado el cliente (antes o después de aceptarlas),
 * para que el personal sepa que ya no vienen.
 */
export async function forStaff() {
  const rows = await db.all(
    `SELECT g.*, u.name AS user_name, u.phone AS user_phone, u.email AS user_email
       FROM group_requests g LEFT JOIN users u ON u.id = g.user_id
      WHERE g.status = 'pending' OR g.created_at > ?
      ORDER BY g.status = 'pending' DESC, g.day, g.time_min`,
    [clock.sql(clock.addDays(clock.now(), -30))],
  );
  return rows.map((g) => ({ ...present(g), name: g.user_name, phone: g.user_phone, email: g.user_email }));
}
