// RF-44: señal de los grupos grandes con PayPal en modo de pruebas.
//
// Reglas:
//  - Solo pagan señal las solicitudes de grupo aceptadas: deposit_per_person ×
//    comensales. La reserva nace «pendiente de pago» y retiene sus mesas
//    deposit_hold_min minutos; si no se paga, el sistema la cancela.
//  - Al volver de PayPal, el servidor confirma el cobro con PayPal (capture)
//    antes de dar la reserva por confirmada. Si el plazo ya terminó o la
//    reserva ya está pagada, no se cobra.
//  - Sin cobros dobles: cada llamada lleva su PayPal-Request-Id (PayPal no
//    repite la operación) y order_id es único en la base de datos.
//  - Se devuelve si cancela el titular dentro del plazo o cancela el
//    restaurante; fuera de plazo, no. Las devoluciones se apuntan en la misma
//    transacción que la cancelación y se envían después (y por cron si fallan).

import { randomBytes } from 'node:crypto';
import * as db from './db.js';
import * as clock from './clock.js';
import * as settings from './settings.js';
import * as V from './validate.js';
import * as mail from './mail.js';
import * as booking from './booking.js';
import { config } from './config.js';
import { state } from './context.js';
import { fail, apiUrl, frontUrl } from './http.js';

export const CURRENCY = 'EUR';

export function mode() {
  return config('paypal.mode', 'sandbox') === 'fake' ? 'fake' : 'paypal';
}

/** ¿Hay pasarela configurada? La simulada solo existe en el servidor de pruebas. */
export function configured() {
  if (mode() === 'fake') {
    return config('test_clock') === true;
  }
  return String(config('paypal.client_id', '')) !== '' && String(config('paypal.secret', '')) !== '';
}

/** Se pide señal si hay importe por persona y pasarela. */
export async function enabled() {
  return (await settings.get('deposit_per_person')) > 0 && configured();
}

export function gateway() {
  return mode() === 'fake' ? fakeGateway : payPalGateway;
}

/** Pago capturado de una reserva, o null. */
export function capturedFor(reservationId) {
  return db.one(
    "SELECT * FROM payments WHERE reservation_id = ? AND status IN ('captured','refund_pending','refunded') ORDER BY id DESC LIMIT 1",
    [reservationId],
  );
}

