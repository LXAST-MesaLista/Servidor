// MesaLista · servidor de la API REST.
//
//   node src/server.js
//
// Escucha en listen.host:listen.port de config.json (por defecto
// 127.0.0.1:8091). En el servidor real solo lo alcanza Apache, que termina
// HTTPS y le reenvía /api/v1/ (despliegue/apache-mesalista.conf).

import { config } from './config.js';
import { createServer } from 'node:http';
import { handle } from './app.js';
import * as db from './db.js';

const host = config('listen.host', '127.0.0.1');
const port = Number(process.env.PORT ?? config('listen.port', 8091));

const server = createServer(handle);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

server.listen(port, host, () => {
  console.log(`MesaLista: API escuchando en http://${host}:${port}/api/v1/`);
});

let closing = false;
async function shutdown(signal) {
  if (closing) {
    return;
  }
  closing = true;
  console.log(`MesaLista: ${signal} recibido, cerrando…`);
  server.close(async () => {
    await db.close().catch(() => {});
    process.exit(0);
  });
  // Si alguna conexión no se cierra, se fuerza a los 10 segundos.
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (e) => {
  console.error(`MesaLista: promesa rechazada sin tratar (${e?.name ?? 'Error'})`);
});
