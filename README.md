# MesaLista · Servidor

Servidor del servicio de reserva de mesas MesaLista: API REST en **Node.js** con
**PostgreSQL 16**, detrás de **nginx** (HTTPS), en una máquina virtual de Azure
con Ubuntu Server 24.04. Es una de las tres partes del proyecto:

| Parte | Cómo se conecta |
|---|---|
| **Servidor** (este repositorio) | Ofrece la API en `https://<dominio>/api/v1/` |
| Web ([LXPT-UIB/WEB](https://github.com/LXPT-UIB/WEB)) | Su servidor llama a la API con un token Bearer |
| App ([LXPT-UIB/APP](https://github.com/LXPT-UIB/APP)) | Android (Kotlin y Jetpack Compose): llama a la API con un token Bearer y recibe avisos push por FCM |

Todas las reglas del servicio (disponibilidad, plazos, mesas, QR, pagos…) están
en el servidor: la web y la app solo muestran datos y envían peticiones.

**Para los equipos de la web y de la app:** [`docs/integracion.md`](docs/integracion.md)
explica cómo conectarse y [`docs/openapi.yaml`](docs/openapi.yaml) describe todas
las rutas.

## Arquitectura

```
Internet ──HTTPS──▶ nginx (TLS, cabeceras de seguridad)
                       ├── /api/v1/*  ──HTTP──▶ Node.js (mesalista-api, 127.0.0.1:8091) ──▶ PostgreSQL 16
                       └── /          ──HTTP──▶ web (mesalista-web, 127.0.0.1:8092; proyecto aparte)
cron ──▶ bin/worker.js (cada minuto y a diario)
```

- **Node.js 20 o superior**, sin framework: `node:http` y un enrutador propio.
  Dos dependencias: [`pg`](https://node-postgres.com) (PostgreSQL) y
  [`argon2`](https://github.com/ranisalt/node-argon2) (contraseñas, RS-02).
- Cada petición lleva su propio estado (hora, sesión, transacción) en un
  `AsyncLocalStorage` (`src/context.js`), así que el proceso atiende muchas a la vez.
- Las fechas se tratan en hora de Madrid (`TZ=Europe/Madrid`) y se guardan como
  `timestamp` sin zona.
- RF-09: las mesas candidatas se bloquean con `SELECT … FOR UPDATE` antes de
  asignar una, y una restricción de exclusión de PostgreSQL rechaza además
  cualquier solapamiento que se escapara.
- Los cambios de las reservas y de las solicitudes de grupo se avisan por push
  (FCM) y en los avisos de la app y de la web. El correo (Azure Communication
  Services) solo se usa para restablecer la contraseña.
- Correos, avisos push y devoluciones de PayPal se apuntan en la misma transacción que el cambio y se envían después de
  responder; lo que falle lo reintenta `bin/worker.js`.

## Estructura

```
src/
  server.js        Entrada: servidor HTTP (node src/server.js)
  app.js           Cada petición: HTTPS, JSON, errores y envíos después de responder
  routes.js        Todas las rutas de /api/v1
  booking.js       Reglas de las reservas: disponibilidad, mesas, llegadas, sala
  auth.js          Contraseñas, sesiones con token Bearer y roles
  admin.js · holds.js · group-requests.js · payments.js · stats.js · export.js
  mail.js · push.js · qr.js · present.js
  config.js · context.js · clock.js · db.js · http.js · validate.js · settings.js · schedule.js
bin/
  worker.js        Tareas de cron (no presentadas, señales, correos, push, limpieza diaria)
  create-user.js   Crea cuentas del personal (la primera de administrador)
  set-close-pin.js Fija el PIN de «Cerrar local» (lo usa install.sh)
  configure-mail.js · configure-fcm.js · configure-paypal.js · write-config.js
  (en el servidor se usan con el comando «mesalista»)
bd/
  esquema.sql      Tablas, vista, restricción contra solapamientos y procedimientos
  datos.sql        Datos imprescindibles: parámetros del servicio y opciones de menú
  restaurante.sql  Configuración inicial del local: 14 mesas con plano y franjas de servicio
config/
  config.example.json   (config.json lo genera install.sh y no se sube a Git)
data/common-passwords.txt
despliegue/
  install.sh       Instalación completa en Azure (Ubuntu 24.04)
  mesalista        Comando de administración (se instala en /usr/local/bin)
  nginx-mesalista.conf, mesalista-api.service, permisos.sql, backup.sh, restore.sh
docs/              openapi.yaml, integracion.md, manual-rutas.md/.pdf (cómo funcionan las rutas)
                   y manual-base-de-datos.md/.pdf (cómo se conecta con PostgreSQL), con diagramas
```

## Configuración (`config/config.json`)

| Clave | Para qué |
|---|---|
| `listen` | Dirección y puerto del proceso de Node.js (`127.0.0.1:8091`) |
| `db` | Conexión a PostgreSQL |
| `domain` | Dominio público, sin `https://` (etiqueta DNS de la IP pública de Azure) |
| `qr_secret` | Clave de los QR (RS-07): 64 caracteres hexadecimales aleatorios. Si cambia, los QR emitidos dejan de valer |
| `require_https` | RS-01: la API rechaza lo que no llega por HTTPS (nginx lo indica con `X-Forwarded-Proto`) |
| `trusted_proxies` | Desde dónde se aceptan `X-Forwarded-For` y `X-Forwarded-Proto` (nginx y la web, en la misma máquina) |
| `front` | Páginas de la web y de la app a las que el servidor envía al cliente: `reset` (RF-40), `payment_web`, `payment_app` y `payment_unknown` (RF-44). `{token}`, `{id}` y `{result}` se sustituyen |
| `mail` | Azure Communication Services Email (`bin/configure-mail.js`): solo el correo para restablecer la contraseña. Sin cadena de conexión, espera en `email_outbox` |
| `fcm` | Cuenta de servicio de Firebase para los avisos push (`bin/configure-fcm.js`) |
| `paypal` | Claves de PayPal **sandbox** (`bin/configure-paypal.js`). Sin claves, los grupos aceptados se confirman sin señal |

## Instalación en Azure

1. Máquina virtual con **Ubuntu Server 24.04 LTS**, IP pública estática y una
   **etiqueta DNS** (p. ej. `mesalista.spaincentral.cloudapp.azure.com`).
2. Grupo de seguridad de red: **80 y 443** abiertos a todos; **22** solo desde tu IP.
3. En la máquina:

   ```bash
   git clone https://github.com/LXPT-UIB/Servidor.git ~/Servidor
   cd ~/Servidor && sudo bash despliegue/install.sh
   ```

   Instala Node.js (NodeSource), PostgreSQL, nginx y certbot. Pide el dominio,
   un correo para Let's Encrypt, el correo del administrador y (la primera vez)
   la cadena de conexión y el remitente de Azure Communication Services; se
   pueden dejar en blanco. Al final, la contraseña del administrador. El dominio
   también se puede dar de antemano:
   `sudo bash despliegue/install.sh --dominio mesalista.spaincentral.cloudapp.azure.com`.

   El repositorio puede estar en la carpeta personal: en Ubuntu 24.04 tiene
   permisos 750 y el usuario `postgres` no puede entrar, así que el script le
   pasa los `.sql` por la entrada estándar en lugar de por su ruta.

   **Sin preguntas** (para automatizarlo): `sudo bash despliegue/install.sh --no-interactivo`,
   con los datos en variables de entorno (`SERVER_DOMAIN`, `LE_EMAIL`, `ADMIN_EMAIL`,
   `ML_ADMIN_PASSWORD`, `ML_CLOSE_PIN` y, si se quiere, `MAIL_CONNECTION` y `MAIL_SENDER`;
   `sudo bash despliegue/install.sh --help`). Así lo usa el despliegue con Ansible de
   [LXPT-UIB/despliegue-mesalista-ansible](https://github.com/LXPT-UIB/despliegue-mesalista-ansible),
   que instala el servidor, la web y PayPal, el correo y Firebase con una sola orden.
4. Opcional, cuando se tengan las claves:

   ```bash
   sudo mesalista correo
   sudo mesalista push <cuenta-de-servicio.json>
   sudo mesalista paypal
   ```

Queda así:

| Qué | Dónde |
|---|---|
| API | `https://<dominio>/api/v1/` → nginx → `mesalista-api.service` (Node.js en `127.0.0.1:8091`) |
| Código y `config.json` | `/opt/mesalista-servidor` (dueño `root`, grupo `mesalista`) |
| Sitio de nginx | `/etc/nginx/sites-available/mesalista`. Sin la web, solo la API (`despliegue/nginx-mesalista.conf`). Con la web ([LXPT-UIB/WEB](https://github.com/LXPT-UIB/WEB), en `/opt/mesalista-web`), los dos instaladores generan el mismo sitio con la plantilla de la web, así que ninguno pisa al otro. Si quedaba Apache de una instalación anterior, se desactiva |
| Base de datos | PostgreSQL 16 solo en local; dueño `mesalista_owner`, la API entra como `mesalista` (solo lee y escribe datos) |
| Tareas | `worker.js` cada minuto, `worker.js --diario` a las 04:00 y copia a las 03:30 (`/etc/cron.d/mesalista`) |
| Copias | `/var/backups/mesalista`, las de los últimos 14 días |
| Registros | `sudo mesalista logs` (diario de systemd) y `/var/log/mesalista` |

### Administración del servidor

`install.sh` instala el comando `mesalista`. Funciona desde cualquier carpeta
(se coloca en `/opt/mesalista-servidor` y usa el usuario que toca):

| Orden | Para qué |
|---|---|
| `sudo mesalista estado` | Comprueba todo: servicios (API, web, nginx, PostgreSQL, cron), HTTPS y caducidad del certificado, que Azure, Firebase y PayPal aceptan sus claves (sin enviar ni cobrar nada), las colas de correos y avisos, la última copia, el disco y el cortafuegos. ✔ funciona · ✘ falla · ! hay que mirarlo · – opcional sin configurar |
| `sudo mesalista logs` | Últimos mensajes de la API |
| `sudo mesalista reiniciar` | Reinicia la API (tras cambiar `config.json` a mano) |
| `sudo mesalista usuario admin\|staff <correo> "<nombre>"` | Crea una cuenta del personal |
| `sudo mesalista pin` | Cambia el PIN de «Cerrar local» |
| `sudo mesalista correo` · `push <archivo.json>` · `paypal` | Configura Azure, Firebase o PayPal y reinicia la API |
| `sudo mesalista worker [--diario]` | Lanza a mano las tareas de cron |

La carpeta `/opt/mesalista-servidor` solo la pueden leer `root` y el usuario
`mesalista` (contiene `config.json` con las claves): por eso no se puede entrar
en ella con el usuario normal, y conviene usar siempre `sudo mesalista …`.

**Actualizar:** `git pull` y volver a ejecutar `sudo bash despliegue/install.sh`
(no borra datos y conserva `config.json`). Para empezar de cero:
`sudo bash despliegue/install.sh --reset-db` (pide escribir `BORRAR`).

**Cambiar de dominio:** poner la nueva etiqueta DNS en Azure y ejecutar
`sudo bash despliegue/install.sh --dominio <nuevo>`. Cambia `domain` y las
direcciones de la web en `config.json` (el resto se conserva), rehace el sitio
de nginx y pide el certificado para el nuevo nombre.

**Si falla PostgreSQL durante la instalación:**

| Síntoma | Qué mirar |
|---|---|
| `could not change directory` o `Permission denied` al cargar el esquema | El script trabaja desde `/` y pasa los archivos por la entrada estándar. A mano: `sudo -u postgres psql -d mesalista -f - < bd/esquema.sql`. |
| `PostgreSQL no arranca` | `pg_lsclusters` y `journalctl -u postgresql@16-main`. Si falta el clúster `16/main`, el script lo crea. |
| Esquema a medias tras un error | `esquema.sql` y `datos.sql` se cargan en una sola transacción: si algo falla no queda nada, y basta con volver a ejecutar el script. |

**Restaurar una copia** en un servidor limpio: `install.sh` y después
`sudo bash /usr/local/lib/mesalista/restore.sh <copia.tar.gz>`.

Los cambios futuros del esquema necesitarán scripts de migración: `install.sh`
solo carga `esquema.sql` en una base de datos vacía o con `--reset-db`.

## Restaurante preconfigurado

La instalación deja el restaurante listo para reservar. La primera vez carga
`bd/restaurante.sql` (solo si aún no hay ninguna mesa ni franja) y pide el PIN
de «Cerrar local»:

| Qué | Configuración inicial |
|---|---|
| Mesas | Sala S-1 a S-8 y terraza T-1 a T-4 (de 2 a 10 plazas), con su sitio en el plano; extra E-1 y E-2 (4 plazas) solo para unir |
| Franjas | Comidas de 13:00 a 16:00 y cenas de 20:00 a 00:00, todos los días |
| Parámetros | Reservas de 2 horas, de 1 a 10 comensales, grupos hasta 40, señal de 5 € por persona… (`bd/datos.sql`) |
| Menú | Sin gluten, vegetariano, vegano y sin lactosa |
| Cuentas | El administrador (lo pide `install.sh`); el personal se da de alta en el panel |

Para otro local, **edita `bd/restaurante.sql` antes de instalar** (el archivo
explica cada valor). Una vez instalado, todo se cambia desde el panel, en
Administración, o con la API (`/api/v1/admin/*`, ver `docs/openapi.yaml`).

## La API en resumen

- Todas las rutas empiezan por `/api/v1/` y usan JSON.
- `POST /api/v1/auth/login` (clientes) y `POST /api/v1/panel/login` (personal)
  devuelven `session.token`. En las peticiones siguientes va en la cabecera
  `Authorization: Bearer <token>`. Un token de cliente no sirve en el panel ni al revés.
- Los errores tienen siempre la forma `{"error": {"code": "…", "message": "…"}}`.
- La web llama a la API desde su servidor y envía la IP del navegador en
  `X-Forwarded-For` (solo se acepta desde `trusted_proxies`).
- Al pagar la señal se indica `{"from": "web"}` o `{"from": "app"}`; al terminar,
  PayPal devuelve al cliente a la plantilla `front.payment_web` o `front.payment_app`.
- Avisos push: la app registra su dispositivo en `POST /api/v1/me/devices`; cada
  cambio de una reserva o de una solicitud de grupo envía un aviso con `data.type`
  y `data.reservation_id` (los cambios ya no se avisan por correo). Necesita la cuenta de servicio de Firebase
  (`bin/configure-fcm.js`).

Todo el detalle, en [`docs/integracion.md`](docs/integracion.md) y
[`docs/openapi.yaml`](docs/openapi.yaml).
