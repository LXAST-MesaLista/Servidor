// Utilidades comunes de los scripts de bin/: ejecución con su propio
// contexto, preguntas por la terminal y escritura de config.json.

import { CONFIG_FILE } from '../../src/config.js';
import { newState, runWith } from '../../src/context.js';
import * as db from '../../src/db.js';
import { chmodSync, chownSync, renameSync, statSync, writeFileSync } from 'node:fs';

/**
 * Ejecuta main() con un contexto propio y cierra la base de datos al
 * terminar. Lo que devuelve main es el código de salida (0 si no devuelve nada).
 */
export function run(main) {
  runWith({ state: newState(), tx: null }, async () => {
    let code = 0;
    try {
      code = (await main()) ?? 0;
    } catch (e) {
      console.error(e?.message ?? String(e));
      code = 1;
    } finally {
      await db.close().catch(() => {});
    }
    process.exit(code);
  });
}

/**
 * Pregunta por la terminal y devuelve la respuesta sin espacios en los
 * extremos. Con hidden no se ve lo que se escribe.
 */
export function ask(prompt, hidden = false) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    const raw = hidden && stdin.isTTY;
    if (raw) {
      stdin.setRawMode(true);
    }
    stdin.setEncoding('utf8');
    stdin.resume();
    let answer = '';
    const done = () => {
      stdin.removeListener('data', onData);
      if (raw) {
        stdin.setRawMode(false);
        process.stdout.write('\n');
      }
      stdin.pause();
      resolve(answer.trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          done();
          return;
        }
        if (ch === '\u0003') {
          if (raw) {
            stdin.setRawMode(false);
          }
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          answer = answer.slice(0, -1);
        } else {
          answer += ch;
        }
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * Reescribe config.json con los mismos permisos y dueño (root:mesalista,
 * como lo deja install.sh). Primero en un archivo temporal y después se
 * renombra, para que el servidor nunca lea uno a medias.
 */
export function saveConfig(settings, script) {
  const info = statSync(CONFIG_FILE);
  const tmp = `${CONFIG_FILE}.tmp`;
  const data = { ...settings, _modificado: `${script} el ${new Date().toISOString().slice(0, 16).replace('T', ' ')}` };
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, info.mode & 0o777);
  if (process.platform !== 'win32' && process.getuid?.() === 0) {
    chownSync(tmp, info.uid, info.gid);
  }
  renameSync(tmp, CONFIG_FILE);
}
