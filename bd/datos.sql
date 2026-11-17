-- MesaLista · Datos iniciales imprescindibles
--
-- Solo lo que la API necesita para arrancar: los parámetros del servicio con
-- sus valores iniciales (tabla «Reglas del servicio») y unas opciones de menú
-- habituales. Las mesas, su plano y las franjas de servicio están en
-- restaurante.sql.
--
-- Las cuentas no van aquí porque sus contraseñas se guardan con Argon2id: la
-- primera de administrador la crea install.sh con bin/create-user.js.
--
-- Uso: psql -d mesalista -f datos.sql   (después de esquema.sql)

INSERT INTO settings (name, value) VALUES
  ('duration_min',          120),  -- duración de reserva
  ('slot_step_min',          30),  -- horas de inicio cada N minutos
  ('min_advance_min',        60),  -- antelación mínima
  ('max_advance_days',       30),  -- antelación máxima
  ('min_party',               1),  -- comensales por reserva
  ('max_party',              10),
  ('max_future_per_client',   3),  -- reservas confirmadas futuras por cliente
  ('change_deadline_h',      24),  -- plazo de modificación y de cancelación
  ('arrival_before_min',     15),  -- ventana de llegada
  ('arrival_after_min',      20),
  ('max_group_party',        40),  -- comensales máximos de una solicitud de grupo (RF-43)
  ('deposit_per_person',      5),  -- señal en euros por persona, 0 = sin señal (RF-44)
  ('deposit_hold_min',       15);  -- minutos que se retiene la mesa para pagar

INSERT INTO menu_options (name) VALUES
  ('Sin gluten'), ('Vegetariano'), ('Vegano'), ('Sin lactosa');
