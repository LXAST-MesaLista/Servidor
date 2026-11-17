// Contraseñas, sesiones y roles (RF-01 a RF-03, RF-38, RS-02, RS-04 a RS-06, RS-09).
//
// La web y la app se identifican con un token Bearer (cabecera
// «Authorization: Bearer <token>») que la API entrega al iniciar sesión. La
// base de datos solo guarda su hash SHA-256. Hay dos tipos de sesión:
//   app   · clientes, caduca 60 minutos después de iniciarse.
//   panel · personal y administradores, 8 horas como máximo y 30 minutos sin actividad.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import argon2 from 'argon2';
import * as db from './db.js';
import * as clock from './clock.js';
import * as V from './validate.js';
import * as mail from './mail.js';
import { ROOT } from './config.js';
import { state } from './context.js';
import { fail, frontUrl, bearer, ip, isBackground } from './http.js';

const APP_TTL_MIN = 60;
const PANEL_TTL_MIN = 480;
const PANEL_IDLE_MIN = 30;
const MAX_FAILED = 5;
const LOCK_MIN = 15;
const RESET_TTL_MIN = 30;
const RESET_PER_HOUR = 3;

// RS-02: Argon2id con 19 MiB, 2 iteraciones y paralelismo 1 (mínimo OWASP).
const HASH_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const TOKEN_RE = /^[0-9a-f]{64}$/;

export function hash(password) {
  return argon2.hash(password, HASH_OPTIONS);
}

export async function verifyHash(hashed, password) {
  try {
    return await argon2.verify(hashed, password);
  } catch {
    return false;
  }
}

let common = null;

/** Lista de contraseñas comunes (data/common-passwords.txt), en minúsculas. */
function commonPasswords() {
  if (common === null) {
    const file = join(ROOT, 'data', 'common-passwords.txt');
    common = new Set(existsSync(file)
      ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.toLowerCase())
      : []);
  }
  return common;
}

/** RS-09: al menos 10 caracteres y fuera de la lista de contraseñas comunes. */
export function checkPasswordPolicy(password) {
  if (typeof password !== 'string' || !password.isWellFormed()) {
    V.invalid('password', 'La contraseña no es válida.');
  }
  const len = V.length(password);
  if (len < 10 || len > 128) {
    V.invalid('password', 'La contraseña debe tener entre 10 y 128 caracteres.');
  }
  if (commonPasswords().has(password.toLowerCase())) {
    V.invalid('password', 'Esa contraseña es demasiado común. Elige otra.');
  }
  return password;
}

/**
 * Inicia sesión. Con credenciales erróneas, cuenta desactivada o de otro
 * tipo, siempre el mismo mensaje (RF-02). Tras 5 fallos desde la misma IP en
 * 15 minutos, rechaza incluso la contraseña correcta (RS-06).
 */
export async function login(kind, emailIn, passwordIn) {
  const email = typeof emailIn === 'string' ? emailIn.trim().toLowerCase() : '';
  const password = typeof passwordIn === 'string' ? passwordIn : '';
  if (email === '' || password === '' || Buffer.byteLength(email) > 254 || Buffer.byteLength(password) > 512) {
    fail(401, 'bad_credentials', 'Correo o contraseña incorrectos.');
  }

  const now = clock.now();
  const emailHash = sha256(email);
  const from = ip();
  const failed = await db.value(
    `SELECT COUNT(*) FROM login_attempts
      WHERE email_hash = ? AND ip = ? AND NOT success AND created_at > ?`,
    [emailHash, from, clock.sql(clock.plus(now, -LOCK_MIN))],
  );
  if (failed >= MAX_FAILED) {
    fail(429, 'locked', 'Demasiados intentos fallidos. Vuelve a intentarlo dentro de 15 minutos.');
  }

  const user = await db.one('SELECT * FROM users WHERE email = ?', [email]);
  const roles = kind === 'app' ? ['client'] : ['staff', 'admin'];
  if (user === null) {
    // Mismo coste que una comprobación real, para no delatar si el correo existe.
    await hash(password);
  }
  const ok = user !== null
    && await verifyHash(user.password_hash, password)
    && user.active === true
    && roles.includes(user.role);

  await db.exec(
    'INSERT INTO login_attempts (email_hash, ip, success, created_at) VALUES (?, ?, ?, ?)',
    [emailHash, from, ok, clock.sql()],
  );
  if (!ok) {
    fail(401, 'bad_credentials', 'Correo o contraseña incorrectos.');
  }
  if (argon2.needsRehash(user.password_hash, HASH_OPTIONS)) {
    await db.exec('UPDATE users SET password_hash = ? WHERE id = ?', [await hash(password), user.id]);
  }

  await startSession(kind, user.id);
  return user;
}

