// Avisos push en la app con Firebase Cloud Messaging (API HTTP v1).
//
// Cada cambio que envía un correo de reserva (mail.queueReservation) o el de
// grupo no aceptado envía también un aviso push a cada dispositivo que el
// cliente ha registrado con POST /me/devices. Como los correos, los avisos se
// guardan en push_outbox dentro de la transacción del cambio y se envían
// después de responder (o desde bin/worker.js cada minuto). Solo llevan el
// asunto, la fecha, la hora y los comensales: nunca el QR, las opciones de
// menú ni la nota.
//
// El servidor se identifica ante Google con la cuenta de servicio del proyecto
// de Firebase (config.json, «fcm»): firma un JWT con su clave privada (RS256),
// lo cambia por un token de acceso OAuth 2.0 y llama con él a
// POST /v1/projects/<proyecto>/messages:send. Sin cuenta de servicio, los
// avisos esperan en la cola y a la hora se descartan.

import { createHash, createPrivateKey, createSign, randomBytes } from 'node:crypto';
import * as db from './db.js';
import * as clock from './clock.js';
import * as V from './validate.js';
import { config } from './config.js';
import { state } from './context.js';
import { when, people } from './mail.js';

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const API = 'https://fcm.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const MAX_AGE_MIN = 60;
const MAX_ATTEMPTS = 5;

/** FCM ya no conoce el dispositivo (404 UNREGISTERED): se borra. */
export class PushGone extends Error {}

/** Límite de FCM o servicio no disponible (429, 5xx): se reintenta sin gastar intentos. */
export class PushThrottled extends Error {}

// Token de acceso de Google en memoria, válido para una cuenta de servicio concreta.
let access = null; // { key, token, expires }

// ---------------------------------------------------------------------------
// Dispositivos
// ---------------------------------------------------------------------------

function deviceToken(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9:_.-]{20,512}$/.test(v)) {
    V.invalid('token', 'El token del dispositivo no es válido.');
  }
  return v;
}

/**
 * Registra el dispositivo del cliente (la app lo hace al abrirse y cuando
 * FCM le da un token nuevo). Si el token era de otra cuenta, pasa a esta y
 * se descartan los avisos que tenía pendientes. Devuelve true si es nuevo.
 */
export async function register(user, input) {
  V.only(input, ['token', 'platform']);
  const token = deviceToken(input.token ?? null);
  const platform = input.platform ?? null;
  if (!['android', 'ios'].includes(platform)) {
    V.invalid('platform', 'Debe ser «android» o «ios».');
  }
  return db.tx(async () => {
    const now = clock.sql();
    const row = await db.one('SELECT id, user_id FROM push_devices WHERE token = ? FOR UPDATE', [token]);
    if (row === null) {
      await db.exec(
        'INSERT INTO push_devices (user_id, token, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
        [user.id, token, platform, now, now],
      );
      return true;
    }
    if (row.user_id !== user.id) {
      await db.exec('DELETE FROM push_outbox WHERE device_id = ?', [row.id]);
    }
    await db.exec('UPDATE push_devices SET user_id = ?, platform = ?, last_seen_at = ? WHERE id = ?',
      [user.id, platform, now, row.id]);
    return false;
  });
}

/** El cliente deja de recibir avisos en ese dispositivo (p. ej. al cerrar sesión en la app). */
export async function unregister(user, input) {
  V.only(input, ['token']);
  await db.exec('DELETE FROM push_devices WHERE token = ? AND user_id = ?', [deviceToken(input.token ?? null), user.id]);
}

// ---------------------------------------------------------------------------
// Cola
// ---------------------------------------------------------------------------

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Aviso de un cambio de reserva; lo llama mail.queueReservation con el mismo asunto. */
export async function queueReservation(event, email, reservation, title) {
  const body = `${capitalize(when(clock.at(reservation.start_at)))} · ${people(Number(reservation.party_size))}`;
  const data = { type: event };
  if (reservation.id !== undefined && reservation.id !== null) {
    data.reservation_id = String(reservation.id);
  }
  await queueForEmail(email, title, body, data);
}

/** Aviso para todos los dispositivos del cliente con ese correo (si tiene alguno). */
export async function queueForEmail(email, title, body, data = {}) {
  const strings = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
  const n = await db.exec(
    `INSERT INTO push_outbox (device_id, title, body, data, created_at)
     SELECT d.id, ?, ?, ?::jsonb, ? FROM push_devices d JOIN users u ON u.id = d.user_id
      WHERE u.email = ? AND u.role = 'client'
      ORDER BY d.id`,
    [V.cut(title, 150), V.cut(body, 255), JSON.stringify(strings), clock.sql(), email],
  );
  if (n > 0) {
    state().pushQueued = true;
  }
}

export { capitalize };

// ---------------------------------------------------------------------------
// Envío
// ---------------------------------------------------------------------------

export function configured() {
  const c = config('fcm');
  return c !== null && typeof c === 'object' && c.enabled === true && (c.project_id ?? '') !== ''
    && (c.client_email ?? '') !== '' && (c.private_key ?? '') !== '';
}

