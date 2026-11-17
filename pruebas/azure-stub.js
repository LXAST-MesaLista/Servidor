// Servidor falso de Azure Communication Services Email para CP-11 (lo arranca
// run.js). Comprueba la firma HMAC-SHA256 como Azure, apunta el mensaje en
// ML_AZURE_LOG y responde según el destinatario:
//   limite@…  → 429 (límite de envío)   rechazo@… → 400   el resto → 202
//
//   ML_AZURE_KEY=<clave en base64> ML_AZURE_LOG=<archivo> ML_AZURE_PORT=18099 node pruebas/azure-stub.js

import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const key = Buffer.from(process.env.ML_AZURE_KEY ?? '', 'base64');
const log = process.env.ML_AZURE_LOG ?? '';
const port = Number(process.env.ML_AZURE_PORT ?? 18099);

function reply(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.method !== 'POST' || req.url !== '/emails:send?api-version=2023-03-31') {
      reply(res, 404, { error: { code: 'NotFound', message: 'Resource not found.' } });
      return;
    }
    const date = req.headers['x-ms-date'] ?? '';
    const hash = createHash('sha256').update(body, 'utf8').digest('base64');
    const toSign = `POST\n${req.url}\n${date};${req.headers.host ?? ''};${hash}`;
    const expected = 'HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature='
      + createHmac('sha256', key).update(toSign, 'utf8').digest('base64');
    const t = Date.parse(date);
    const fresh = !Number.isNaN(t) && Math.abs(Date.now() - t) < 300_000;
    if (req.headers['x-ms-content-sha256'] !== hash || req.headers.authorization !== expected || !fresh) {
      reply(res, 401, { error: { code: 'Denied', message: 'Denied by the resource provider.' } });
      return;
    }
    appendFileSync(log, `${body}\n`);
    const to = JSON.parse(body)?.recipients?.to?.[0]?.address ?? '';
    if (to.startsWith('limite@')) {
      reply(res, 429, { error: { code: 'TooManyRequests', message: 'Too many requests.' } }, { 'Retry-After': '60' });
      return;
    }
    if (to.startsWith('rechazo@')) {
      reply(res, 400, { error: { code: 'InvalidRecipient', message: 'Recipient address is not valid.' } });
      return;
    }
    reply(res, 202, { id: randomBytes(16).toString('hex'), status: 'Running' });
  });
}).listen(port, '127.0.0.1');
