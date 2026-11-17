// Atiende cada petición HTTP de la API: /api/v1/*.
//
// La web (desde su servidor) y la app se identifican con «Authorization:
// Bearer <token>». Como el navegador nunca envía ese token por su cuenta, no
// hace falta protección CSRF ni CORS: la API no se llama desde el JavaScript
// de otro sitio.

import { config } from './config.js';
import { newState, runWith } from './context.js';
import * as db from './db.js';
import * as mail from './mail.js';
import * as push from './push.js';
import * as payments from './payments.js';
import { router } from './routes.js';
import { ApiError, MAX_BODY, fail, isHttps } from './http.js';

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

/** Lee el cuerpo (como mucho MAX_BODY + 1 bytes; el resto se descarta). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ raw: Buffer.concat(chunks), tooLarge }));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  res.end(JSON.stringify(data));
}

/** Nombre del archivo y línea donde ocurrió un error (sin datos de la petición). */
function where(e) {
  const line = String(e?.stack ?? '').split('\n').find((l) => l.includes('/src/') || l.includes('\\src\\')) ?? '';
  const m = /([\w-]+\.js):(\d+)/.exec(line);
  return m ? `${m[1]}:${m[2]}` : '?';
}

async function dispatch(req, res) {
  try {
    // RS-01: la API no procesa nada que no llegue por HTTPS.
    if (config('require_https', true) && !isHttps()) {
      fail(403, 'https_required', 'La API solo acepta conexiones HTTPS.');
    }
    const { method } = req;
    if (method !== 'GET') {
      const type = req.headers['content-type'] ?? '';
      const hasBody = req.state.req.raw.length > 0 || req.state.req.tooLarge;
      if (hasBody && !type.startsWith('application/json')) {
        fail(415, 'unsupported_type', 'El cuerpo debe enviarse como JSON.');
      }
    }
    const m = /^\/api\/v1(\/.*)?$/.exec(req.state.req.path);
    if (!m) {
      fail(404, 'not_found', 'Recurso no encontrado. La API está en /api/v1/.');
    }
    const path = (m[1] ?? '').replace(/\/+$/, '') || '/';
    const result = await router.dispatch(method, path);

    if (result._redirect !== undefined) {
      // Vuelta de PayPal: a una plantilla de config.json (front.*) o a la propia API.
      res.writeHead(303, { Location: result._redirect, ...SECURITY_HEADERS });
      res.end();
    } else if (result._file !== undefined) {
      // Descarga (p. ej. el CSV de la agenda).
      res.writeHead(200, {
        'Content-Type': result._type,
        'Content-Disposition': `attachment; filename="${result._file}"`,
        ...SECURITY_HEADERS,
      });
      res.end(result._body);
    } else {
      const { _status: status = 200, ...data } = result;
      sendJson(res, status, data);
    }
  } catch (e) {
    if (e instanceof ApiError) {
      sendJson(res, e.status, { error: { code: e.code, message: e.message, ...e.extra } });
    } else if (db.isOverlap(e)) {
      // RF-09: la base de datos ha rechazado dos reservas solapadas en la misma
      // mesa (segunda protección). Para el cliente es un conflicto normal.
      console.error(`MesaLista: solapamiento rechazado por la base de datos en ${where(e)}`);
      sendJson(res, 409, { error: { code: 'conflict', message: 'Esa hora ya no está disponible. Elige otra.' } });
    } else {
      // RS-11: al registro solo va el tipo de error y dónde ocurrió, nunca datos
      // de la petición (los mensajes de PostgreSQL pueden incluir valores).
      const sqlState = db.sqlState(e);
      console.error(`MesaLista: ${e?.name ?? 'Error'}${sqlState ? ` SQLSTATE ${sqlState}` : ''} en ${where(e)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: { code: 'server_error', message: 'Error interno del servidor. Inténtalo de nuevo.' } });
      } else {
        res.end();
      }
    }
  }
}

/**
 * Los correos, los avisos push y las devoluciones de PayPal se hacen después
 * de responder, para no retrasar la respuesta. Lo que falle lo reintenta
 * bin/worker.js cada minuto.
 */
async function afterResponse(state) {
  if (state.refundsQueued) {
    await payments.processRefunds().catch((e) => console.error(`MesaLista: devolución aplazada (${e.name})`));
  }
  if (state.mailQueued) {
    await mail.flush().catch((e) => console.error(`MesaLista: envío de correo aplazado (${e.name})`));
  }
  if (state.pushQueued) {
    await push.flush().catch((e) => console.error(`MesaLista: aviso push aplazado (${e.name})`));
  }
}

/** Manejador para http.createServer. */
export async function handle(req, res) {
  let parsed;
  try {
    parsed = await readBody(req);
  } catch {
    res.destroy();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const state = newState({
    method: req.method,
    path: url.pathname,
    query: url.searchParams,
    headers: req.headers,
    raw: parsed.raw,
    tooLarge: parsed.tooLarge,
    remote: req.socket.remoteAddress ?? '0.0.0.0',
    encrypted: Boolean(req.socket.encrypted),
  });
  req.state = state;
  await runWith({ state, tx: null }, async () => {
    await dispatch(req, res);
    if (state.mailQueued || state.pushQueued || state.refundsQueued) {
      await afterResponse(state);
    }
  });
}
