// Correo (RP-05): solo para restablecer la contraseña (auth.js). Los cambios
// de las reservas y de las solicitudes de grupo se avisan por push (Firebase,
// push.js) y en los avisos de la app y de la web (tabla notifications).
//
// Los correos se guardan en email_outbox dentro de la misma transacción que
// el cambio y se envían después de responder al cliente (o desde
// bin/worker.js cada minuto), para que el proveedor no retrase la respuesta
// de la API.
//
// Se envían con Azure Communication Services Email, por su API REST firmada
// con la clave del recurso (no hace falta ninguna aplicación de Microsoft
// Entra). Sin cadena de conexión en config.json, se quedan en la cola.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import * as db from './db.js';
import * as clock from './clock.js';
import * as push from './push.js';
import { config } from './config.js';
import { state } from './context.js';
import { cut } from './validate.js';

// Dominio gratuito de Azure: 5 correos por minuto y 10 por hora.
const PER_RUN = 5;
const SEND_API = '/emails:send?api-version=2023-03-31';

const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** Azure ha rechazado el envío por el límite de correos (HTTP 429): se reintenta sin gastar intentos. */
export class MailThrottled extends Error {}

/** «sábado 7 de noviembre de 2026 a las 21:00» */
export function when(start) {
  return `${DAYS[start.getDay()]} ${start.getDate()} de ${MONTHS[start.getMonth()]} de ${start.getFullYear()} a las ${clock.hm(start)}`;
}

/** «1 comensal», «4 comensales». */
export const people = (n) => (n === 1 ? '1 comensal' : `${n} comensales`);

/** Título del aviso push de cada cambio de reserva. */
const EVENTS = {
  confirmed: 'Reserva confirmada',
  modified: 'Reserva modificada',
  cancelled_holder: 'Reserva cancelada',
  cancelled_restaurant: 'Reserva cancelada por el restaurante',
  group_accepted: 'Solicitud de grupo aceptada',
  payment_expired: 'Reserva sin confirmar',
};

/**
 * Aviso de un cambio de reserva: solo por push (Firebase), ya no por correo.
 * reservation lleva al menos start_at ("AAAA-MM-DD HH:MM:SS") y party_size;
 * id si existe. name y extra eran para el texto del correo: se siguen
 * aceptando para no cambiar las llamadas, pero ya no se usan.
 */
export async function queueReservation(event, to, name, reservation, extra = '') {
  await push.queueReservation(event, to, reservation, EVENTS[event]);
}

/** Correo cualquiera a la cola (el asunto lleva delante «MesaLista · »). */
export async function queue(to, subject, body) {
  await db.exec(
    'INSERT INTO email_outbox (to_email, subject, body, created_at) VALUES (?, ?, ?, ?)',
    [to, `MesaLista · ${subject}`, body, clock.sql()],
  );
  state().mailQueued = true;
}

/** Envía los correos pendientes. Devuelve cuántos se han enviado. */
export async function flush(limit = 20) {
  if (config('mail.enabled') !== true || String(config('mail.connection_string', '')) === '') {
    return 0;
  }
  const claim = randomBytes(16).toString('hex');
  const batch = Math.max(1, Math.min(limit, PER_RUN));
  // Reserva un lote; un lote abandonado se puede reclamar a los 5 minutos.
  await db.exec(
    `UPDATE email_outbox SET claim = ?, claimed_at = LOCALTIMESTAMP(0)
      WHERE id IN (SELECT id FROM email_outbox
                    WHERE attempts < 5 AND (claim IS NULL OR claimed_at < LOCALTIMESTAMP - interval '5 minutes')
                    ORDER BY id LIMIT ${batch}
                    FOR UPDATE SKIP LOCKED)`,
    [claim],
  );
  const rows = await db.all('SELECT id, to_email, subject, body FROM email_outbox WHERE claim = ? ORDER BY id', [claim]);
  let sent = 0;
  for (const row of rows) {
    try {
      await send(row.to_email, row.subject, row.body);
      await db.exec('DELETE FROM email_outbox WHERE id = ?', [row.id]);
      sent++;
    } catch (e) {
      if (e instanceof MailThrottled) {
        // Azure pide esperar: el resto del lote vuelve a la cola sin gastar
        // intentos y sale en la siguiente vuelta del worker.
        await db.exec('UPDATE email_outbox SET claim = NULL, last_error = ? WHERE claim = ?',
          [cut(e.message, 255), claim]);
        break;
      }
      // El error no incluye el contenido del mensaje (RS-11).
      await db.exec(
        'UPDATE email_outbox SET attempts = attempts + 1, claim = NULL, last_error = ? WHERE id = ?',
        [cut(`${e.name}: ${e.message}`, 255), row.id],
      );
    }
  }
  return sent;
}

