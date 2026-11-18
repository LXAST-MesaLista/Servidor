#!/usr/bin/env node
// Estado de los servicios externos y de sus colas (lo usa «sudo mesalista estado»):
//   - Correo (Azure Communication Services): ¿acepta Azure la clave? (sin enviar nada)
//   - Avisos push (Firebase Cloud Messaging): ¿da Google un token con la cuenta de servicio?
//   - PayPal sandbox: ¿acepta PayPal el Client ID y el Secret? ¿se pide señal?
// y, de cada uno, lo que espera en la base de datos (correos, avisos, devoluciones).
// No envía correos ni avisos, no cobra nada y no muestra ninguna clave.
//
// Cada línea empieza por ✔ (funciona), ✘ (falla), ! (funciona, pero hay que
// mirarlo) o – (sin configurar, es opcional). Sale con 1 si hay algún ✘.

import { config } from '../src/config.js';
import * as db from '../src/db.js';
import * as mail from '../src/mail.js';
import * as push from '../src/push.js';
import * as payments from '../src/payments.js';
import * as settings from '../src/settings.js';
import { run } from './lib/cli.js';

const MARCAS = { ok: '✔', mal: '✘', aviso: '!', nada: '–' };
let fallos = 0;

function linea(estado, texto, detalle = null) {
  if (estado === 'mal') {
    fallos++;
  }
  console.log(`${MARCAS[estado]} ${texto}`);
  if (detalle) {
    console.log(`    ${detalle}`);
  }
}

const minutos = (m) => (m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} días`);

/**
 * Cola de envío (email_outbox o push_outbox): pendientes, los que ya no se
 * reintentan (5 intentos) y cuánto lleva esperando el más antiguo. Si el
 * servicio está configurado y algo espera más de 10 minutos, el worker
 * (cron, cada minuto) no está enviando.
 */
async function cola(tabla, nombre, configurado) {
  let fila;
  try {
    fila = await db.one(
      `SELECT COUNT(*) FILTER (WHERE attempts < 5)::int AS pendientes,
              COUNT(*) FILTER (WHERE attempts >= 5)::int AS fallidos,
              COALESCE(EXTRACT(EPOCH FROM LOCALTIMESTAMP - MIN(created_at) FILTER (WHERE attempts < 5)) / 60, 0)::int AS espera,
              (SELECT last_error FROM ${tabla} WHERE last_error IS NOT NULL ORDER BY id DESC LIMIT 1) AS error
         FROM ${tabla}`,
    );
  } catch (e) {
    linea('mal', `  cola de ${nombre}: no se puede consultar (${e.message})`);
    return;
  }
  const { pendientes, fallidos, espera, error } = fila;
  if (!configurado) {
    if (pendientes > 0) {
      linea('nada', `  ${pendientes} ${nombre} esperan en la cola hasta que se configure`);
    }
    return;
  }
  if (pendientes === 0 && fallidos === 0) {
    linea('ok', `  cola de ${nombre}: vacía (todo enviado)`);
    return;
  }
  if (pendientes > 0) {
    const atascada = espera > 10;
    linea(atascada ? 'mal' : 'ok',
      `  cola de ${nombre}: ${pendientes} pendientes, el más antiguo hace ${minutos(espera)}`,
      atascada ? `no salen: mira /var/log/mesalista/worker.log${error ? ` · último error: ${error}` : ''}` : null);
  }
  if (fallidos > 0) {
    linea('aviso', `  ${fallidos} ${nombre} sin enviar tras 5 intentos`, error ? `último error: ${error}` : null);
  }
}

async function correo() {
  const configurado = config('mail.enabled') === true && String(config('mail.connection_string', '')) !== '';
  if (!configurado) {
    linea('nada', 'Correo (Azure Communication Services): sin configurar', 'sudo mesalista correo');
  } else {
    try {
      const status = await mail.checkCredentials();
      if (status === 400 || status === 202) {
        linea('ok', `Correo (Azure): clave aceptada · remitente ${config('mail.sender', '')}`);
      } else if (status === 401 || status === 403) {
        linea('mal', `Correo (Azure): Azure rechaza la clave (HTTP ${status})`, 'sudo mesalista correo con la cadena de conexión nueva');
      } else if (status === 429) {
        linea('aviso', 'Correo (Azure): límite de envíos de Azure alcanzado; los correos salen más tarde');
      } else {
        linea('aviso', `Correo (Azure): respuesta inesperada de Azure (HTTP ${status})`, 'prueba a enviar uno: sudo mesalista correo');
      }
    } catch (e) {
      // Un tiempo de espera no demuestra que la clave falle: solo se avisa.
      if (/Timeout|Abort/.test(e.message)) {
        linea('aviso', 'Correo (Azure): Azure no ha respondido a tiempo', 'prueba a enviar uno: sudo mesalista correo');
      } else {
        linea('mal', `Correo (Azure): no se puede conectar con Azure (${e.message})`);
      }
    }
  }
  await cola('email_outbox', 'correos', configurado);
}

async function avisosPush() {
  const configurado = push.configured();
  if (!configurado) {
    linea('nada', 'Avisos push (Firebase): sin configurar', 'sudo mesalista push <cuenta-de-servicio.json>');
  } else {
    try {
      await push.checkCredentials();
      const dispositivos = await db.value('SELECT COUNT(*)::int FROM push_devices').catch(() => null);
      linea('ok', `Avisos push (Firebase): cuenta de servicio aceptada · proyecto ${config('fcm.project_id')}`
        + (dispositivos !== null ? ` · ${dispositivos} móviles registrados` : ''));
    } catch (e) {
      linea('mal', `Avisos push (Firebase): ${e.message}`, 'sudo mesalista push <cuenta-de-servicio.json> con una clave nueva');
    }
  }
  await cola('push_outbox', 'avisos push', configurado);
}

async function paypal() {
  if (!payments.configured()) {
    linea('nada', 'PayPal sandbox: sin configurar (los grupos se confirman sin señal)', 'sudo mesalista paypal');
    return;
  }
  let status = 0;
  try {
    ({ status } = await payments.payPalAuth(String(config('paypal.client_id')), String(config('paypal.secret'))));
  } catch {
    status = 0;
  }
  if (status !== 200) {
    linea('mal', `PayPal sandbox: no acepta las claves (${status === 0 ? 'sin respuesta' : `HTTP ${status}`})`, 'sudo mesalista paypal');
    return;
  }
  const senal = Number(await settings.get('deposit_per_person').catch(() => 0));
  linea(senal > 0 ? 'ok' : 'aviso', senal > 0
    ? `PayPal sandbox: claves aceptadas · señal de ${payments.euros(senal * 100)} por persona en los grupos`
    : 'PayPal sandbox: claves aceptadas, pero la señal por persona es 0 (Administración > Parámetros)');
  try {
    const p = await db.one(`SELECT COUNT(*) FILTER (WHERE status = 'refund_pending')::int AS devolver,
                                   COUNT(*) FILTER (WHERE status = 'failed')::int AS fallidos
                              FROM payments`);
    if (p.devolver > 0) {
      linea('aviso', `  ${p.devolver} devoluciones de señal pendientes (se reintentan cada minuto)`);
    }
    if (p.fallidos > 0) {
      linea('aviso', `  ${p.fallidos} pagos fallidos (mira el panel de PayPal sandbox)`);
    }
  } catch (e) {
    linea('mal', `  pagos: no se puede consultar (${e.message})`);
  }
}

run(async () => {
  await correo();
  await avisosPush();
  await paypal();
  return fallos > 0 ? 1 : 0;
});
