// Parámetros del servicio (RF-37), leídos una vez por petición.

import * as db from './db.js';
import { state } from './context.js';

/** Nombre → [mínimo, máximo] admitidos al modificarlos desde el panel. */
export const RANGES = {
  duration_min: [30, 360],
  slot_step_min: [5, 120],
  min_advance_min: [0, 2880],
  max_advance_days: [1, 365],
  min_party: [1, 50],
  max_party: [1, 50],
  max_future_per_client: [1, 50],
  change_deadline_h: [0, 168],
  arrival_before_min: [0, 120],
  arrival_after_min: [1, 120],
  // RF-43 y RF-44: grupos grandes y señal (0 € = sin señal).
  max_group_party: [2, 200],
  deposit_per_person: [0, 100],
  deposit_hold_min: [5, 1440],
};

export async function all() {
  const s = state();
  if (s.settings === null) {
    const values = {};
    for (const row of await db.all('SELECT name, value FROM settings ORDER BY name')) {
      values[row.name] = Number(row.value);
    }
    s.settings = values;
  }
  return s.settings;
}

export async function get(name) {
  const values = await all();
  if (!Object.hasOwn(values, name)) {
    throw new Error(`Falta el parámetro ${name}`);
  }
  return values[name];
}

export function forget() {
  state().settings = null;
}

/** Opciones de menú activas: Map id → nombre. */
export async function menuOptions() {
  const out = new Map();
  for (const row of await db.all('SELECT id, name FROM menu_options WHERE active ORDER BY id')) {
    out.set(row.id, row.name);
  }
  return out;
}
