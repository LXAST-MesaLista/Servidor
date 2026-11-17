// Estado de cada petición (o de cada ejecución de un script).
//
// La API atiende muchas peticiones a la vez en el mismo proceso. Lo que es de
// una sola petición (su hora, el usuario de la sesión, la transacción abierta,
// los correos que ha puesto en cola…) viaja en un AsyncLocalStorage: cualquier
// función lo lee con ctx() sin tener que pasarlo de mano en mano.

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** Estado nuevo. `req` solo existe en las peticiones HTTP. */
export function newState(req = null) {
  return {
    req,               // { method, path, query, headers, raw, tooLarge, remote }
    now: null,         // hora fija de la petición (Date)
    user: null,        // usuario de la sesión ya comprobada
    issued: null,      // sesión abierta en esta petición (login o registro)
    body: undefined,   // cuerpo JSON ya leído
    settings: null,    // parámetros del servicio leídos de la base de datos
    mailQueued: false,
    pushQueued: false,
    refundsQueued: false,
  };
}

// Fuera de una petición (scripts y pruebas) se usa un estado común.
const fallback = { state: newState(), tx: null };

/** { state, tx }: estado de la petición y cliente de la transacción abierta. */
export function ctx() {
  return storage.getStore() ?? fallback;
}

export function state() {
  return ctx().state;
}

/** Ejecuta fn con ese contexto. */
export function runWith(store, fn) {
  return storage.run(store, fn);
}