/** 6000 → «60 €»; 6050 → «60,50 €»; 123400 → «1.234 €». */
export function euros(cents) {
  const decimals = cents % 100 === 0 ? 0 : 2;
  const [whole, frac] = (cents / 100).toFixed(decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${grouped}${frac !== undefined ? `,${frac}` : ''} €`;
}

/**
 * El titular empieza el pago: crea un pedido en PayPal y devuelve la
 * dirección a la que hay que llevarle para que lo apruebe. from dice si paga
 * desde la web o desde la app, para devolverle allí al terminar.
 */
export async function start(user, reservationId, from = 'web') {
  if (!['web', 'app'].includes(from)) {
    V.invalid('from', 'Debe ser «web» o «app».');
  }
  const r = await booking.getOwned(user.id, reservationId);
  if (r.status !== 'pending_payment') {
    fail(409, 'not_payable', 'Esta reserva no tiene ningún pago pendiente.');
  }
  if (clock.at(r.payment_due_at) <= clock.now()) {
    fail(409, 'payment_expired', 'Se ha terminado el plazo para pagar la señal.');
  }
  if (!configured()) {
    fail(503, 'payments_off', 'El pago con PayPal no está disponible ahora. Llama al restaurante.');
  }
  const attempt = (await db.value('SELECT COUNT(*) FROM payments WHERE reservation_id = ?', [reservationId])) + 1;
  const order = await gateway().createOrder(
    r.deposit_cents,
    CURRENCY,
    String(reservationId),
    `${apiUrl()}/payments/return`,
    frontUrl(`payment_${from}`, { id: reservationId, result: 'cancelado' }),
    `mesalista-r${reservationId}-o${attempt}`,
  );
  await db.exec(
    `INSERT INTO payments (reservation_id, provider, order_id, amount_cents, currency, status, return_to, created_at)
     VALUES (?, ?, ?, ?, ?, 'created', ?, ?)`,
    [reservationId, mode(), order.id, r.deposit_cents, CURRENCY, from, clock.sql()],
  );
  return order.approve_url;
}

/**
 * Vuelta desde PayPal (?token=<pedido>). Cobra solo si la reserva sigue
 * pendiente y dentro de plazo. Devuelve la dirección de la web o de la app
 * (según desde dónde se pagó) a la que redirigir. No necesita sesión: solo
 * puede cobrar un pedido que creó este servidor y que el comprador ha aprobado.
 */
export async function handleReturn(orderId) {
  if (orderId === null || !/^[A-Za-z0-9-]{6,64}$/.test(orderId)) {
    return frontUrl('payment_unknown');
  }
  const found = await db.one('SELECT * FROM payments WHERE order_id = ?', [orderId]);
  if (found === null) {
    return frontUrl('payment_unknown');
  }
  const rid = found.reservation_id;
  const result = await db.tx(async () => {
    const r = await db.one('SELECT * FROM reservations WHERE id = ? FOR UPDATE', [rid]);
    const p = await db.one('SELECT * FROM payments WHERE id = ? FOR UPDATE', [found.id]);
    if (p.status === 'captured') {
      return 'ok';
    }
    if (p.status !== 'created') {
      return 'error';
    }
    // Plazo terminado o reserva ya pagada con otro pedido: no se cobra.
    if (r.status !== 'pending_payment' || clock.at(r.payment_due_at) <= clock.now()) {
      await db.exec("UPDATE payments SET status = 'failed', last_error = 'reserva no pendiente o fuera de plazo' WHERE id = ?", [p.id]);
      return r.status === 'confirmed' ? 'ok' : 'caducado';
    }
    let capture;
    try {
      capture = await gateway().captureOrder(p.order_id, `mesalista-capture-p${p.id}`);
    } catch (e) {
      await db.exec("UPDATE payments SET status = 'failed', last_error = ? WHERE id = ?", [V.cut(e.message, 255), p.id]);
      return 'error';
    }
    if (capture.status !== 'COMPLETED' || capture.amount_cents !== p.amount_cents) {
      await db.exec("UPDATE payments SET status = 'failed', last_error = ? WHERE id = ?", [`captura ${capture.status}`, p.id]);
      return 'error';
    }
    await db.exec("UPDATE payments SET status = 'captured', capture_id = ? WHERE id = ?", [capture.capture_id, p.id]);
    await db.exec("UPDATE reservations SET status = 'confirmed', payment_due_at = NULL WHERE id = ?", [rid]);
    const u = await db.one('SELECT name, email FROM users WHERE id = ?', [r.user_id]);
    if (u !== null) {
      await mail.queueReservation('confirmed', u.email, u.name, r,
        `Hemos recibido la señal de ${euros(p.amount_cents)}.`);
    }
    return 'ok';
  });
  return frontUrl(`payment_${found.return_to}`, { id: rid, result });
}

/**
 * Apunta la devolución de la señal pagada de una reserva (dentro de la
 * transacción de la cancelación). Devuelve el importe, o 0 si no había.
 */
export async function markRefund(reservationId) {
  const p = await db.one("SELECT id, amount_cents FROM payments WHERE reservation_id = ? AND status = 'captured' FOR UPDATE", [reservationId]);
  if (p === null) {
    return 0;
  }
  await db.exec("UPDATE payments SET status = 'refund_pending' WHERE id = ?", [p.id]);
  state().refundsQueued = true;
  return p.amount_cents;
}

/** Envía a PayPal las devoluciones pendientes. Devuelve cuántas se han hecho. */
export async function processRefunds(limit = 20) {
  if (!configured()) {
    return 0;
  }
  let done = 0;
  const pending = await db.all(`SELECT * FROM payments WHERE status = 'refund_pending' ORDER BY id LIMIT ${Math.max(1, limit)}`);
  for (const p of pending) {
    try {
      await gateway().refundCapture(String(p.capture_id), p.amount_cents, p.currency, `mesalista-refund-p${p.id}`);
      await db.exec("UPDATE payments SET status = 'refunded', last_error = NULL WHERE id = ? AND status = 'refund_pending'", [p.id]);
      done++;
    } catch (e) {
      await db.exec('UPDATE payments SET last_error = ? WHERE id = ?', [V.cut(e.message, 255), p.id]);
    }
  }
  return done;
}

// ---------------------------------------------------------------------------
// Pasarelas: crear pedido, cobrarlo y devolverlo
// ---------------------------------------------------------------------------

const money = (cents) => (cents / 100).toFixed(2);

/**
 * PayPal REST (Orders v2), siempre en el entorno sandbox: con estas claves no
 * se puede mover dinero real. Las claves van en config.json (paypal.client_id
 * y paypal.secret) y nunca salen en los registros (RS-11).
 */
export const PAYPAL_BASE = 'https://api-m.sandbox.paypal.com';
let payPalToken = null; // { key, token, expires }

/** Pide un token OAuth a PayPal sandbox con esas claves (lo usa también configure-paypal.js). */
export async function payPalAuth(clientId, secret) {
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    body: 'grant_type=client_credentials',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

const payPalGateway = {
  async token() {
    const key = `${config('paypal.client_id')}:${config('paypal.secret')}`;
    if (payPalToken !== null && payPalToken.key === key && payPalToken.expires > Date.now() + 60_000) {
      return payPalToken.token;
    }
    let result;
    try {
      result = await payPalAuth(config('paypal.client_id'), config('paypal.secret'));
    } catch {
      result = { status: 0, data: null };
    }
    if (result.status !== 200 || typeof result.data?.access_token !== 'string') {
      throw new Error('PayPal: no se ha podido autenticar (revisa client_id y secret)');
    }
    payPalToken = {
      key,
      token: result.data.access_token,
      expires: Date.now() + 1000 * Number(result.data.expires_in ?? 3600),
    };
    return payPalToken.token;
  },

  async call(path, body, requestId) {
    let res;
    try {
      res = await fetch(PAYPAL_BASE + path, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await this.token()}`,
          'PayPal-Request-Id': requestId, // idempotencia: PayPal no repite la operación
          Prefer: 'return=representation',
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      if (e.message?.startsWith('PayPal')) {
        throw e;
      }
      throw new Error(`PayPal ${path}: ${e.cause?.code ?? e.name}`);
    }
    const data = await res.json().catch(() => null);
    if (res.status >= 400 || data === null || typeof data !== 'object') {
      const name = data?.name ?? data?.error ?? '';
      throw new Error(`PayPal ${path}: HTTP ${res.status} ${name}`);
    }
    return data;
  },

  async createOrder(cents, currency, reference, returnUrl, cancelUrl, requestId) {
    const order = await this.call('/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: `reserva-${reference}`,
        custom_id: reference,
        description: 'Señal de la reserva de grupo en MesaLista',
        amount: { currency_code: currency, value: money(cents) },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'MesaLista',
            locale: 'es-ES',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    }, requestId);
    for (const link of order.links ?? []) {
      if (['payer-action', 'approve'].includes(link.rel)) {
        return { id: String(order.id), approve_url: String(link.href) };
      }
    }
    throw new Error('PayPal: el pedido no trae enlace de aprobación');
  },

  async captureOrder(orderId, requestId) {
    const data = await this.call(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, requestId);
    const capture = data.purchase_units?.[0]?.payments?.captures?.[0] ?? null;
    return {
      status: capture?.status ?? data.status ?? 'UNKNOWN',
      capture_id: String(capture?.id ?? ''),
      amount_cents: Math.round(Number(capture?.amount?.value ?? 0) * 100),
    };
  },

  async refundCapture(captureId, cents, currency, requestId) {
    const data = await this.call(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      amount: { currency_code: currency, value: money(cents) },
    }, requestId);
    if (!['COMPLETED', 'PENDING'].includes(data.status)) {
      throw new Error(`PayPal: devolución ${data.status ?? 'desconocida'}`);
    }
  },
};

/**
 * Pasarela simulada para las pruebas automáticas (solo con test_clock):
 * «aprobar» redirige directamente a la vuelta, y cobrar y devolver siempre
 * salen bien.
 */
const fakeGateway = {
  async createOrder() {
    const id = `FAKE-${randomBytes(8).toString('hex')}`;
    return { id, approve_url: `${apiUrl()}/payments/fake-approve?token=${id}` };
  },

  async captureOrder(orderId) {
    const amount = await db.value('SELECT amount_cents FROM payments WHERE order_id = ?', [orderId]);
    return { status: 'COMPLETED', capture_id: `FAKECAP-${orderId.slice(5)}`, amount_cents: Number(amount) };
  },

  async refundCapture() {},
};