/** Envía los avisos pendientes. Devuelve cuántos se han enviado. */
export async function flush(limit = 50) {
  if (!configured()) {
    return 0;
  }
  // Un aviso de hace más de una hora ya no sirve: se descarta sin enviarlo.
  await db.exec('DELETE FROM push_outbox WHERE created_at < ?', [clock.sql(clock.plus(clock.now(), -MAX_AGE_MIN))]);
  const claim = randomBytes(16).toString('hex');
  await db.exec(
    `UPDATE push_outbox SET claim = ?, claimed_at = LOCALTIMESTAMP(0)
      WHERE id IN (SELECT id FROM push_outbox
                    WHERE attempts < ? AND (claim IS NULL OR claimed_at < LOCALTIMESTAMP - interval '5 minutes')
                    ORDER BY id LIMIT ${Math.max(1, limit)}
                    FOR UPDATE SKIP LOCKED)`,
    [claim, MAX_ATTEMPTS],
  );
  const rows = await db.all(
    `SELECT o.id, o.device_id, o.title, o.body, o.data, d.token
       FROM push_outbox o JOIN push_devices d ON d.id = o.device_id
      WHERE o.claim = ? ORDER BY o.id`,
    [claim],
  );
  if (rows.length === 0) {
    return 0;
  }
  try {
    await accessToken();
  } catch (e) {
    // Sin token de acceso no se puede enviar ninguno: todos gastan un intento.
    await db.exec('UPDATE push_outbox SET attempts = attempts + 1, claim = NULL, last_error = ? WHERE claim = ?',
      [V.cut(e.message, 255), claim]);
    return 0;
  }
  let sent = 0;
  for (const r of rows) {
    try {
      await send(r.token, r.title, r.body, r.data ?? {});
      await db.exec('DELETE FROM push_outbox WHERE id = ?', [r.id]);
      sent++;
    } catch (e) {
      if (e instanceof PushGone) {
        // FCM ya no conoce el dispositivo (app desinstalada o token caducado): se olvida.
        await db.exec('DELETE FROM push_devices WHERE id = ?', [r.device_id]);
      } else if (e instanceof PushThrottled) {
        // Límite de FCM o servicio caído: el resto vuelve a la cola sin gastar intentos.
        await db.exec('UPDATE push_outbox SET claim = NULL, last_error = ? WHERE claim = ?', [V.cut(e.message, 255), claim]);
        break;
      } else {
        await db.exec('UPDATE push_outbox SET attempts = attempts + 1, claim = NULL, last_error = ? WHERE id = ?',
          [V.cut(e.message, 255), r.id]);
      }
    }
  }
  return sent;
}

/** Envía un aviso a un dispositivo. Lanza PushGone, PushThrottled u otro error. */
export async function send(deviceTokenValue, title, body, data = {}) {
  const c = config('fcm');
  const url = `${API}/v1/projects/${encodeURIComponent(String(c.project_id))}/messages:send`;
  const payload = {
    message: {
      token: deviceTokenValue,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high' },
    },
  };
  const token = await accessToken();
  const [status, raw] = await post(url, JSON.stringify(payload),
    { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
  if (status === 200) {
    return;
  }
  let error = {};
  try {
    error = JSON.parse(raw).error ?? {};
  } catch {
    // sin cuerpo JSON
  }
  let code = '';
  for (const d of Array.isArray(error.details) ? error.details : []) {
    if (d !== null && typeof d === 'object' && typeof d.errorCode === 'string') {
      code = d.errorCode;
    }
  }
  const message = `FCM HTTP ${status} ${code !== '' ? code : String(error.status ?? '')}`;
  if (status === 401) {
    access = null; // el token de acceso ya no vale: la próxima vez se pide otro
  }
  if (status === 404 || code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH') {
    throw new PushGone(message);
  }
  if (status === 429 || status >= 500) {
    throw new PushThrottled(message);
  }
  throw new Error(message);
}

/** Comprueba la cuenta de servicio pidiendo un token de acceso (lo usa configure-fcm.js). */
export async function checkCredentials() {
  access = null;
  await accessToken();
}

/** Token de acceso OAuth 2.0 de la cuenta de servicio; dura una hora. */
async function accessToken() {
  const c = config('fcm');
  const uri = TOKEN_URI;
  const key = createHash('sha256').update(`${c.client_email}|${c.private_key}`).digest('hex');
  const nowSec = Math.floor(Date.now() / 1000);
  if (access !== null && access.key === key && access.expires > nowSec + 60) {
    return access.token;
  }
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const unsigned = `${b64('{"alg":"RS256","typ":"JWT"}')}.${b64(JSON.stringify({
    iss: String(c.client_email), scope: SCOPE, aud: uri, iat: nowSec, exp: nowSec + 3600,
  }))}`;
  let signature;
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(createPrivateKey(String(c.private_key)));
  } catch {
    throw new Error('FCM: la clave privada de la cuenta de servicio no es válida');
  }
  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${unsigned}.${signature.toString('base64url')}`,
  });
  const [status, raw] = await post(uri, form.toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {
    // sin cuerpo JSON
  }
  if (status !== 200 || typeof data.access_token !== 'string') {
    const why = typeof data.error === 'string' ? data.error : '';
    throw new Error(`FCM: Google no ha dado el token de acceso (HTTP ${status} ${why})`);
  }
  access = { key, token: data.access_token, expires: nowSec + Number(data.expires_in ?? 3600) };
  return access.token;
}

/** POST: [código HTTP, cuerpo]. */
async function post(url, body, headers) {
  try {
    const res = await fetch(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(10_000) });
    return [res.status, await res.text()];
  } catch (e) {
    throw new Error(`FCM: ${e.cause?.code ?? e.name}`);
  }
}
