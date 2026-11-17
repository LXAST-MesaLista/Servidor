-- MesaLista · Configuración inicial del restaurante
--
-- install.sh la carga la primera vez (cuando todavía no hay ninguna mesa ni
-- franja), así el restaurante queda listo para reservar nada más instalar.
-- Edita este archivo ANTES de instalar para que coincida con el local; después,
-- cualquier cambio se hace desde el panel (Administración) sin tocarlo.
--
-- Mesas: 12 en dos zonas (S-1 a S-8 en la sala, T-1 a T-4 en la terraza), de
-- 2 a 10 plazas, con su sitio en el plano, y 2 mesas extra (E-1, E-2) sin plano
-- que solo sirven para unirlas a otras en grupos grandes. El código visible es
-- la inicial de la zona y el número (S-1, T-1, E-1).
--
-- Horario: comidas de 13:00 a 16:00 y cenas de 20:00 a 00:00 todos los días.
--
-- Uso: psql -d mesalista -f restaurante.sql   (después de esquema.sql y datos.sql)

-- pos_x / pos_y: centro de la mesa en el lienzo de 1000 × 600 de su zona.
-- shape: 'rect' (rectangular) o 'round' (redonda).
INSERT INTO dining_tables (number, zone, min_capacity, max_capacity, pos_x, pos_y, shape) VALUES
  (1, 'Sala',    1,  2, 110, 110, 'round'),
  (2, 'Sala',    1,  2, 110, 300, 'round'),
  (3, 'Sala',    2,  4, 330, 110, 'rect'),
  (4, 'Sala',    2,  4, 330, 300, 'rect'),
  (5, 'Sala',    2,  4, 330, 490, 'rect'),
  (6, 'Sala',    4,  6, 580, 140, 'round'),
  (7, 'Sala',    5,  8, 580, 410, 'rect'),
  (8, 'Sala',    7, 10, 840, 300, 'rect'),
  (1, 'Terraza', 1,  2, 150, 150, 'round'),
  (2, 'Terraza', 2,  4, 420, 150, 'rect'),
  (3, 'Terraza', 2,  4, 690, 150, 'rect'),
  (4, 'Terraza', 4,  6, 420, 420, 'round');

-- Mesas extra: solo para unir.
INSERT INTO dining_tables (number, zone, min_capacity, max_capacity, join_only) VALUES
  (1, 'Extra', 1, 4, true),
  (2, 'Extra', 1, 4, true);

-- Franjas de servicio: día de la semana (1 = lunes … 7 = domingo) y horas en
-- minutos desde medianoche (780 = 13:00, 960 = 16:00, 1200 = 20:00, 1440 = 00:00).
-- Un día sin franjas está cerrado.
INSERT INTO service_slots (weekday, open_min, close_min) VALUES
  (1, 780, 960), (1, 1200, 1440),
  (2, 780, 960), (2, 1200, 1440),
  (3, 780, 960), (3, 1200, 1440),
  (4, 780, 960), (4, 1200, 1440),
  (5, 780, 960), (5, 1200, 1440),
  (6, 780, 960), (6, 1200, 1440),
  (7, 780, 960), (7, 1200, 1440);
