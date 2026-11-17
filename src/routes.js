// Rutas de la API. Prefijo /api/v1; las de /panel exigen sesión del personal
// y las de /admin, rol de administrador (RS-04). La autorización se comprueba
// siempre aquí, en el servidor. Las sesiones se abren con /auth/login o
// /panel/login, que devuelven el token Bearer en «session».
//
// Cada manejador devuelve un objeto. Claves especiales:
//   _status    código HTTP (200 por defecto)
//   _redirect  redirección 303 (vuelta de PayPal)
//   _file, _type, _body   descarga (el CSV de la agenda)

import * as db from './db.js';
import * as clock from './clock.js';
import * as settings from './settings.js';
import * as V from './validate.js';
import * as auth from './auth.js';
import * as booking from './booking.js';
import * as present from './present.js';
import * as admin from './admin.js';
import * as holds from './holds.js';
import * as exporter from './export.js';
import * as stats from './stats.js';
import * as payments from './payments.js';
import * as groups from './group-requests.js';
import * as push from './push.js';
import { Router, body, query, fail, apiUrl } from './http.js';

export const router = new Router();
const r = router;

const dateParam = () => V.date(query('date') ?? clock.ymd(clock.now()));
const searchParam = () => {
  const q = query('q');
  return q === null ? null : V.text(q, 'q', 0, 80);
};
const profile = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone });
const staffProfile = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });
const earlyFlag = (input) => (V.has(input, 'early') ? V.bool(input.early, 'early') : false);

// ---------------------------------------------------------------------------
// Público
// ---------------------------------------------------------------------------

r.add('GET', '/config', async () => ({
  min_party: await settings.get('min_party'),
  max_party: await settings.get('max_party'),
  max_advance_days: await settings.get('max_advance_days'),
  duration_min: await settings.get('duration_min'),
  menu_options: [...(await settings.menuOptions())].map(([id, name]) => ({ id, name })),
  today: clock.ymd(clock.now()),
  // RF-43 y RF-44: grupos más grandes que max_party, con señal si hay pasarela.
  max_group_party: await settings.get('max_group_party'),
  deposit_per_person: (await payments.enabled()) ? await settings.get('deposit_per_person') : 0,
  deposit_hold_min: await settings.get('deposit_hold_min'),
}));

// RF-06: cualquier persona puede consultar la disponibilidad.
r.add('GET', '/availability', async () => ({
  times: await booking.availability(V.date(query('date')), V.int(query('party'), 'party', 1, 255)),
}));

// ---------------------------------------------------------------------------
// Cliente (app y web)
// ---------------------------------------------------------------------------

r.add('POST', '/auth/register', async () => ({
  user: await auth.register(body()), session: auth.issued(), _status: 201,
}));

r.add('POST', '/auth/login', async () => {
  const input = body();
  const u = await auth.login('app', input.email ?? null, input.password ?? null);
  return { user: profile(u), session: auth.issued() };
});

r.add('POST', '/auth/logout', async () => {
  await auth.logout('app');
  return { ok: true };
});

// RF-40: recuperar la contraseña. La respuesta es la misma exista o no la cuenta.
r.add('POST', '/auth/forgot', async () => {
  const input = body();
  V.only(input, ['email']);
  await auth.requestReset(input.email ?? null);
  return { ok: true };
});

r.add('POST', '/auth/reset', async () => {
  await auth.resetPassword(body());
  return { ok: true };
});

r.add('GET', '/me', async () => ({ user: profile(await auth.client()) }));

// RF-04: el cliente modifica su nombre y su teléfono.
r.add('PATCH', '/me', async () => {
  const u = await auth.client();
  const input = body();
  V.only(input, ['name', 'phone']);
  if (V.has(input, 'name')) {
    await db.exec('UPDATE users SET name = ? WHERE id = ?', [V.name(input.name), u.id]);
  }
  if (V.has(input, 'phone')) {
    await db.exec('UPDATE users SET phone = ? WHERE id = ?', [V.phone(input.phone), u.id]);
  }
  return { user: profile(await db.one('SELECT id, name, email, phone FROM users WHERE id = ?', [u.id])) };
});

// RF-05: eliminar la cuenta, confirmando con la contraseña.
r.add('DELETE', '/me', async () => {
  const u = await auth.client();
  const input = body();
  if (!(await auth.verifyPassword(u.id, input.password ?? null))) {
    fail(403, 'bad_password', 'La contraseña no es correcta.');
  }
  await booking.deleteClient(u);
  await auth.logout('app');
  return { ok: true };
});

