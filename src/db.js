// Acceso a PostgreSQL con consultas parametrizadas (RS-08).
//
// Las consultas se escriben con «?» y aquí se numeran ($1, $2…). Dentro de
// db.tx(fn) todas las consultas de fn van por la misma conexión y la misma
// transacción; fuera, cada una toma una conexión libre del grupo.

import pg from 'pg';
import { config } from './config.js';
import { ctx, runWith } from './context.js';

// Fechas como texto, igual que se guardan (hora de Madrid sin zona); los
// enteros de 64 bits (COUNT, SUM…) y los numeric, como números.
pg.types.setTypeParser(1114, (v) => v);          // timestamp
pg.types.setTypeParser(1082, (v) => v);          // date
pg.types.setTypeParser(20, (v) => Number(v));    // bigint
pg.types.setTypeParser(1700, (v) => Number(v));  // numeric

let pool = null;

function getPool() {
  if (pool === null) {
    const c = config('db');
    pool = new pg.Pool({
      host: c.host,
      port: c.port,
      database: c.name,
      user: c.user,
      password: c.pass,
      max: c.pool ?? 10,
      idleTimeoutMillis: 30_000,
      // Se fijan al abrir cada conexión. Las fechas se guardan en hora de Madrid
      // (timestamp sin zona). Con READ COMMITTED, las comprobaciones de
      // solapamiento que siguen a un bloqueo de mesas ven siempre las reservas
      // ya confirmadas (RF-09).
      options: '-c TimeZone=Europe/Madrid -c default_transaction_isolation=read\\ committed',
    });
    pool.on('error', (e) => {
      console.error(`MesaLista: conexión con PostgreSQL perdida (${e.code ?? e.name})`);
    });
  }
  return pool;
}

/** Cambia los «?» por $1, $2… sin tocar los que van dentro de un texto entre comillas. */
function numbered(sql) {
  let out = '';
  let n = 0;
  let quoted = false;
  for (const ch of sql) {
    if (ch === "'") {
      quoted = !quoted;
    }
    out += ch === '?' && !quoted ? `$${++n}` : ch;
  }
  return out;
}

/** Ejecuta una consulta y devuelve el resultado de pg ({ rows, rowCount }). */
export function run(sql, params = []) {
  const client = ctx().tx ?? getPool();
  return client.query(numbered(sql), params);
}

export async function all(sql, params = []) {
  return (await run(sql, params)).rows;
}

export async function one(sql, params = []) {
  return (await run(sql, params)).rows[0] ?? null;
}

/** Primera columna de la primera fila, o null. */
export async function value(sql, params = []) {
  const row = (await run(sql, params)).rows[0];
  return row === undefined ? null : Object.values(row)[0];
}

/** Ejecuta y devuelve el número de filas afectadas. */
export async function exec(sql, params = []) {
  return (await run(sql, params)).rowCount ?? 0;
}

/** INSERT de una fila; devuelve su id. */
export async function insert(sql, params = []) {
  return (await run(`${sql} RETURNING id`, params)).rows[0].id;
}

/** Varias sentencias sin parámetros (p. ej. un archivo .sql). */
export async function script(sql) {
  await (ctx().tx ?? getPool()).query(sql);
}

const RETRY = new Set(['40P01', '55P03', '40001']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ejecuta fn dentro de una transacción y devuelve su resultado. Si PostgreSQL
 * la aborta por un interbloqueo (40P01), por no poder bloquear (55P03) o por un
 * conflicto de serialización (40001), la repite. Dentro de otra transacción,
 * fn se une a ella.
 */
export async function tx(fn) {
  const outer = ctx();
  if (outer.tx !== null) {
    return fn();
  }
  for (let attempt = 1; ; attempt++) {
    const client = await getPool().connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await runWith({ ...outer, tx: client }, fn);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      if (RETRY.has(state(e)) && attempt < 4) {
        await sleep(5 + Math.floor(Math.random() * 25));
        continue;
      }
      throw e;
    } finally {
      client.release(broken);
    }
  }
}

/** Código SQLSTATE de un error de PostgreSQL, o ''. */
function state(e) {
  return typeof e?.code === 'string' && e.code.length === 5 && typeof e.severity === 'string' ? e.code : '';
}

export const isDuplicateKey = (e) => state(e) === '23505';

/** Dos reservas solapadas en la misma mesa (restricción ex_occupancy_overlap, RF-09). */
export const isOverlap = (e) => state(e) === '23P01';

/** ¿Es un error de PostgreSQL? Devuelve su SQLSTATE o ''. */
export const sqlState = state;

/** Cierra las conexiones (al terminar un script o el servidor). */
export async function close() {
  if (pool !== null) {
    const p = pool;
    pool = null;
    await p.end();
  }
}
