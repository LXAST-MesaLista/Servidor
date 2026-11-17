// Configuración del servidor (config/config.json) y zona horaria.
//
// Este módulo se carga antes que ningún otro: fija la zona de Madrid para
// todas las fechas de Node.js (regla 2) y lee config.json una sola vez.
// ML_CONFIG permite usar otro archivo (p. ej. el de la instalación).

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TZ = 'Europe/Madrid';

/** Raíz del proyecto (donde están src/, bin/, data/ y config/). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG_FILE = process.env.ML_CONFIG
  ? resolve(process.env.ML_CONFIG)
  : join(ROOT, 'config', 'config.json');

function load() {
  if (!existsSync(CONFIG_FILE)) {
    console.error(`Falta ${CONFIG_FILE} (copia config/config.example.json)`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error(`${CONFIG_FILE} no es JSON válido: ${e.message}`);
    process.exit(1);
  }
}

/**
 * Objeto de configuración. Es mutable a propósito: los scripts de
 * configuración y las pruebas prueban valores nuevos antes de guardarlos.
 */
export const settings = load();

/** Valor de configuración con notación de puntos: config('db.host'). */
export function config(key, fallback = undefined) {
  let value = settings;
  for (const part of key.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) {
      return fallback;
    }
    value = value[part];
  }
  return value;
}
