#!/usr/bin/env node
// Crea una cuenta del personal desde la consola (la primera cuenta de
// administrador no puede crearse desde el panel).
//
//   node bin/create-user.js admin admin@mesalista.test "Nombre Apellido"
//   node bin/create-user.js staff recepcion@mesalista.test "Recepción"
//
// La contraseña se pide por teclado sin mostrarla, o se lee de la variable
// de entorno ML_PASSWORD.

import '../src/config.js';
import * as admin from '../src/admin.js';
import { ApiError } from '../src/http.js';
import { run, ask } from './lib/cli.js';

const [, script, role, email, name] = process.argv;

run(async () => {
  if (!['admin', 'staff'].includes(role) || !email || !name) {
    console.error(`Uso: node ${script} admin|staff <correo> "<nombre>"`);
    return 2;
  }
  let password = process.env.ML_PASSWORD ?? '';
  if (password === '') {
    password = await ask('Contraseña (mínimo 10 caracteres): ', true);
    if (password !== await ask('Repite la contraseña: ', true)) {
      console.error('Las contraseñas no coinciden.');
      return 1;
    }
  }
  try {
    await admin.createStaff({ name, email, password, role });
  } catch (e) {
    if (e instanceof ApiError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
  console.log(`Cuenta ${role} creada: ${email}`);
  return 0;
});
