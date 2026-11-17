// Franjas de servicio, días cerrados y horas de inicio permitidas (RF-36, regla 3).

import * as db from './db.js';
import * as settings from './settings.js';
import { atMinutes, isoWeekday, ymd } from './clock.js';

export async function isClosed(day) {
  return (await db.value('SELECT 1 FROM closed_days WHERE day = ?', [ymd(day)])) !== null;
}

/**
 * Horas de inicio permitidas para una fecha, en minutos desde medianoche:
 * cada slot_step_min desde la apertura de cada franja hasta una duración de
 * reserva antes de su cierre. Un día cerrado no tiene ninguna.
 */
export async function startTimes(day, durationMin) {
  if (await isClosed(day)) {
    return [];
  }
  const step = await settings.get('slot_step_min');
  const slots = await db.all(
    'SELECT open_min, close_min FROM service_slots WHERE weekday = ? ORDER BY open_min',
    [isoWeekday(day)],
  );
  const times = new Set();
  for (const slot of slots) {
    for (let t = slot.open_min; t + durationMin <= slot.close_min; t += step) {
      times.add(t);
    }
  }
  return [...times].sort((a, b) => a - b);
}

/** Fecha y hora a partir de una fecha y minutos desde medianoche. */
export const at = atMinutes;

/** Minutos desde medianoche → "HH:MM" (1440 → "00:00"). */
export function hhmm(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
