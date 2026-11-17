#!/usr/bin/env node
// RF-44: guarda en config/config.json las claves de PayPal sandbox y comprueba
// que PayPal las acepta. Las claves se escriben aquí, en el servidor; no se
// muestran en pantalla ni se guardan en ningún otro sitio.
//
//   sudo node /opt/mesalista-servidor/bin/configure-paypal.js
//   (vacío como Client ID = quitar las claves y desactivar la señal)

import { settings } from '../src/config.js';
import { payPalAuth } from '../src/payments.js';
import { run, ask, saveConfig } from './lib/cli.js';

const KEY_RE = /^[A-Za-z0-9_-]{20,128}$/;

run(async () => {
  console.log('PayPal sandbox: developer.paypal.com > Apps & Credentials > Sandbox > tu app.');
  const clientId = await ask('Client ID: ');
  const secret = clientId === '' ? '' : await ask('Secret (no se ve al escribir): ', true);

  if (clientId !== '') {
    if (!KEY_RE.test(clientId) || !KEY_RE.test(secret)) {
      console.error('El Client ID o el Secret no tienen el formato esperado. No se ha cambiado nada.');
      return 2;
    }
    // Comprobación: pedir un token a PayPal sandbox con esas claves.
    let status = 0;
    try {
      ({ status } = await payPalAuth(clientId, secret));
    } catch {
      status = 0;
    }
    if (status !== 200) {
      console.error(`PayPal sandbox no acepta esas claves (HTTP ${status}). No se ha cambiado nada.`);
      return 3;
    }
    console.log('PayPal sandbox acepta las claves.');
  }

  saveConfig({ ...settings, paypal: { mode: 'sandbox', client_id: clientId, secret } }, 'configure-paypal.js');
  console.log(clientId === ''
    ? 'Claves quitadas: los grupos aceptados se confirman sin señal.'
    : 'Guardado. Reinicia la API (sudo systemctl restart mesalista-api) y los grupos aceptados pagarán la señal (Parámetros > señal por persona).');
  return 0;
});