// Avisos push: la app registra el token de FCM del dispositivo al abrirse y
// lo da de baja al cerrar sesión.
r.add('POST', '/me/devices', async () => {
  const created = await push.register(await auth.client(), body());
  return { ok: true, _status: created ? 201 : 200 };
});
r.add('DELETE', '/me/devices', async () => {
  await push.unregister(await auth.client(), body());
  return { ok: true };
});

// RF-32: avisos de cancelaciones hechas por el restaurante.
r.add('GET', '/me/notifications', async () => {
  const u = await auth.client();
  const rows = await db.all('SELECT * FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY id', [u.id]);
  return {
    notifications: rows.map((n) => ({
      id: n.id, message: n.message, reservation_id: n.reservation_id, created_at: n.created_at,
    })),
  };
});

r.add('POST', '/me/notifications/read', async () => {
  const u = await auth.client();
  await db.exec('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [clock.sql(), u.id]);
  return { ok: true };
});

// RF-14
r.add('GET', '/reservations', async () => {
  const u = await auth.client();
  return { reservations: (await booking.listOwned(u.id)).map(present.client) };
});

// RF-07 a RF-13. 201 si se ha creado; 200 si era una repetición (RF-10).
r.add('POST', '/reservations', async () => {
  const [res, created] = await booking.createForClient(await auth.client(), body());
  return { reservation: present.client(res), replayed: !created, _status: created ? 201 : 200 };
});

// RF-30
r.add('POST', '/reservations/link', async () => ({
  reservation: present.client(await booking.link(await auth.client(), body())),
}));

r.add('GET', '/reservations/{id}', async (p) => {
  const u = await auth.client();
  return { reservation: present.client(await booking.getOwned(u.id, p.id)) };
});

// RF-15
r.add('PATCH', '/reservations/{id}', async (p) => ({
  reservation: present.client(await booking.modifyByHolder(await auth.client(), p.id, body())),
}));

// RF-16
r.add('POST', '/reservations/{id}/cancel', async (p) => ({
  reservation: present.client(await booking.cancelByHolder(await auth.client(), p.id)),
}));

// RF-44: pagar la señal. Devuelve la página de PayPal a la que llevar al
// cliente; {"from": "web"} o {"from": "app"} dice adónde vuelve al terminar.
r.add('POST', '/reservations/{id}/pay', async (p) => {
  const u = await auth.client();
  const input = body();
  V.only(input, ['from']);
  return { approve_url: await payments.start(u, p.id, input.from ?? 'web') };
});

// Vuelta desde PayPal (?token=<pedido>): cobra y redirige a la reserva en la web o la app.
r.add('GET', '/payments/return', async () => ({ _redirect: await payments.handleReturn(query('token')) }));

// Pasarela simulada (solo en el servidor de pruebas): «aprueba» y vuelve.
r.add('GET', '/payments/fake-approve', async () => {
  if (payments.mode() !== 'fake' || !payments.configured()) {
    fail(404, 'not_found', 'Recurso no encontrado.');
  }
  return { _redirect: `${apiUrl()}/payments/return?token=${encodeURIComponent(query('token') ?? '')}` };
});

// RF-43: solicitudes de grupo.
r.add('GET', '/group-requests/times', async () => ({ times: await groups.times(V.date(query('date'))) }));

r.add('GET', '/group-requests', async () => ({ requests: await groups.forClient((await auth.client()).id) }));

r.add('POST', '/group-requests', async () => ({
  requests: await groups.create(await auth.client(), body()), _status: 201,
}));

r.add('POST', '/group-requests/{id}/cancel', async (p) => ({
  requests: await groups.cancelOwn(await auth.client(), p.id),
}));

// ---------------------------------------------------------------------------
// Panel del personal
// ---------------------------------------------------------------------------

r.add('POST', '/panel/login', async () => {
  const input = body();
  const u = await auth.login('panel', input.email ?? null, input.password ?? null);
  return { user: staffProfile(u), session: auth.issued() };
});

r.add('POST', '/panel/logout', async () => {
  await auth.logout('panel');
  return { ok: true };
});

r.add('GET', '/panel/me', async () => ({ user: staffProfile(await auth.staff()) }));

// RF-34: el panel consulta esta marca cada segundo y solo recarga si cambia.
r.add('GET', '/panel/version', async () => {
  await auth.staff();
  await booking.markNoShows();
  return { version: await booking.version() };
});

r.add('GET', '/panel/room', async () => {
  await auth.staff();
  return { tables: await booking.room(), now: clock.hm(clock.now()) };
});

r.add('GET', '/panel/availability', async () => {
  await auth.staff();
  return { times: await booking.availability(V.date(query('date')), V.int(query('party'), 'party', 1, 255), true) };
});

// RF-22 y RF-27
r.add('GET', '/panel/reservations', async () => {
  await auth.staff();
  const day = dateParam();
  return { reservations: (await booking.agenda(day, searchParam())).map(present.staff) };
});

// RF-28 y RF-29
r.add('POST', '/panel/reservations', async () => {
  const staffUser = await auth.staff();
  const res = await booking.createLocal(staffUser.id, body());
  return { reservation: present.staff(res), ticket: present.ticket(res), _status: 201 };
});

r.add('GET', '/panel/reservations/{id}/ticket', async (p) => {
  await auth.staff();
  const res = (await booking.load(p.id)) ?? fail(404, 'not_found', 'Reserva no encontrada.');
  return { ticket: present.ticket(res) };
});

// RF-31. RF-44: {"refund": false} para no devolver la señal (cancelación fuera de plazo).
r.add('POST', '/panel/reservations/{id}/cancel', async (p) => {
  await auth.staff();
  return { reservation: present.staff(await booking.cancelByRestaurant(p.id, body())) };
});

// RF-43: solicitudes de grupo.
r.add('GET', '/panel/group-requests', async () => {
  await auth.staff();
  await booking.markNoShows();
  return { requests: await groups.forStaff() };
});

r.add('GET', '/panel/group-requests/{id}/tables', async (p) => {
  await auth.staff();
  return { tables: await booking.groupTables(p.id) };
});

r.add('POST', '/panel/group-requests/{id}/accept', async (p) => {
  const staffUser = await auth.staff();
  const res = await booking.acceptGroup(staffUser.id, p.id, body());
  return { reservation: present.staff(res), requests: await groups.forStaff() };
});

r.add('POST', '/panel/group-requests/{id}/reject', async (p) => {
  const staffUser = await auth.staff();
  await groups.reject(staffUser.id, p.id, body());
  return { requests: await groups.forStaff() };
});

// RF-21, RF-22 y RF-23: llegada sin QR (búsqueda por nombre o teléfono).
r.add('POST', '/panel/reservations/{id}/arrive', async (p) => {
  await auth.staff();
  const input = body();
  V.only(input, ['early']);
  return { reservation: present.staff(await booking.arrive(p.id, null, earlyFlag(input))) };
});

// RF-19, RF-20, RS-07: llegada con QR.
r.add('POST', '/panel/arrive-qr', async () => {
  await auth.staff();
  const input = body();
  V.only(input, ['qr', 'early']);
  return { reservation: present.staff(await booking.arriveByQr(input.qr ?? null, earlyFlag(input))) };
});

// RF-25
r.add('POST', '/panel/reservations/{id}/complete', async (p) => {
  await auth.staff();
  return { reservation: present.staff(await booking.complete(p.id)) };
});

// RF-26
r.add('POST', '/panel/reservations/{id}/party', async (p) => {
  await auth.staff();
  return { reservation: present.staff(await booking.increaseParty(p.id, body())) };
});

// RF-33
r.add('GET', '/panel/walkin-tables', async () => {
  await auth.staff();
  const tables = await booking.walkInTables(V.int(query('party'), 'party', 1, 50));
  return {
    tables: tables.map((t) => ({
      id: t.id,
      number: t.number,
      code: t.code,
      zone: t.zone,
      min_capacity: t.min_capacity,
      max_capacity: t.max_capacity,
      join_only: t.join_only,
      fits: t.fits,
    })),
  };
});

r.add('POST', '/panel/walkin', async () => {
  const staffUser = await auth.staff();
  return { reservation: present.staff(await booking.walkIn(staffUser.id, body())), _status: 201 };
});

// «Cerrar local»: termina todas las reservas en curso (todas las mesas libres). Pide el PIN.
r.add('POST', '/panel/close', async () => booking.closeLocal(await auth.staff(), body()));

// RF-45: bloqueos de mesas y franjas (personal y administración).
r.add('GET', '/panel/holds', async () => {
  await auth.staff();
  const day = query('date');
  return { holds: day === null ? await holds.upcoming() : await holds.forDate(V.date(day)) };
});

r.add('POST', '/panel/holds', async () => {
  const staffUser = await auth.staff();
  return { holds: await holds.create(staffUser.id, body()), _status: 201 };
});

r.add('DELETE', '/panel/holds/{id}', async (p) => {
  await auth.staff();
  return { holds: await holds.remove(p.id) };
});

// RF-47: reservas de un día en CSV.
r.add('GET', '/panel/reservations.csv', async () => {
  await auth.staff();
  const [file, csv] = await exporter.dayCsv(dateParam());
  return { _file: file, _type: 'text/csv; charset=utf-8', _body: csv };
});

// Cambiar y unir mesas de una reserva confirmada o en curso.
r.add('GET', '/panel/reservations/{id}/free-tables', async (p) => {
  await auth.staff();
  return { tables: await booking.freeTablesFor(p.id) };
});

r.add('POST', '/panel/reservations/{id}/move', async (p) => {
  await auth.staff();
  return { reservation: present.staff(await booking.changeTable(p.id, body())) };
});

r.add('POST', '/panel/reservations/{id}/join', async (p) => {
  await auth.staff();
  return { reservation: present.staff(await booking.joinTables(p.id, body())) };
});

r.add('POST', '/panel/reservations/{id}/separate', async (p) => {
  await auth.staff();
  return { reservation: present.staff(await booking.separateTable(p.id, body())) };
});

// ---------------------------------------------------------------------------
// Administración
// ---------------------------------------------------------------------------

// RF-35
r.add('GET', '/admin/tables', async () => {
  await auth.admin();
  return { tables: await admin.tables() };
});

r.add('POST', '/admin/tables', async () => {
  await auth.admin();
  const saved = await booking.saveTable(null, body());
  return { ...saved, tables: await admin.tables(), _status: 201 };
});

r.add('PATCH', '/admin/tables/{id}', async (p) => {
  await auth.admin();
  const saved = await booking.saveTable(p.id, body());
  return { ...saved, tables: await admin.tables() };
});

// Eliminar una mesa (si no tiene reservas pendientes ni en curso).
r.add('DELETE', '/admin/tables/{id}', async (p) => {
  await auth.admin();
  const deleted = await booking.deleteTable(p.id);
  return { ...deleted, tables: await admin.tables() };
});

// PIN de «Cerrar local» (4 a 8 cifras).
r.add('PUT', '/admin/close-pin', async () => {
  await auth.admin();
  return admin.setClosePin(body());
});

// Plano de la sala (posición y forma de las mesas).
r.add('PUT', '/admin/tables/layout', async () => {
  await auth.admin();
  return { tables: await admin.saveLayout(body()) };
});

// RF-46: estadísticas de un periodo (?from=AAAA-MM-DD&to=AAAA-MM-DD; por defecto, 30 días).
r.add('GET', '/admin/stats', async () => {
  await auth.admin();
  const range = {};
  if (query('from') !== null) range.from = query('from');
  if (query('to') !== null) range.to = query('to');
  return stats.period(range);
});

// Clientes registrados, con búsqueda por nombre, correo o teléfono.
r.add('GET', '/admin/clients', async () => {
  await auth.admin();
  return { clients: await admin.clients(searchParam()) };
});

// RF-36
r.add('GET', '/admin/schedule', async () => {
  await auth.admin();
  return admin.getSchedule();
});

r.add('PUT', '/admin/schedule/slots', async () => {
  await auth.admin();
  return admin.saveSlots(body());
});

r.add('POST', '/admin/schedule/closed', async () => {
  await auth.admin();
  return admin.setClosedDay(body(), true);
});

r.add('POST', '/admin/schedule/open', async () => {
  await auth.admin();
  return admin.setClosedDay(body(), false);
});

// RF-37
r.add('GET', '/admin/settings', async () => {
  await auth.admin();
  return admin.getSettings();
});

r.add('PUT', '/admin/settings', async () => {
  await auth.admin();
  return admin.saveSettings(body());
});

r.add('POST', '/admin/menu-options', async () => {
  await auth.admin();
  return { ...(await admin.saveMenuOption(null, body())), _status: 201 };
});

r.add('PATCH', '/admin/menu-options/{id}', async (p) => {
  await auth.admin();
  return admin.saveMenuOption(p.id, body());
});

// RF-38
r.add('GET', '/admin/staff', async () => {
  await auth.admin();
  return { staff: await admin.staff() };
});

r.add('POST', '/admin/staff', async () => {
  await auth.admin();
  return { staff: await admin.createStaff(body()), _status: 201 };
});

r.add('PATCH', '/admin/staff/{id}', async (p) => {
  const adminUser = await auth.admin();
  return { staff: await admin.updateStaff(adminUser, p.id, body()) };
});
