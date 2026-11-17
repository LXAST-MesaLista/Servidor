#!/usr/bin/env node
// Tareas de cron. PostgreSQL no tiene eventos programados, así que los
// procesos automáticos de la base de datos se lanzan desde aquí:
//
//   * * * * *  worker.js           cada minuto: marca las no presentadas y las
//                                  señales vencidas (RF-24, RF-44), reintenta
//                                  las devoluciones y envía los correos y los
//                                  avisos push pendientes
//   0 4 * * *  worker.js --diario  cada día a las 04:00: borra los datos
//                                  personales caducados (RP-03, RP-08)
//
// Las dos líneas las escribe install.sh en /etc/cron.d/mesalista.

import '../src/config.js';
import * as db from '../src/db.js';
import * as clock from '../src/clock.js';
import * as booking from '../src/booking.js';
import * as payments from '../src/payments.js';
import * as mail from '../src/mail.js';
import * as push from '../src/push.js';
import { run } from './lib/cli.js';

const stamp = () => new Date().toISOString();

run(async () => {
  try {
    if (process.argv.includes('--diario')) {
      await db.run('CALL sp_daily_purge(?::date)', [clock.ymd(clock.now())]);
      console.log(`${stamp()} limpieza diaria hecha`);
      return 0;
    }
    await booking.markNoShows();
    const refunds = await payments.processRefunds();
    if (refunds > 0) {
      console.log(`${stamp()} devoluciones de señal: ${refunds}`);
    }
    const sent = await mail.flush(50);
    if (sent > 0) {
      console.log(`${stamp()} correos enviados: ${sent}`);
    }
    const pushed = await push.flush(100);
    if (pushed > 0) {
      console.log(`${stamp()} avisos push enviados: ${pushed}`);
    }
    return 0;
  } catch (e) {
    const sqlState = db.sqlState(e);
    console.error(`${stamp()} worker: ${e?.name ?? 'Error'}${sqlState ? ` SQLSTATE ${sqlState}` : ''}`);
    return 1;
  }
});
