// RF-47: reservas de un día en CSV, para abrirlas en Excel o LibreOffice.

import * as clock from './clock.js';
import * as settings from './settings.js';
import { agenda } from './booking.js';

const STATUS = {
  confirmed: 'Confirmada',
  seated: 'En curso',
  completed: 'Completada',
  cancelled: 'Cancelada',
  no_show: 'No presentada',
  pending_payment: 'Pendiente de pago',
};
const SOURCE = { app: 'App', local: 'Local', walkin: 'Sin reserva' };

/**
 * Una celda CSV. Las que empiezan por = + - @ (o tabulador) se marcan con un
 * apóstrofo para que la hoja de cálculo no las ejecute como fórmula, salvo
 * los números y teléfonos («+34600…»), que no pueden serlo.
 */
export function cell(value) {
  let s = String(value).replace(/\r\n|\r/g, '\n');
  if (typeof value !== 'number' && s !== '' && '=+-@\t'.includes(s[0]) && !/^[+-]?[0-9][0-9 .]*$/.test(s)) {
    s = `'${s}`;
  }
  return `"${s.replaceAll('"', '""')}"`;
}

/** Devuelve [nombre de archivo, contenido]. */
export async function dayCsv(day) {
  const options = await settings.menuOptions();
  const rows = [['Fecha', 'Hora', 'Fin', 'Mesas', 'Zona', 'Comensales', 'Estado', 'Origen', 'Cliente', 'Teléfono',
    'Opciones de menú', 'Nota', 'Llegada']];
  for (const r of await agenda(day, null)) {
    const start = clock.at(r.start_at);
    rows.push([
      clock.dmy(start),
      clock.hm(start),
      clock.hm(clock.at(r.end_at)),
      r.table_codes.join('+'),
      r.zone,
      r.party_size,
      STATUS[r.status] ?? r.status,
      SOURCE[r.source] ?? r.source,
      r.guest_name ?? r.user_name ?? '',
      r.guest_phone ?? r.user_phone ?? '',
      r.menu_options.map((id) => options.get(id) ?? '').join(', '),
      r.note ?? '',
      r.arrived_at !== null ? clock.hm(clock.at(r.arrived_at)) : '',
    ]);
  }
  // BOM y «;»: Excel en español abre el archivo con los acentos y las columnas bien.
  const csv = `﻿${rows.map((row) => row.map(cell).join(';')).join('\r\n')}\r\n`;
  return [`reservas-${clock.ymd(day)}.csv`, csv];
}
