// Servidor falso de Google para la prueba de los avisos push (lo arranca
// run.js). Hace lo mismo que Google:
//
//   POST /token                            comprueba la firma RS256 del JWT de la
//                                          cuenta de servicio con su clave pública
//                                          (ML_FCM_PUBKEY) y da un token de acceso
//   POST /v1/projects/<p>/messages:send    exige ese token y guarda el mensaje en
//                                          ML_FCM_LOG. Tokens de dispositivo de
//                                          prueba: «muerto…» → 404 UNREGISTERED,
//                                          «limite…» → 429.
//
//   ML_FCM_PUBKEY=<pem> ML_FCM_LOG=<archivo> ML_FCM_PORT=18098 node pruebas/fcm-stub.js

import { createServer } from 'node:http';
import { createVerify, randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

const ACCESS = 'ya29.token-de-pruebas';
const port = Number(process.env.ML_FCM_PORT ?? 18098);
const log = process.env.ML_FCM_LOG ?? '';

function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const fromB64 = (s) => Buffer.from(s, 'base64url');

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (path === '/token') {
      const form = new URLSearchParams(raw);
      const parts = (form.get('assertion') ?? '').split('.');
      let claims = null;
      try {
        claims = parts.length === 3 ? JSON.parse(fromB64(parts[1]).toString('utf8')) : null;
      } catch {
        claims = null;
      }
      let signed = false;
      try {
        signed = parts.length === 3 && createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`)
          .verify(readFileSync(process.env.ML_FCM_PUBKEY ?? '', 'utf8'), fromB64(parts[2]));
      } catch {
        signed = false;
      }
      const valid = claims !== null
        && form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer'
        && claims.scope === 'https://www.googleapis.com/auth/firebase.messaging'
        && claims.aud === `http://${req.headers.host}/token`
        && (claims.exp ?? 0) > Date.now() / 1000
        && signed;
      if (valid) {
        reply(res, 200, { access_token: ACCESS, expires_in: 3599, token_type: 'Bearer' });
      } else {
        reply(res, 400, { error: 'invalid_grant' });
      }
      return;
    }

    if (/^\/v1\/projects\/[^/]+\/messages:send$/.test(path)) {
      if (req.headers.authorization !== `Bearer ${ACCESS}`) {
        reply(res, 401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
        return;
      }
      const token = String(JSON.parse(raw)?.message?.token ?? '');
      if (token.startsWith('muerto')) {
        reply(res, 404, {
          error: {
            code: 404,
            status: 'NOT_FOUND',
            details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }],
          },
        });
        return;
      }
      if (token.startsWith('limite')) {
        reply(res, 429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } });
        return;
      }
      appendFileSync(log, `${raw}\n`);
      reply(res, 200, { name: `projects/pruebas/messages/${randomBytes(4).toString('hex')}` });
      return;
    }

    reply(res, 404, { error: { code: 404, status: 'NOT_FOUND' } });
  });
}).listen(port, '127.0.0.1');
