#!/usr/bin/env node
// Fija el PIN de «Cerrar local» (4 a 8 cifras), el que pide el panel para
// terminar de golpe todas las reservas en curso. Lo usa install.sh la primera
// vez; después se cambia desde Administración → Parámetros.
//
//   node bin/set-close-pin.js
//
// El PIN se pide por teclado sin mostrarlo, o se lee de la variable de
// entorno ML_PIN. Se guarda cifrado con Argon2id.

import '../src/config.js';
import * as admin from '../src/admin.js';
import { ApiError } from '../src/http.js';
import { run, ask } from './lib/cli.js';

run(async () => {
  let pin = process.env.ML_PIN ?? '';
  if (pin === '') {
    pin = await ask('PIN de «Cerrar local» (4 a 8 cifras): ', true);
    if (pin !== await ask('Repite el PIN: ', true)) {
      console.error('Los PIN no coinciden.');
      return 1;
    }
  }
  try {
    await admin.setClosePin({ pin });
  } catch (e) {
    if (e instanceof ApiError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
  console.log('PIN de «Cerrar local» guardado.');
  return 0;
});
