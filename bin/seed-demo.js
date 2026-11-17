#!/usr/bin/env node
// Carga las cuentas ficticias de la demostración y algunas reservas para
// mañana. Todas las cuentas usan la contraseña indicada.
//
//   node bin/seed-demo.js "<contraseña de demo>"
//
// Cuentas: recepcion@mesalista.test (personal), lucia@mesalista.test,
// joan@mesalista.test y marta@mesalista.test (clientes).

import '../src/config.js';
import { createHash } from 'node:crypto';
import * as db from '../src/db.js';
import * as clock from '../src/clock.js';
import * as auth from '../src/auth.js';
import * as booking from '../src/booking.js';
import { ApiError } from '../src/http.js';
import { run } from './lib/cli.js';

const ACCOUNTS = [
  ['staff', 'Recepción', 'recepcion@mesalista.test', null],
  ['client', 'Lucía Ferrer', 'lucia@mesalista.test', '+34600111222'],
  ['client', 'Joan Pons', 'joan@mesalista.test', '+34600333444'],
  ['client', 'Marta Vidal', 'marta@mesalista.test', '+34600555666'],
];

/** request_id estable para cada reserva de ejemplo (no se duplica al repetir el script). */
function requestId(seed) {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-0000-4000-8000-${h.slice(8, 20)}`;
}

run(async () => {
  const password = process.argv[2] ?? '';
  try {
    auth.checkPasswordPolicy(password);
  } catch (e) {
    if (e instanceof ApiError) {
      console.error(`Uso: node bin/seed-demo.js "<contraseña>"\n${e.message}`);
      return 2;
    }
    throw e;
  }

  const hashed = await auth.hash(password);
  const ids = {};
  for (const [role, name, email, phone] of ACCOUNTS) {
    let id = await db.value('SELECT id FROM users WHERE email = ?', [email]);
    if (id === null) {
      id = await db.insert(
        'INSERT INTO users (role, name, email, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [role, name, email, phone, hashed, clock.sql()],
      );
      console.log(`Cuenta creada: ${email} (${role})`);
    }
    ids[email] = id;
  }

  // Reservas de ejemplo para mañana por la noche.
  const tomorrow = clock.ymd(clock.addDays(clock.now(), 1));
  const veggie = await db.value("SELECT id FROM menu_options WHERE name = 'Vegetariano'");
  const examples = [
    ['marta@mesalista.test', '20:00', 2, [], 'Celebramos un cumpleaños.'],
    ['marta@mesalista.test', '21:30', 6, veggie === null ? [] : [veggie], null],
  ];
  for (const [email, time, party, options, note] of examples) {
    const user = await db.one('SELECT * FROM users WHERE id = ?', [ids[email]]);
    try {
      await booking.createForClient(user, {
        request_id: requestId(`${email}|${time}|${party}`),
        date: tomorrow,
        time,
        party,
        menu_options: options,
        note,
        consent: true,
      });
      console.log(`Reserva de ejemplo: ${email} ${tomorrow} ${time} (${party} pers.)`);
    } catch (e) {
      if (!(e instanceof ApiError)) {
        throw e;
      }
      console.log(`Reserva de ejemplo omitida (${time}): ${e.message}`);
    }
  }
  // Los correos y avisos de ejemplo no se envían.
  await db.exec("DELETE FROM email_outbox WHERE to_email LIKE '%@mesalista.test'");
  return 0;
});
