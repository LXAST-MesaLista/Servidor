// Contenido de los QR y códigos de reserva (RF-18, RF-29, RS-07, RS-12).
//
// El QR lleva "ML1.<id>.<versión>.<firma>", donde la firma es un HMAC-SHA256
// con la clave del servidor. Un QR alterado o fabricado fuera del sistema no
// tiene una firma válida, y uno anterior a una modificación o a una
// vinculación tiene una versión que ya no es la vigente.

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import * as V from './validate.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I
export const CODE_LENGTH = 10;
const QR_RE = /^ML1\.([1-9][0-9]{0,9})\.([1-9][0-9]{0,9})\.([A-Za-z0-9_-]{22})$/;
const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

function sign(id, version) {
  const secret = String(config('qr_secret', ''));
  if (secret.length < 32 || secret === 'CAMBIAR') {
    throw new Error('qr_secret no está configurado');
  }
  const mac = createHmac('sha256', secret).update(`reservation:${id}:${version}`).digest();
  return mac.subarray(0, 16).toString('base64url');
}

export function make(reservationId, version) {
  return `ML1.${reservationId}.${version}.${sign(reservationId, version)}`;
}

/** [id, versión] si la firma es válida; null en caso contrario. */
export function parse(content) {
  const m = QR_RE.exec(content);
  if (!m) {
    return null;
  }
  const id = Number(m[1]);
  const version = Number(m[2]);
  const expected = Buffer.from(sign(id, version));
  const given = Buffer.from(m[3]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  return [id, version];
}

/** Código de reserva aleatorio de 10 caracteres (unos 50 bits). */
export function newCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

export function normalizeCode(v) {
  if (typeof v !== 'string') {
    V.invalid('code', 'El código de reserva no es válido.');
  }
  const code = v.replace(/[\s-]/g, '').toUpperCase();
  if (!CODE_RE.test(code)) {
    V.invalid('code', 'El código de reserva debe tener 10 caracteres.');
  }
  return code;
}
