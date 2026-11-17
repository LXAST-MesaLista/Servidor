// Representación JSON de las reservas para la app y para el panel.

import * as clock from './clock.js';
import * as qr from './qr.js';
import * as payments from './payments.js';
import { fail } from './http.js';

function base(r) {
  const start = clock.at(r.start_at);
  const end = clock.at(r.end_at);
  return {
    id: r.id,
    status: r.status,
    source: r.source,
    date: clock.ymd(start),
    time: clock.hm(start),
    end_time: clock.hm(end),
    party: r.party_size,
    table: r.table_code,       // S-1, T-2, E-1…
    tables: r.table_codes,     // principal y unidas
    zone: r.zone,
    menu_options: r.menu_options,
    note: r.note,
    deposit: deposit(r),
  };
}

/**
 * RF-44: señal de una reserva de grupo, o null si no lleva. payment: null
 * (sin pagar), captured, refund_pending o refunded.
 */
function deposit(r) {
  if (r.deposit_cents === null) {
    return null;
  }
  const due = r.payment_due_at === null ? null : clock.at(r.payment_due_at);
  return {
    amount: payments.euros(r.deposit_cents),
    cents: r.deposit_cents,
    due: due === null ? null : clock.ymdhm(due),
    seconds_left: due === null ? null : Math.max(0, clock.secondsBetween(clock.now(), due)),
    payment: r.payment_status,
  };
}

function arrivalWindow(r) {
  const start = clock.at(r.start_at);
  return [
    clock.hm(clock.plus(start, -r.arrival_before_min)),
    clock.hm(clock.plus(start, r.arrival_after_min)),
  ];
}

/** Para el titular en la app: incluye el QR vigente si la reserva está confirmada. */
export function client(r) {
  const start = clock.at(r.start_at);
  const deadline = clock.plus(start, -60 * r.change_deadline_h);
  return {
    ...base(r),
    modifiable: r.status === 'confirmed' && clock.now() <= deadline,
    deadline: clock.ymdhm(deadline),
    arrival_window: arrivalWindow(r),
    qr: r.status === 'confirmed' ? qr.make(r.id, r.qr_version) : null,
    // Reservas de grupo: cambiar hora o comensales se pide por teléfono.
    group: r.deposit_cents !== null || r.extra_tables.length > 0,
    payable: r.status === 'pending_payment' && payments.configured()
      && r.payment_due_at !== null && clock.at(r.payment_due_at) > clock.now(),
  };
}

/** Para el personal: nombre y teléfono del titular, llegada y si tiene ticket vigente. */
export function staff(r) {
  const linked = r.user_id !== null;
  return {
    ...base(r),
    name: r.guest_name ?? r.user_name,
    phone: r.guest_phone ?? r.user_phone,
    linked,
    arrived_at: r.arrived_at !== null ? clock.hm(clock.at(r.arrived_at)) : null,
    max_capacity: r.capacity, // plazas sumando las mesas unidas
    arrival_window: arrivalWindow(r),
    has_ticket: r.source === 'local' && !linked && r.status === 'confirmed',
    cancelled_by: r.cancelled_by,
  };
}

/**
 * RF-29 y RP-07: el ticket solo muestra fecha, hora, comensales, QR y código.
 * Deja de existir cuando la reserva se vincula a una cuenta.
 */
export function ticket(r) {
  if (r.source !== 'local' || r.user_id !== null || r.status !== 'confirmed') {
    fail(409, 'no_ticket', 'Esta reserva no tiene un ticket vigente.');
  }
  const start = clock.at(r.start_at);
  return {
    date: clock.ymd(start),
    time: clock.hm(start),
    party: r.party_size,
    code: r.code,
    qr: qr.make(r.id, r.qr_version),
  };
}
