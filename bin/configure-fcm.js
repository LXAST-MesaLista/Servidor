#!/usr/bin/env node
// Avisos push: guarda en config/config.json la cuenta de servicio del proyecto
// de Firebase y comprueba con Google que funciona antes de guardarla. La clave
// privada no se muestra en pantalla ni se guarda en ningún otro sitio.
//
//   sudo node /opt/mesalista-servidor/bin/configure-fcm.js <archivo.json>
//   sudo node /opt/mesalista-servidor/bin/configure-fcm.js no      (desactivar)
//
// El archivo JSON se descarga en la consola de Firebase: Configuración del
// proyecto > Cuentas de servicio > Generar nueva clave privada. Después de
// guardarlo, bórralo del servidor: config.json ya tiene lo necesario.

import { existsSync, readFileSync } from 'node:fs';
import { settings } from '../src/config.js';
import * as push from '../src/push.js';
import { run, saveConfig } from './lib/cli.js';

run(async () => {
  const arg = process.argv[2] ?? '';
  if (arg === '') {
    console.error('Uso: node bin/configure-fcm.js <cuenta-de-servicio.json>   o   node bin/configure-fcm.js no');
    return 2;
  }

  if (arg.toLowerCase() === 'no') {
    saveConfig({ ...settings, fcm: { ...(settings.fcm ?? {}), enabled: false } }, 'configure-fcm.js');
    console.log('Avisos push desactivados: los avisos se quedan en push_outbox y caducan a la hora.');
    return 0;
  }

  let json = null;
  try {
    json = existsSync(arg) ? JSON.parse(readFileSync(arg, 'utf8')) : null;
  } catch {
    json = null;
  }
  if (json === null || json.type !== 'service_account' || typeof json.project_id !== 'string'
    || typeof json.client_email !== 'string' || !String(json.private_key ?? '').includes('PRIVATE KEY')) {
    console.error(`${arg} no es el archivo JSON de una cuenta de servicio de Firebase. No se ha cambiado nada.`);
    return 2;
  }
  const fcm = {
    enabled: true,
    project_id: json.project_id,
    client_email: json.client_email,
    private_key: json.private_key,
  };

  // Prueba con la configuración nueva antes de guardarla: Google tiene que dar un token de acceso.
  settings.fcm = fcm;
  try {
    await push.checkCredentials();
  } catch (e) {
    console.error(`${e.message}\nNo se ha cambiado nada.`);
    return 3;
  }

  saveConfig({ ...settings, fcm }, 'configure-fcm.js');
  console.log(`Guardado: avisos push con el proyecto ${fcm.project_id}.\n`
    + 'Reinicia la API para aplicarlo: sudo systemctl restart mesalista-api\n'
    + `Ya puedes borrar ${arg} del servidor.`);
  return 0;
});
