// RF-46: ocupación por franja y porcentaje de reservas no presentadas de un
// periodo, para el administrador.
//
// Definiciones (las mismas que explica el panel):
//  - % no presentadas = no presentadas / reservas cuya hora ya llegó
//    (completadas, en curso o no presentadas). Sin clientes sin reserva.
//  - % canceladas = canceladas / todas las reservas (sin clientes sin reserva).
//  - Ocupación de un servicio = comensales sentados o previstos /
//    (plazas de las mesas activas × rotaciones que caben en el servicio ×
//    días de ese servicio en el periodo).

import * as db from './db.js';
import * as clock from './clock.js';
import * as settings from './settings.js';
import * as schedule from './schedule.js';
import * as V from './validate.js';

const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const STATUSES = ['confirmed', 'pending_payment', 'seated', 'completed', 'cancelled', 'no_show'];

/** Redondeo a un decimal (el de los porcentajes). */
const round1 = (x) => Math.round(x * 10) / 10;

/** Días enteros entre dos fechas a medianoche. */
const daysBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

export async function period(query) {
  const today = clock.startOfDay(clock.now());
  const to = query.to !== undefined ? V.date(query.to, 'to') : today;
  const from = query.from !== undefined ? V.date(query.from, 'from') : clock.addDays(to, -29);
  if (from > to) {
    V.invalid('from', 'La fecha inicial no puede ser posterior a la final.');
  }
  if (daysBetween(from, to) > 366) {
    V.invalid('from', 'El periodo puede tener como máximo un año.');
  }
  const start = clock.sql(from);
  const end = clock.sql(clock.addDays(to, 1));

  // Totales por estado y por origen.
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, { reservations: 0, people: 0 }]));
  const bySource = { app: 0, local: 0, walkin: 0 };
  const booked = { total: 0, cancelled: 0, arrived: 0, no_show: 0 };
  const rows = await db.all(
    `SELECT status, source, COUNT(*) AS n, SUM(party_size) AS people
       FROM reservations WHERE start_at >= ? AND start_at < ? GROUP BY status, source`,
    [start, end],
  );
  for (const r of rows) {
    byStatus[r.status].reservations += r.n;
    byStatus[r.status].people += r.people;
    if (r.status !== 'cancelled') {
      bySource[r.source] += r.n;
    }
    if (r.source === 'walkin') {
      continue;
    }
    booked.total += r.n;
    if (r.status === 'cancelled') {
      booked.cancelled += r.n;
    }
    if (['completed', 'seated', 'no_show'].includes(r.status)) {
      booked.arrived += r.n;
    }
    if (r.status === 'no_show') {
      booked.no_show += r.n;
    }
  }

  // Por día y por hora de inicio (sin canceladas).
  const byDay = new Map();
  for (let d = from; d <= to; d = clock.addDays(d, 1)) {
    byDay.set(clock.ymd(d), { date: clock.ymd(d), reservations: 0, people: 0 });
  }
  const daily = await db.all(
    `SELECT start_at::date AS d, COUNT(*) AS n, SUM(party_size) AS people FROM reservations
      WHERE start_at >= ? AND start_at < ? AND status <> 'cancelled' GROUP BY start_at::date`,
    [start, end],
  );
  for (const r of daily) {
    const entry = byDay.get(r.d);
    if (entry) {
      entry.reservations = r.n;
      entry.people = r.people;
    }
  }
  const byHour = (await db.all(
    `SELECT to_char(start_at, 'HH24:MI') AS t, COUNT(*) AS n, SUM(party_size) AS people FROM reservations
      WHERE start_at >= ? AND start_at < ? AND status <> 'cancelled' GROUP BY t ORDER BY t`,
    [start, end],
  )).map((r) => ({ time: r.t.slice(0, 5), reservations: r.n, people: r.people }));

  // Comensales sentados o previstos: sin canceladas ni no presentadas.
  const people = Object.entries(byStatus)
    .filter(([s]) => s !== 'cancelled' && s !== 'no_show')
    .reduce((acc, [, v]) => acc + v.people, 0);

  return {
    from: clock.ymd(from),
    to: clock.ymd(to),
    by_status: byStatus,
    by_source: bySource,
    reservations: booked.total - booked.cancelled + bySource.walkin,
    people,
    no_show_rate: booked.arrived > 0 ? round1((100 * booked.no_show) / booked.arrived) : null,
    cancel_rate: booked.total > 0 ? round1((100 * booked.cancelled) / booked.total) : null,
    by_day: [...byDay.values()],
    by_hour: byHour,
    by_service: await services(from, to, start, end),
  };
}

/** Ocupación de cada franja de servicio (día de la semana y horario). */
async function services(from, to, start, end) {
  const seats = await db.value('SELECT COALESCE(SUM(max_capacity), 0) FROM dining_tables WHERE active AND NOT join_only');
  const duration = await settings.get('duration_min');
  const closed = new Set((await db.all(
    'SELECT day FROM closed_days WHERE day >= ? AND day <= ?', [clock.ymd(from), clock.ymd(to)],
  )).map((r) => r.day));
  const daysPerWeekday = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let d = from; d <= to; d = clock.addDays(d, 1)) {
    if (!closed.has(clock.ymd(d))) {
      daysPerWeekday[clock.isoWeekday(d)]++;
    }
  }
  const rows = await db.all(
    `SELECT s.id, s.weekday, s.open_min, s.close_min, COUNT(r.id) AS n, COALESCE(SUM(r.party_size), 0) AS people
       FROM service_slots s
       LEFT JOIN reservations r
         ON EXTRACT(ISODOW FROM r.start_at) = s.weekday
        AND EXTRACT(HOUR FROM r.start_at) * 60 + EXTRACT(MINUTE FROM r.start_at) >= s.open_min
        AND EXTRACT(HOUR FROM r.start_at) * 60 + EXTRACT(MINUTE FROM r.start_at) <  s.close_min
        AND r.start_at >= ? AND r.start_at < ?
        AND r.status IN ('confirmed','seated','completed')
      GROUP BY s.id, s.weekday, s.open_min, s.close_min
      ORDER BY s.weekday, s.open_min`,
    [start, end],
  );
  return rows.map((s) => {
    const rotations = Math.max(1, Math.floor((s.close_min - s.open_min) / duration));
    const count = daysPerWeekday[s.weekday];
    const capacity = seats * rotations * count;
    return {
      weekday: s.weekday,
      day: DAYS[s.weekday - 1],
      slot: `${schedule.hhmm(s.open_min)}–${schedule.hhmm(s.close_min)}`,
      services: count,
      rotations,
      reservations: s.n,
      people: s.people,
      capacity,
      occupancy: capacity > 0 ? round1((100 * s.people) / capacity) : null,
    };
  });
}