/**
 * Envía un correo: POST /emails:send de Azure Communication Services,
 * firmado con HMAC-SHA256 y la clave del recurso. 202 = aceptado para
 * enviar. El nombre visible del remitente se cambia en el portal de Azure
 * (dominio › MailFrom addresses), no aquí.
 */
export async function send(to, subject, body) {
  const res = await postSend({
    senderAddress: String(config('mail.sender', '')),
    recipients: { to: [{ address: to }] },
    content: { subject, plainText: body },
    userEngagementTrackingDisabled: true,
  });
  if (res.status === 202) {
    return;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // sin cuerpo JSON
  }
  const error = `Azure HTTP ${res.status} ${data?.error?.code ?? ''} ${data?.error?.message ?? ''}`.trim();
  if (res.status === 429) {
    throw new MailThrottled(error);
  }
  throw new Error(error);
}

/**
 * Comprueba la cadena de conexión sin enviar ningún correo (lo usa
 * «mesalista estado»): una petición de envío firmada igual que las de verdad,
 * pero sin destinatarios. Azure comprueba la firma antes que el contenido: con
 * la clave buena la rechaza por el contenido (400) y no envía nada; con una
 * clave que no vale, 401. Devuelve el código HTTP.
 */
export async function checkCredentials() {
  const res = await postSend({
    senderAddress: String(config('mail.sender', '')),
    recipients: { to: [] },
    content: { subject: 'MesaLista · comprobación', plainText: 'No se envía.' },
    userEngagementTrackingDisabled: true,
  });
  await res.arrayBuffer().catch(() => null);
  return res.status;
}

/** POST /emails:send firmado con HMAC-SHA256 y la clave del recurso. */
async function postSend(payload) {
  const [endpoint, key] = connection(String(config('mail.connection_string', '')));
  const json = JSON.stringify(payload);
  const host = new URL(endpoint).host;
  const date = new Date().toUTCString();
  const contentHash = createHash('sha256').update(json, 'utf8').digest('base64');
  const signature = createHmac('sha256', key)
    .update(`POST\n${SEND_API}\n${date};${host};${contentHash}`, 'utf8')
    .digest('base64');
  try {
    return await fetch(endpoint + SEND_API, {
      method: 'POST',
      body: json,
      headers: {
        'Content-Type': 'application/json',
        'x-ms-date': date,
        'x-ms-content-sha256': contentHash,
        Authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`Azure: ${e.cause?.code ?? e.name}`);
  }
}

/**
 * «endpoint=https://<recurso>.<zona>.communication.azure.com/;accesskey=<clave>»
 * → [endpoint sin la barra final, clave en binario]. El error nunca lleva la clave.
 */
function connection(text) {
  const parts = {};
  for (const part of text.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      parts[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    }
  }
  const endpoint = (parts.endpoint ?? '').replace(/\/+$/, '');
  const encoded = parts.accesskey ?? '';
  const key = /^[A-Za-z0-9+/]+=*$/.test(encoded) ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
  let url = null;
  try {
    url = new URL(endpoint);
  } catch {
    // no es una dirección
  }
  // Solo HTTPS (RS-01).
  const secure = url !== null && url.protocol === 'https:';
  if (!secure || key.length === 0) {
    throw new Error('mail.connection_string no es una cadena de conexión de Azure válida');
  }
  return [endpoint, key];
}
