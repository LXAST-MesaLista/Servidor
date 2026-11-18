// Errores de la API, lectura de la petición y enrutador.

import { isIP } from 'node:net';
import { config } from './config.js';
import { state } from './context.js';

/** Error que la API devuelve como {"error": {"code", "message", ...}}. */
export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function fail(status, code, message, extra = {}) {
  throw new ApiError(status, code, message, extra);
}

export const MAX_BODY = 16384;
const MAX_DEPTH = 8;

function depth(v) {
  if (v === null || typeof v !== 'object') {
    return 1;
  }
  let deepest = 1;
  for (const child of Object.values(v)) {
    deepest = Math.max(deepest, depth(child));
  }
  return 1 + deepest;
}

/** Cuerpo JSON de la petición como objeto. */
export function body() {
  const s = state();
  if (s.body !== undefined) {
    return s.body;
  }
  const req = s.req;
  if (req?.tooLarge) {
    fail(413, 'too_large', 'La petición es demasiado grande.');
  }
  if (req === null || req.raw.length === 0) {
    return (s.body = {});
  }
  let data;
  try {
    data = JSON.parse(req.raw.toString('utf8'));
  } catch {
    fail(400, 'bad_json', 'El cuerpo de la petición no es JSON válido.');
  }
  if (depth(data) > MAX_DEPTH) {
    fail(400, 'bad_json', 'El cuerpo de la petición no es JSON válido.');
  }
  if (Array.isArray(data) && data.length === 0) {
    data = {};
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    fail(400, 'bad_json', 'El cuerpo de la petición debe ser un objeto JSON.');
  }
  return (s.body = data);
}

/** Parámetro de la cadena de consulta, o null. */
export function query(name) {
  const q = state().req?.query;
  return q?.has(name) ? q.get(name) : null;
}

export function header(name) {
  const v = state().req?.headers[name.toLowerCase()];
  return typeof v === 'string' ? v : null;
}

/** Dirección pública de la API (https://<dominio>/api/v1), para PayPal. */
export function apiUrl() {
  if (config('require_https', true)) {
    return `https://${config('domain')}/api/v1`;
  }
  // Solo en desarrollo (sin HTTPS): el host con el que se ha llamado.
  return `http://${header('host') ?? 'localhost'}/api/v1`;
}

/**
 * Dirección de la web o de la app a partir de una plantilla de config.json
 * (front.reset, front.payment_web…), con {token}, {id} o {result}
 * sustituidos. Solo se redirige a estas plantillas: nunca a una dirección que
 * llegue en la petición.
 */
export function frontUrl(key, vars = {}) {
  const template = config(`front.${key}`);
  if (typeof template !== 'string' || template === '') {
    throw new Error(`falta front.${key} en config.json`);
  }
  return template.replace(/\{(\w+)\}/g, (all, name) =>
    (Object.hasOwn(vars, name) ? encodeURIComponent(String(vars[name])) : all));
}

/** Token de la cabecera «Authorization: Bearer <token>», o null. */
export function bearer() {
  const m = /^Bearer\s+(\S+)$/i.exec(header('authorization') ?? '');
  return m ? m[1] : null;
}

/** Dirección del otro extremo de la conexión, sin el prefijo IPv4 en IPv6. */
export function remoteAddress() {
  const remote = state().req?.remote ?? '0.0.0.0';
  return remote.startsWith('::ffff:') && isIP(remote.slice(7)) === 4 ? remote.slice(7) : remote;
}

const trusted = (ip) => (config('trusted_proxies', []) ?? []).includes(ip);

/**
 * IP del cliente. La web llama a la API desde su propio servidor y nginx
 * reenvía las peticiones a Node.js: si la conexión llega de una dirección de
 * confianza (trusted_proxies), la IP real es la última de X-Forwarded-For que
 * no sea de confianza. Así el bloqueo por intentos fallidos (RS-06) sigue
 * siendo por persona.
 */
export function ip() {
  const remote = remoteAddress();
  const forwarded = header('x-forwarded-for');
  if (!trusted(remote) || !forwarded) {
    return remote;
  }
  const chain = forwarded.split(',').map((s) => s.trim()).reverse();
  for (const candidate of chain) {
    if (isIP(candidate) === 0) {
      break;
    }
    if (!trusted(candidate)) {
      return candidate;
    }
  }
  return remote;
}

/** ¿Ha llegado por HTTPS? Directamente, o por nginx (X-Forwarded-Proto) desde trusted_proxies. */
export function isHttps() {
  const req = state().req;
  if (req?.encrypted) {
    return true;
  }
  return trusted(remoteAddress()) && header('x-forwarded-proto') === 'https';
}

/** Petición automática del panel (sondeo), que no cuenta como actividad (RS-05). */
export function isBackground() {
  return header('x-background') === '1';
}

/** Enrutador mínimo: "/reservations/{id}" captura un entero positivo. */
export class Router {
  routes = [];

  add(method, pattern, handler) {
    const source = pattern
      .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
      .replace(/\{(\w+)\}/g, '(?<$1>[1-9][0-9]{0,9})');
    this.routes.push({ method, regex: new RegExp(`^${source}$`), handler });
  }

  async dispatch(method, path) {
    let allowed = false;
    for (const route of this.routes) {
      const m = route.regex.exec(path);
      if (!m) {
        continue;
      }
      if (route.method !== method) {
        allowed = true;
        continue;
      }
      const params = {};
      for (const [k, v] of Object.entries(m.groups ?? {})) {
        params[k] = Number(v);
      }
      return route.handler(params);
    }
    if (allowed) {
      fail(405, 'method_not_allowed', 'Método no permitido.');
    }
    fail(404, 'not_found', 'Recurso no encontrado.');
  }
}
