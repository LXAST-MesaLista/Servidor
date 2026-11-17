// Hora del servidor (zona de Madrid), fija durante toda la petición.
// Todas las comprobaciones de tiempo pasan por aquí (regla 2).
//
// En las pruebas, con "test_clock" activado, la cabecera X-Test-Now
// ("2026-11-07 20:50:00") simula otra hora.
//
// Las fechas son objetos Date en hora local (TZ = Europe/Madrid) y nunca se
// modifican: cada operación devuelve otro. En la base de datos van como texto
// "AAAA-MM-DD HH:MM:SS" (timestamp sin zona).

import { config } from './config.js';
import { state } from './context.js';

const SQL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Hora actual de la petición, sin milisegundos. */
export function now() {
  const s = state();
  if (s.now === null) {
    let t = new Date();
    const simulated = s.req?.headers['x-test-now'];
    if (typeof simulated === 'string' && config('test_clock') === true
      && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(simulated)) {
      const parsed = parse(simulated);
      if (parsed !== null) {
        t = parsed;
      }
    }
    t.setMilliseconds(0);
    s.now = t;
  }
  return s.now;
}

/** Fija la hora (scripts de línea de órdenes y pruebas). */
export function setNow(t) {
  state().now = t;
}

/** "AAAA-MM-DD HH:MM:SS" o "AAAA-MM-DD" → Date (hora local), o null. */
export function parse(text) {
  const m = SQL_RE.exec(String(text));
  if (!m) {
    return null;
  }
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

/** Como parse, pero un valor que no es una fecha es un error del programa. */
export function at(text) {
  const d = parse(text);
  if (d === null) {
    throw new Error(`fecha no válida: ${text}`);
  }
  return d;
}

/** Date → "AAAA-MM-DD HH:MM:SS" (por defecto, la hora actual). */
export function sql(t = now()) {
  return `${ymd(t)} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
}

/** t + minutos (pueden ser negativos), en tiempo transcurrido. */
export function plus(t, minutes) {
  return new Date(t.getTime() + minutes * 60_000);
}

/** t + días, conservando la hora del reloj (como «+1 day»). */
export function addDays(t, days) {
  return new Date(t.getFullYear(), t.getMonth(), t.getDate() + days,
    t.getHours(), t.getMinutes(), t.getSeconds());
}

/** Medianoche del día de t. */
export function startOfDay(t) {
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}

/** Fecha y hora a partir de un día y minutos desde medianoche (1440 = 00:00 del siguiente). */
export function atMinutes(day, minutes) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
}

/** Minutos desde medianoche de t. */
export function minutesOf(t) {
  return t.getHours() * 60 + t.getMinutes();
}

/** Día de la semana ISO: 1 = lunes … 7 = domingo. */
export function isoWeekday(t) {
  return t.getDay() === 0 ? 7 : t.getDay();
}

export const ymd = (t) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
export const hm = (t) => `${pad(t.getHours())}:${pad(t.getMinutes())}`;
export const dmy = (t) => `${pad(t.getDate())}/${pad(t.getMonth() + 1)}/${t.getFullYear()}`;
export const ymdhm = (t) => `${ymd(t)} ${hm(t)}`;

/** ISO 8601 con el desfase de Madrid: 2026-11-07T21:00:00+01:00. */
export function atom(t) {
  const off = -t.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${ymd(t)}T${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Segundos enteros entre dos fechas (b − a). */
export function secondsBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / 1000);
}

/** Minutos enteros entre dos fechas (b − a). */
export function minutesBetween(a, b) {
  return Math.trunc((b.getTime() - a.getTime()) / 60_000);
}

/** La más temprana / la más tardía de varias fechas. */
export const min = (...ts) => ts.reduce((a, b) => (b.getTime() < a.getTime() ? b : a));
export const max = (...ts) => ts.reduce((a, b) => (b.getTime() > a.getTime() ? b : a));
