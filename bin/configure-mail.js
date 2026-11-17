#!/usr/bin/env node
// RF-17: guarda en config/config.json la cadena de conexión y el remitente de
// Azure Communication Services Email y, si se quiere, envía un correo de
// prueba. Las claves se escriben aquí, en el servidor; no se muestran en
// pantalla ni se guardan en ningún otro sitio.
//
//   sudo mesalista correo
//   («no» como cadena de conexión = desactivar el envío: los correos se quedan
//   en email_outbox)

import { settings } from '../src/config.js';
import * as mail from '../src/mail.js';
import { isEmail } from '../src/validate.js';
import { run, ask, saveConfig } from './lib/cli.js';

run(async () => {
  const old = settings.mail ?? {};
  let current = {
    enabled: old.enabled === true,
    connection_string: String(old.connection_string ?? ''),
    sender: String(old.sender ?? ''),
  };

  console.log(current.enabled && current.connection_string !== ''
    ? `Correo activado (remitente ${current.sender}).`
    : 'Correo desactivado: los correos se quedan en la cola.');
  console.log('Portal de Azure > tu recurso Communication Services > Configuración > Claves > Cadena de conexión.');
  let connection = await ask('Cadena de conexión (no se ve al escribir; vacío = mantener la actual; «no» = desactivar): ', true);

  if (connection.toLowerCase() === 'no') {
    current.enabled = false;
  } else {
    connection = connection !== '' ? connection : current.connection_string;
    if (!/^endpoint=https:\/\/[^;\s]+;accesskey=[A-Za-z0-9+/]+=*;?$/i.test(connection)) {
      console.error('Eso no parece una cadena de conexión («endpoint=https://…;accesskey=…»). No se ha cambiado nada.');
      return 2;
    }
    console.log('Remitente: recurso Email Communication Services > tu dominio > MailFrom addresses.');
    let sender = await ask(`Remitente (DoNotReply@….azurecomm.net)${current.sender !== '' ? ` [${current.sender}]` : ''}: `);
    sender = sender !== '' ? sender : current.sender;
    if (!isEmail(sender)) {
      console.error('El remitente no es una dirección de correo. No se ha cambiado nada.');
      return 2;
    }
    current = { enabled: true, connection_string: connection, sender };

    // Prueba opcional con la configuración nueva, antes de guardarla.
    const to = await ask('Correo al que enviar una prueba (vacío = no probar): ');
    if (to !== '') {
      settings.mail = current;
      try {
        await mail.send(to, 'MesaLista · Prueba de correo',
          'Este correo confirma que MesaLista puede enviar con Azure Communication Services.\n');
      } catch (e) {
        console.error(`${e.message}\nNo se ha cambiado nada.`);
        return 3;
      }
      console.log(`Azure ha aceptado el correo de prueba: míralo en ${to} (también en spam).`);
    }
  }

  saveConfig({ ...settings, mail: current }, 'configure-mail.js');
  console.log(current.enabled
    ? 'Guardado. Se aplica al reiniciar la API (sudo mesalista reiniciar); el worker lo usa en su siguiente vuelta.'
    : 'Correo desactivado: los correos se quedan en email_outbox.');
  return 0;
});