/** RF-01: crea una cuenta de cliente e inicia su sesión. */
export async function register(input) {
  V.only(input, ['name', 'email', 'phone', 'password']);
  const name = V.name(input.name ?? null);
  const email = V.email(input.email ?? null);
  const phone = V.phone(input.phone ?? null);
  const password = checkPasswordPolicy(input.password ?? null);
  let id;
  try {
    id = await db.insert(
      "INSERT INTO users (role, name, email, phone, password_hash, created_at) VALUES ('client', ?, ?, ?, ?, ?)",
      [name, email, phone, await hash(password), clock.sql()],
    );
  } catch (e) {
    if (db.isDuplicateKey(e)) {
      fail(409, 'email_taken', 'Ya existe una cuenta con ese correo.', { field: 'email' });
    }
    throw e;
  }
  await startSession('app', id);
  return db.one('SELECT id, name, email, phone FROM users WHERE id = ?', [id]);
}

async function startSession(kind, userId) {
  const token = randomBytes(32).toString('hex');
  const now = clock.now();
  const expires = clock.plus(now, kind === 'app' ? APP_TTL_MIN : PANEL_TTL_MIN);
  await db.exec(
    `INSERT INTO sessions (token_hash, user_id, kind, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sha256(token), userId, kind, clock.sql(now), clock.sql(now), clock.sql(expires)],
  );
  state().issued = { token, kind, expires_at: clock.atom(expires) };
}

/**
 * Token de la sesión recién abierta, para devolverlo en la respuesta. Es la
 * única vez que viaja: después el cliente lo envía en cada petición.
 */
export function issued() {
  const s = state().issued;
  if (s === null) {
    throw new Error('no se ha abierto ninguna sesión');
  }
  return s;
}

/** Usuario de la sesión actual del tipo indicado, o null. */
export async function current(kind) {
  const s = state();
  if (s.user !== null && s.user._kind === kind) {
    return s.user;
  }
  const token = bearer();
  if (token === null || !TOKEN_RE.test(token)) {
    return null;
  }
  const tokenHash = sha256(token);
  const row = await db.one(
    `SELECT s.last_seen_at, s.expires_at, s.kind, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    [tokenHash],
  );
  // Un token del panel en una ruta de cliente (o al revés) no vale aquí,
  // pero la sesión sigue abierta para su lado.
  if (row === null || row.kind !== kind) {
    return null;
  }
  const now = clock.now();
  const valid = row.active === true
    && clock.at(row.expires_at) > now
    && (kind === 'app' || clock.at(row.last_seen_at) > clock.plus(now, -PANEL_IDLE_MIN));
  if (!valid) {
    await db.exec('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
    return null;
  }
  if (kind === 'panel' && !isBackground()) {
    await db.exec('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', [clock.sql(now), tokenHash]);
  }
  delete row.password_hash;
  row._kind = kind;
  row._token_hash = tokenHash;
  s.user = row;
  return row;
}

/** Exige sesión del tipo indicado y uno de los roles (RS-04). */
export async function requireSession(kind, roles) {
  const user = await current(kind);
  if (user === null) {
    fail(401, 'unauthenticated', 'La sesión ha caducado o no existe. Inicia sesión de nuevo.');
  }
  if (!roles.includes(user.role)) {
    fail(403, 'forbidden', 'No tienes permiso para esta operación.');
  }
  return user;
}

export const client = () => requireSession('app', ['client']);
export const staff = () => requireSession('panel', ['staff', 'admin']);
export const admin = () => requireSession('panel', ['admin']);

/** RF-03: el token deja de valer en el servidor, no solo en la web o la app. */
export async function logout(kind) {
  const token = bearer();
  if (token !== null && TOKEN_RE.test(token)) {
    await db.exec('DELETE FROM sessions WHERE token_hash = ? AND kind = ?', [sha256(token), kind]);
  }
  state().user = null;
}

// ---------------------------------------------------------------------------
// RF-40: restablecer la contraseña con un enlace de un solo uso
// ---------------------------------------------------------------------------

/**
 * Envía el enlace si el correo es de un cliente. La respuesta es la misma
 * exista o no la cuenta, para no revelar quién está registrado. Cada nuevo
 * enlace anula los anteriores; como mucho 3 por hora y cuenta.
 */
export async function requestReset(emailIn) {
  const email = typeof emailIn === 'string' ? emailIn.trim().toLowerCase() : '';
  if (email === '' || !V.isEmail(email)) {
    V.invalid('email', 'El correo electrónico no es válido.');
  }
  const user = await db.one("SELECT id, name, email FROM users WHERE email = ? AND role = 'client' AND active", [email]);
  if (user === null) {
    return;
  }
  const now = clock.now();
  const recent = await db.value(
    'SELECT COUNT(*) FROM password_resets WHERE user_id = ? AND created_at > ?',
    [user.id, clock.sql(clock.plus(now, -60))],
  );
  if (recent >= RESET_PER_HOUR) {
    return;
  }
  const token = randomBytes(32).toString('hex');
  await db.tx(async () => {
    await db.exec('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [clock.sql(now), user.id]);
    await db.exec(
      'INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)',
      [user.id, sha256(token), clock.sql(clock.plus(now, RESET_TTL_MIN)), clock.sql(now)],
    );
    // Página de la web que pide la contraseña nueva (plantilla front.reset).
    const link = frontUrl('reset', { token });
    await mail.queue(user.email, 'Restablecer la contraseña',
      `Hola, ${user.name}:\n\n`
      + 'Has pedido restablecer la contraseña de MesaLista. Abre este enlace en los próximos 30 minutos; solo funciona una vez:\n\n'
      + `${link}\n\n`
      + 'Si no lo has pedido tú, ignora este correo: tu contraseña no cambia.\n');
  });
}

/** Cambia la contraseña con el enlace y cierra todas las sesiones de la cuenta. */
export async function resetPassword(input) {
  V.only(input, ['token', 'password']);
  const token = input.token ?? null;
  const invalid = () => fail(400, 'reset_invalid', 'El enlace no es válido o ha caducado. Pide otro desde «¿Has olvidado tu contraseña?».');
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
    invalid();
  }
  const password = checkPasswordPolicy(input.password ?? null);
  const hashed = await hash(password);
  await db.tx(async () => {
    const row = await db.one('SELECT * FROM password_resets WHERE token_hash = ? FOR UPDATE', [sha256(token)]);
    if (row === null || row.used_at !== null || clock.at(row.expires_at) <= clock.now()) {
      invalid();
    }
    await db.exec('UPDATE users SET password_hash = ? WHERE id = ?', [hashed, row.user_id]);
    await db.exec('UPDATE password_resets SET used_at = ? WHERE id = ?', [clock.sql(), row.id]);
    await db.exec('DELETE FROM sessions WHERE user_id = ?', [row.user_id]);
  });
}

export async function verifyPassword(userId, password) {
  const hashed = await db.value('SELECT password_hash FROM users WHERE id = ?', [userId]);
  return typeof password === 'string' && typeof hashed === 'string' && verifyHash(hashed, password);
}
