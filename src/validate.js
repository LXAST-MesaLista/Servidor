// Validación de tipo, rango y longitud de los datos recibidos (RS-08).
// Cualquier dato incorrecto termina la petición con 422 antes de tocar la
// base de datos.

import { fail } from './http.js';

export const MAX_ID = 2147483647;

export function invalid(field, message) {
  fail(422, 'invalid', message, { field });
}

/** Entero (o texto con un entero) entre min y max. */
export function int(v, field, min, max) {
  if (typeof v === 'string' && /^-?[0-9]{1,9}$/.test(v)) {
    v = Number(v);
  }
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    invalid(field, `El campo «${field}» debe ser un número entero.`);
  }
  if (v < min || v > max) {
    invalid(field, `El campo «${field}» debe estar entre ${min} y ${max}.`);
  }
  return v;
}

export function bool(v, field) {
  if (typeof v !== 'boolean') {
    invalid(field, `El campo «${field}» debe ser verdadero o falso.`);
  }
  return v;
}

/** Quita espacios, tabuladores, saltos de línea y NUL de los extremos. */
const trim = (s) => s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');

/** Longitud en caracteres (puntos de código), no en unidades UTF-16. */
export const length = (s) => [...s].length;

/** Recorta un texto a n caracteres. */
export const cut = (s, n) => [...s].slice(0, n).join('');

/** Texto libre: sin caracteres de control salvo saltos de línea con multiline. */
export function text(v, field, min, max, multiline = false) {
  if (typeof v !== 'string') {
    invalid(field, `El campo «${field}» debe ser un texto.`);
  }
  v = trim(v.replaceAll('\r\n', '\n'));
  if (!v.isWellFormed()) {
    invalid(field, `El campo «${field}» no es UTF-8 válido.`);
  }
  const control = multiline ? /[\x00-\x09\x0B-\x1F\x7F]/ : /[\x00-\x1F\x7F]/;
  if (control.test(v)) {
    invalid(field, `El campo «${field}» contiene caracteres no permitidos.`);
  }
  const len = length(v);
  if (len < min || len > max) {
    invalid(field, min > 0
      ? `El campo «${field}» debe tener entre ${min} y ${max} caracteres.`
      : `El campo «${field}» admite como máximo ${max} caracteres.`);
  }
  return v;
}

/** Nombre de persona: letras, espacios, apóstrofo, punto y guion. */
export function name(v, field = 'name') {
  v = text(v, field, 2, 80);
  if (!/^[\p{L}\p{M}' .-]+$/u.test(v)) {
    invalid(field, 'El nombre solo puede contener letras, espacios, apóstrofos, puntos y guiones.');
  }
  return v.replace(/\s+/gu, ' ');
}

// Dirección de correo: parte local de átomos separados por puntos y un dominio
// con al menos dos etiquetas (letras, cifras y guiones).
const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isEmail(v) {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v.toLowerCase())
    && v.split('@')[0].length <= 64;
}

export function email(v) {
  v = text(v, 'email', 3, 254).toLowerCase();
  if (!isEmail(v)) {
    invalid('email', 'El correo electrónico no es válido.');
  }
  return v;
}

/** Teléfono: se guarda solo con dígitos y un «+» inicial opcional. */
export function phone(v, field = 'phone') {
  v = text(v, field, 9, 25);
  if (!/^\+?[0-9 ().-]+$/.test(v)) {
    invalid(field, 'El teléfono solo puede contener dígitos, espacios, guiones y un «+» inicial.');
  }
  const normalized = (v.startsWith('+') ? '+' : '') + v.replace(/\D/g, '');
  const digits = normalized.replace(/^\+/, '').length;
  if (digits < 9 || digits > 15) {
    invalid(field, 'El teléfono debe tener entre 9 y 15 dígitos.');
  }
  return normalized;
}

/** Fecha "AAAA-MM-DD" válida en el calendario → Date a medianoche. */
export function date(v, field = 'date') {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    invalid(field, 'La fecha debe tener el formato AAAA-MM-DD.');
  }
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  if (t.getFullYear() !== y || t.getMonth() !== m - 1 || t.getDate() !== d) {
    invalid(field, 'La fecha no existe.');
  }
  return t;
}

/** Hora "HH:MM" → minutos desde medianoche. */
export function time(v, field = 'time') {
  const m = typeof v === 'string' ? /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(v) : null;
  if (!m) {
    invalid(field, 'La hora debe tener el formato HH:MM.');
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Lista de identificadores enteros positivos sin repetir. */
export function idList(v, field, maxCount) {
  if (!Array.isArray(v) || v.length > maxCount) {
    invalid(field, `El campo «${field}» debe ser una lista de hasta ${maxCount} elementos.`);
  }
  const ids = v.map((item) => int(item, field, 1, MAX_ID));
  if (new Set(ids).size !== ids.length) {
    invalid(field, `El campo «${field}» tiene elementos repetidos.`);
  }
  return ids;
}

export function uuid(v, field = 'request_id') {
  if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) {
    invalid(field, 'Identificador de solicitud no válido.');
  }
  return v;
}

/** Comprueba que el cuerpo no trae campos desconocidos. */
export function only(body, allowed) {
  const unknown = Object.keys(body).find((k) => !allowed.includes(k));
  if (unknown !== undefined) {
    invalid(unknown, `Campo no permitido: «${unknown}».`);
  }
}

/** ¿Trae el cuerpo ese campo (aunque sea null)? */
export const has = (body, key) => Object.hasOwn(body, key);

/** Objeto JSON (no lista ni null). */
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
