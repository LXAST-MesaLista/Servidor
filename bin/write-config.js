#!/usr/bin/env node
// Genera config/config.json a partir de config.example.json con los valores
// de las variables de entorno. Lo usa despliegue/install.sh.
//
//   ML_DB_PASS, ML_DOMAIN, ML_MAIL_CONNECTION, ML_MAIL_SENDER (opcionales las de correo)
//
// Si config.json ya existe no se regenera (conserva claves y contraseñas); solo
// se actualiza el dominio, y con él las direcciones de la web (front.*), si
// ML_DOMAIN es otro.
//
// No carga src/config.js: tiene que funcionar antes de que exista config.json.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.env.ML_CONFIG ? resolve(process.env.ML_CONFIG) : join(ROOT, 'config', 'config.json');
const dbPass = process.env.ML_DB_PASS ?? '';
const domain = process.env.ML_DOMAIN ?? '';

if (dbPass === '' || domain === '') {
  console.error('Faltan ML_DB_PASS o ML_DOMAIN.');
  process.exit(2);
}

// Contiene secretos: solo el dueño lo lee mientras se escribe (install.sh pone
// después el grupo mesalista y los permisos 640).
process.umask(0o077);

function write(config, note) {
  const data = { ...config, _modificado: `${note} el ${new Date().toISOString().slice(0, 16).replace('T', ' ')}` };
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

if (existsSync(target)) {
  const config = JSON.parse(readFileSync(target, 'utf8'));
  const old = String(config.domain ?? '');
  if (old === domain) {
    console.log('config.json ya existe; no se modifica.');
    process.exit(0);
  }
  config.domain = domain;
  if (old !== '') {
    for (const [key, url] of Object.entries(config.front ?? {})) {
      config.front[key] = String(url).replaceAll(`://${old}/`, `://${domain}/`);
    }
  }
  write(config, 'Dominio actualizado por install.sh');
  console.log(`config.json: dominio cambiado de «${old}» a «${domain}».`);
  process.exit(0);
}

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'config.example.json'), 'utf8'));
delete config._comentario;
config.db.pass = dbPass;
config.domain = domain;
config.qr_secret = randomBytes(32).toString('hex');
for (const [key, url] of Object.entries(config.front)) {
  config.front[key] = url.replaceAll('<dominio>', domain);
}
const mailConnection = process.env.ML_MAIL_CONNECTION ?? '';
const mailSender = process.env.ML_MAIL_SENDER ?? '';
if (mailConnection !== '' && mailSender !== '') {
  config.mail = { enabled: true, connection_string: mailConnection, sender: mailSender };
}

write(config, 'Generado por install.sh');
console.log('config.json creado.');
