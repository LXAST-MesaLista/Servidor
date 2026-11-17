#!/usr/bin/env bash
# MesaLista · instalación del servidor (API en Node.js + PostgreSQL) en una
# máquina virtual de Microsoft Azure con Ubuntu Server 24.04 LTS
#
# Desde la copia del repositorio en la máquina:
#   sudo bash despliegue/install.sh                      instala o actualiza
#   sudo bash despliegue/install.sh --dominio <dominio>  cambia el dominio guardado
#   sudo bash despliegue/install.sh --reset-db           además borra y recrea la base de datos
#
# Se puede ejecutar varias veces: no borra datos salvo con --reset-db.
# Los datos que pide la primera vez se guardan en /etc/mesalista/install.env.
#
# Queda así en el servidor:
#   /opt/mesalista-servidor          la API (src/, bin/, node_modules/) y config/config.json
#   mesalista-api.service            el proceso de Node.js, en 127.0.0.1:8091
#   Apache                           HTTPS en https://<dominio>/api/v1/ → Node.js
#   /var/www/mesalista-web           raíz de la web (la instala su propio proyecto)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/mesalista-servidor
CONFIG=$APP_DIR/config/config.json
WEB_DIR=/var/www/mesalista-web
LIB_DIR=/usr/local/lib/mesalista
ETC_DIR=/etc/mesalista
ENV_FILE=$ETC_DIR/install.env
DB_NAME=mesalista
APP_USER=mesalista
API_PORT=8091
NODE_MAJOR=24

RESET_DB=0
NUEVO_DOMINIO=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --reset-db)  RESET_DB=1 ;;
        --dominio)   NUEVO_DOMINIO=${2:-}; shift ;;
        --dominio=*) NUEVO_DOMINIO=${1#*=} ;;
        -h|--help)   sed -n '2,11p' "$0"; exit 0 ;;
        *)           echo "Opción desconocida: $1 (usa --help)" >&2; exit 1 ;;
    esac
    shift
done

say()  { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; }

[[ $EUID -eq 0 ]] || { warn "Ejecuta el script con sudo."; exit 1; }
[[ -f "$REPO_DIR/bd/esquema.sql" && -f "$REPO_DIR/src/server.js" ]] \
    || { warn "No encuentro bd/ y src/ en $REPO_DIR."; exit 1; }
# shellcheck source=/dev/null
source /etc/os-release
[[ "$ID" == "ubuntu" && "$VERSION_ID" == "24.04" ]] \
    || warn "Pensado para Ubuntu Server 24.04 LTS; detectado $PRETTY_NAME."

# PostgreSQL se maneja como el usuario «postgres», que no puede entrar en las
# carpetas personales (en Ubuntu 24.04 /home/<usuario> es privada, permisos 750)
# y por tanto no puede leer los .sql de la copia del repositorio. Por eso el
# script trabaja desde «/» y los .sql llegan a psql por la entrada estándar,
# que abre root.
cd /
psql_admin() { sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 "$@"; }
# psql_owner ARCHIVO…: los ejecuta en una sola transacción como mesalista_owner
# (dueño de todo); si algo falla, no queda nada a medias.
psql_owner() {
    { printf 'SET ROLE mesalista_owner;\n'; cat -- "$@"; } | psql_admin -1 -d "$DB_NAME" -f -
}
# Valor de config.json (vacío si no existe).
config_value() {  # config_value ARCHIVO "db.pass"
    node -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
             const v = process.argv[2].split(".").reduce((o, k) => (o ?? {})[k], c);
             process.stdout.write(v === undefined || v === null ? "" : String(v));' "$1" "$2" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Datos de la instalación
# ---------------------------------------------------------------------------
mkdir -p "$ETC_DIR"
chmod 700 "$ETC_DIR"
# shellcheck source=/dev/null
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"

ask() {  # ask VARIABLE "Pregunta" [secreto]
    local var=$1 prompt=$2 secret=${3:-} value
    [[ -n "${!var:-}" ]] && return
    if [[ -n "$secret" ]]; then read -rsp "$prompt: " value; echo; else read -rp "$prompt: " value; fi
    printf -v "$var" '%s' "$value"
}
normalizar_dominio() {
    printf '%s' "$1" | tr 'A-Z' 'a-z' | sed -e 's#^https\?://##' -e 's#/.*$##' -e 's#:.*$##'
}

say "Configuración"
# El dominio es la etiqueta DNS de la IP pública de Azure (Dirección IP
# pública > Configuración > Etiqueta de nombre DNS): con una IP estática,
# apunta siempre a esta máquina.
[[ -n "$NUEVO_DOMINIO" ]] && SERVER_DOMAIN=$NUEVO_DOMINIO
ask SERVER_DOMAIN "Dominio del servidor (p. ej. mesalista.spaincentral.cloudapp.azure.com)"
SERVER_DOMAIN=$(normalizar_dominio "$SERVER_DOMAIN")
[[ "$SERVER_DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
    || { warn "«$SERVER_DOMAIN» no es un dominio válido."; exit 1; }
DOMAIN=$SERVER_DOMAIN
ask LE_EMAIL "Correo para avisos de Let's Encrypt"
ask ADMIN_EMAIL "Correo de la cuenta de administrador de MesaLista"
# Las credenciales de correo solo se piden al crear config.json y se guardan
# allí, no en install.env.
if [[ ! -f "$CONFIG" ]]; then
    echo "Correo con Azure Communication Services: cadena de conexión del recurso Communication Services"
    echo "(Configuración > Claves) y remitente de su dominio (DoNotReply@….azurecomm.net)."
    echo "Déjalos en blanco para configurarlos más tarde con $APP_DIR/bin/configure-mail.js."
    ask MAIL_CONNECTION "Cadena de conexión de Azure" secret
    ask MAIL_SENDER "Remitente"
fi
umask 077
{
    printf 'SERVER_DOMAIN=%q\n' "$SERVER_DOMAIN"
    printf 'LE_EMAIL=%q\n' "$LE_EMAIL"
    printf 'ADMIN_EMAIL=%q\n' "$ADMIN_EMAIL"
} > "$ENV_FILE"
umask 022

# Let's Encrypt necesita que el dominio apunte a la IP pública de esta máquina.
IP_DOMINIO=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR == 1 { print $1 }' || true)
IP_PUBLICA=$(curl -s --max-time 3 -H Metadata:true \
    "http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text" || true)
if [[ -z "$IP_DOMINIO" ]]; then
    warn "$DOMAIN no resuelve todavía: revisa la etiqueta DNS de la IP pública en Azure."
elif [[ "$IP_PUBLICA" =~ ^[0-9.]+$ && "$IP_DOMINIO" != "$IP_PUBLICA" ]]; then
    warn "$DOMAIN apunta a $IP_DOMINIO, pero la IP pública de esta máquina es $IP_PUBLICA."
else
    echo "$DOMAIN → $IP_DOMINIO"
fi

# ---------------------------------------------------------------------------
# Paquetes y hora del servidor (regla 2: hora de Madrid)
# ---------------------------------------------------------------------------
say "Paquetes"
# Máquinas pequeñas (p. ej. Azure B1s, 1 GB): 1 GB de swap para que apt y PostgreSQL no se queden sin memoria.
if [[ $(awk '/MemTotal/ { print $2 }' /proc/meminfo) -lt 1600000 && -z "$(swapon --show --noheadings)" && ! -f /swapfile ]]; then
    fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "Swap de 1 GB activada."
fi
timedatectl set-timezone Europe/Madrid
timedatectl set-ntp true || true
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
# postgresql-contrib trae las extensiones btree_gist y unaccent que usa el esquema.
apt-get install -y -q \
    apache2 postgresql postgresql-contrib certbot ufw curl rsync cron openssl ca-certificates gnupg

# Node.js LTS del repositorio de NodeSource (el de Ubuntu 24.04 es demasiado antiguo).
if ! command -v node >/dev/null || (( $(node -p 'process.versions.node.split(".")[0]') < 20 )); then
    install -d -m 755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
    apt-get update -q
    apt-get install -y -q nodejs
fi
NODE_BIN=$(command -v node)
PG_VER=$(find /usr/lib/postgresql -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -V | tail -1)
[[ -n "$PG_VER" ]] || { warn "No se ha instalado PostgreSQL."; exit 1; }
echo "Node.js $(node --version) · PostgreSQL ${PG_VER}"

# Usuario del sistema que ejecuta la API: sin contraseña ni intérprete de órdenes.
if ! id "$APP_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
fi

# ---------------------------------------------------------------------------
# PostgreSQL: solo escucha en local (RS-10). Dos roles: mesalista_owner es el
# dueño del esquema y mesalista, el de la API, solo lee y escribe datos.
# ---------------------------------------------------------------------------
say "PostgreSQL"
# Ubuntu crea el clúster «main» al instalar el paquete; si no existe, se crea aquí.
if ! pg_lsclusters --no-header 2>/dev/null | awk -v v="$PG_VER" '$1 == v && $2 == "main" { ok = 1 } END { exit !ok }'; then
    pg_createcluster "$PG_VER" main --locale=C.UTF-8 --encoding=UTF8 >/dev/null
    echo "Clúster ${PG_VER}/main creado."
fi
PG_CONF_DIR=/etc/postgresql/${PG_VER}/main/conf.d
mkdir -p "$PG_CONF_DIR"
cat > "$PG_CONF_DIR/60-mesalista.conf" <<'EOF'
# MesaLista
listen_addresses = 'localhost'
timezone = 'Europe/Madrid'
log_timezone = 'Europe/Madrid'
EOF
systemctl enable "postgresql@${PG_VER}-main" >/dev/null 2>&1 || true
systemctl restart "postgresql@${PG_VER}-main"
# Tras reiniciar tarda unos segundos en aceptar conexiones.
for _ in $(seq 1 30); do
    pg_isready -q && break
    sleep 1
done
pg_isready -q || { warn "PostgreSQL no arranca: journalctl -u postgresql@${PG_VER}-main"; exit 1; }

DB_PASS=""
[[ -f "$CONFIG" ]] && DB_PASS=$(config_value "$CONFIG" db.pass)
[[ -n "$DB_PASS" ]] || DB_PASS=$(openssl rand -hex 24)
[[ "$DB_PASS" =~ ^[A-Za-z0-9._-]+$ ]] || { warn "La contraseña de la base de datos de config.json tiene caracteres no admitidos."; exit 1; }

if [[ $RESET_DB -eq 1 ]]; then
    read -rp "Se BORRARÁN todas las reservas y cuentas. Escribe BORRAR para seguir: " sure
    [[ "$sure" == "BORRAR" ]] || { warn "Cancelado."; exit 1; }
    systemctl stop mesalista-api cron 2>/dev/null || true
    psql_admin -c "DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)"
fi

# Roles y base de datos. La contraseña va por la entrada estándar (\set), no
# en la línea de órdenes, donde la vería cualquier usuario con «ps».
{ printf '\\set pass %s\n' "'$DB_PASS'"; cat <<'SQL'; } | psql_admin
SELECT 'CREATE ROLE mesalista_owner NOLOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mesalista_owner') \gexec
SELECT 'CREATE ROLE mesalista LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mesalista') \gexec
ALTER ROLE mesalista LOGIN PASSWORD :'pass';
SELECT 'CREATE DATABASE mesalista OWNER mesalista_owner ENCODING ''UTF8'' LOCALE ''C.UTF-8'' TEMPLATE template0'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'mesalista') \gexec
SQL

HAS_TABLES=$(psql_admin -tA -d "$DB_NAME" -c "SELECT to_regclass('public.reservations') IS NOT NULL")
if [[ "$HAS_TABLES" != "t" ]]; then
    psql_owner "$REPO_DIR/bd/esquema.sql" "$REPO_DIR/bd/datos.sql"
    echo "Base de datos creada."
fi
# Restaurante preconfigurado (bd/restaurante.sql: mesas, plano y franjas), solo
# si todavía no hay ninguna mesa ni franja: nunca pisa lo que ya se ha configurado.
EMPTY=$(psql_admin -tA -d "$DB_NAME" -c "SELECT NOT EXISTS (SELECT 1 FROM dining_tables) AND NOT EXISTS (SELECT 1 FROM service_slots)")
if [[ "$EMPTY" == "t" ]]; then
    psql_owner "$REPO_DIR/bd/restaurante.sql"
    echo "Restaurante configurado: $(psql_admin -tA -d "$DB_NAME" -c "SELECT COUNT(*) FROM dining_tables") mesas y $(psql_admin -tA -d "$DB_NAME" -c "SELECT COUNT(*) FROM service_slots") franjas de servicio."
fi
psql_admin -d "$DB_NAME" -f - < "$REPO_DIR/despliegue/permisos.sql"

# ---------------------------------------------------------------------------
# Código de la aplicación
# ---------------------------------------------------------------------------
say "API en $APP_DIR"
mkdir -p "$APP_DIR/config" "$WEB_DIR" "$LIB_DIR"
for dir in src bin data; do
    rsync -a --delete "$REPO_DIR/$dir/" "$APP_DIR/$dir/"
done
install -m 644 "$REPO_DIR/package.json" "$APP_DIR/"
[[ -f "$REPO_DIR/package-lock.json" ]] && install -m 644 "$REPO_DIR/package-lock.json" "$APP_DIR/"
install -m 644 "$REPO_DIR/config/config.example.json" "$APP_DIR/config/"
install -m 700 "$REPO_DIR/despliegue/backup.sh" "$REPO_DIR/despliegue/restore.sh" "$LIB_DIR/"
install -m 644 "$REPO_DIR/despliegue/permisos.sql" "$LIB_DIR/"

# Dependencias (pg y argon2). Con package-lock.json, exactamente esas versiones.
if [[ -f "$APP_DIR/package-lock.json" ]]; then
    (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)
else
    (cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund)
fi
# argon2 trae su binario precompilado para Linux x64, así que no necesita su
# script de instalación (las versiones nuevas de npm no lo ejecutan sin
# aprobarlo: es el aviso «install scripts not yet covered by allowScripts»).
# Se comprueba que carga y, si no, se compila aquí.
argon2_ok() { (cd "$APP_DIR" && node -e "require('argon2').hash('x').then(() => process.exit(0), () => process.exit(1))") >/dev/null 2>&1; }
if argon2_ok; then
    echo "argon2: binario precompilado cargado."
else
    warn "argon2 no carga con el binario precompilado; se compila (tarda un poco)."
    apt-get install -y -q build-essential python3
    (cd "$APP_DIR" && npm rebuild argon2 --foreground-scripts)
    argon2_ok || { warn "argon2 sigue sin cargar: revisa la salida de npm."; exit 1; }
fi

# Crea config.json la primera vez; si ya existe, solo cambia el dominio (si se ha cambiado).
ML_CONFIG="$CONFIG" ML_DB_PASS="$DB_PASS" ML_DOMAIN="$DOMAIN" \
    ML_MAIL_CONNECTION="${MAIL_CONNECTION:-}" ML_MAIL_SENDER="${MAIL_SENDER:-}" \
    node "$APP_DIR/bin/write-config.js"
chown -R root:"$APP_USER" "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 750 {} +
find "$APP_DIR" -type f -exec chmod 640 {} +
mkdir -p /var/log/mesalista
chown "$APP_USER":"$APP_USER" /var/log/mesalista
chmod 750 /var/log/mesalista

# Raíz de la web: la rellena el proyecto de la web. Mientras está vacía, una
# página que lo explica.
if [[ -z "$(ls -A "$WEB_DIR")" ]]; then
    cat > "$WEB_DIR/index.html" <<'EOF'
<!doctype html>
<html lang="es"><meta charset="utf-8"><title>MesaLista</title>
<p>La API de MesaLista funciona en <code>/api/v1/</code>. La web todavía no está instalada.</p>
</html>
EOF
    chown -R root:www-data "$WEB_DIR"
fi
mkdir -p /etc/apache2/mesalista-web.d

# ---------------------------------------------------------------------------
# Servicio de la API (systemd)
# ---------------------------------------------------------------------------
say "Servicio mesalista-api"
sed -e "s#__APP_DIR__#${APP_DIR}#g" -e "s#__NODE__#${NODE_BIN}#g" \
    "$REPO_DIR/despliegue/mesalista-api.service" > /etc/systemd/system/mesalista-api.service

# RD-02: los servicios vuelven a arrancar solos si se caen.
for svc in apache2 "postgresql@${PG_VER}-main"; do
    mkdir -p "/etc/systemd/system/${svc}.service.d"
    printf '[Service]\nRestart=always\nRestartSec=2\n' > "/etc/systemd/system/${svc}.service.d/mesalista-restart.conf"
done
systemctl daemon-reload
systemctl enable apache2 postgresql cron mesalista-api >/dev/null
systemctl restart mesalista-api cron

# ---------------------------------------------------------------------------
# Apache (RS-01). Mientras no hay certificado de Let's Encrypt arranca con uno
# autofirmado, para poder servir el desafío HTTP por el puerto 80.
# ---------------------------------------------------------------------------
say "Apache"
LE_CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
LE_KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
# Uno por dominio: si el dominio cambia, se crea otro con el nombre nuevo.
SELF_CERT="$ETC_DIR/selfsigned-$DOMAIN.crt"
SELF_KEY="$ETC_DIR/selfsigned-$DOMAIN.key"
ACME_DIR=/var/www/letsencrypt
CERT_OK=0
[[ -f "$LE_CERT" ]] && CERT_OK=1   # ya existe; certbot lo renueva solo

render_site() {  # render_site CERT KEY
    sed -e "s#__DOMAIN__#${DOMAIN}#g" -e "s#__WEB_DIR__#${WEB_DIR}#g" -e "s#__API_PORT__#${API_PORT}#g" \
        -e "s#__ACME_DIR__#${ACME_DIR}#g" -e "s#__CERT__#$1#g" -e "s#__KEY__#$2#g" \
        "$REPO_DIR/despliegue/apache-mesalista.conf" > /etc/apache2/sites-available/mesalista.conf
}
if [[ $CERT_OK -eq 0 && ! -f "$SELF_CERT" ]]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=$DOMAIN" \
        -addext "subjectAltName=DNS:$DOMAIN" -keyout "$SELF_KEY" -out "$SELF_CERT" 2>/dev/null
    chmod 600 "$SELF_KEY"
fi
mkdir -p "$ACME_DIR/.well-known/acme-challenge"

a2enmod -q ssl headers proxy proxy_http http2 deflate >/dev/null
if [[ $CERT_OK -eq 1 ]]; then render_site "$LE_CERT" "$LE_KEY"; else render_site "$SELF_CERT" "$SELF_KEY"; fi
a2dissite -q 000-default default-ssl 2>/dev/null || true
a2ensite -q mesalista >/dev/null
apache2ctl configtest
systemctl restart apache2

# ---------------------------------------------------------------------------
# Cortafuegos: 80 y 443 desde fuera (RS-10) y SSH para administrar la máquina.
# El grupo de seguridad de red de Azure limita el 22 a la IP del administrador.
# El puerto de Node.js (8091) no se abre: solo escucha en 127.0.0.1.
# ---------------------------------------------------------------------------
say "Cortafuegos"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 22/tcp >/dev/null
# Solo se avisa si SSH acepta contraseñas: con claves no hay fuerza bruta posible.
# (En Ubuntu 24.04 sshd se activa por socket: «sshd -T» necesita /run/sshd.)
mkdir -p /run/sshd
SSH_PASSWORDS=$(sshd -T 2>/dev/null | awk '$1 == "passwordauthentication" || $1 == "kbdinteractiveauthentication" { print $2 }' | sort -u | tr '\n' ' ')
if [[ "$SSH_PASSWORDS" == "no " ]]; then
    echo "SSH abierto solo con clave (sin contraseñas)."
elif [[ -n "$SSH_PASSWORDS" ]]; then
    warn "SSH acepta contraseñas: usa claves SSH (PasswordAuthentication no)."
fi
ufw --force enable >/dev/null
ufw status verbose

# ---------------------------------------------------------------------------
# Certificado HTTPS de Let's Encrypt (desafío HTTP por el puerto 80)
# ---------------------------------------------------------------------------
if [[ $CERT_OK -eq 0 ]]; then
    say "Certificado para $DOMAIN"
    if certbot certonly --webroot -w "$ACME_DIR" -d "$DOMAIN" -m "$LE_EMAIL" \
            --agree-tos --non-interactive --keep-until-expiring; then
        CERT_OK=1
        render_site "$LE_CERT" "$LE_KEY"
        apache2ctl configtest
        systemctl reload apache2
    fi
fi
if [[ $CERT_OK -eq 1 ]]; then
    mkdir -p /etc/letsencrypt/renewal-hooks/deploy
    printf '#!/bin/sh\nsystemctl reload apache2\n' > /etc/letsencrypt/renewal-hooks/deploy/mesalista-reload.sh
    chmod 755 /etc/letsencrypt/renewal-hooks/deploy/mesalista-reload.sh
else
    warn "No se ha podido obtener el certificado de Let's Encrypt para $DOMAIN."
    warn "Se usa uno autofirmado temporal (el navegador mostrará un aviso y NO cumple RS-01)."
    warn "Comprueba que $DOMAIN apunta a la IP pública y que el puerto 80 está abierto"
    warn "(en Azure: Redes > reglas de entrada), y vuelve a ejecutar install.sh."
fi

# ---------------------------------------------------------------------------
# Tareas programadas. PostgreSQL no tiene eventos: los procesos automáticos de
# la base de datos los lanza worker.js.
# ---------------------------------------------------------------------------
say "Tareas programadas"
cat > /etc/cron.d/mesalista <<EOF
# MesaLista
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
TZ=Europe/Madrid
# No presentadas, señales vencidas, devoluciones, correos y avisos push
* * * * *     ${APP_USER}  ${NODE_BIN} ${APP_DIR}/bin/worker.js >> /var/log/mesalista/worker.log 2>&1
# Borrado de datos personales caducados (RP-03, RP-08)
0 4 * * *     ${APP_USER}  ${NODE_BIN} ${APP_DIR}/bin/worker.js --diario >> /var/log/mesalista/worker.log 2>&1
# RD-03: copia diaria de la base de datos
30 3 * * *    root         ${LIB_DIR}/backup.sh >> /var/log/mesalista/backup.log 2>&1
EOF
chmod 644 /etc/cron.d/mesalista
cat > /etc/logrotate.d/mesalista <<EOF
/var/log/mesalista/*.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    su ${APP_USER} ${APP_USER}
}
EOF

# ---------------------------------------------------------------------------
# Cuenta de administrador
# ---------------------------------------------------------------------------
ADMINS=$(psql_admin -tA -d "$DB_NAME" -c "SELECT COUNT(*) FROM users WHERE role = 'admin'")
if [[ "$ADMINS" == "0" ]]; then
    say "Cuenta de administrador ($ADMIN_EMAIL)"
    sudo -u "$APP_USER" "$NODE_BIN" "$APP_DIR/bin/create-user.js" admin "$ADMIN_EMAIL" "Administrador"
fi

# PIN de «Cerrar local» (se pide solo la primera vez).
HAS_PIN=$(psql_admin -tA -d "$DB_NAME" -c "SELECT EXISTS (SELECT 1 FROM secrets WHERE name = 'close_pin')")
if [[ "$HAS_PIN" != "t" ]]; then
    say "PIN de «Cerrar local»"
    sudo -u "$APP_USER" "$NODE_BIN" "$APP_DIR/bin/set-close-pin.js"
fi

# ---------------------------------------------------------------------------
# Comprobación final: la API responde por HTTPS desde la propia máquina.
# ---------------------------------------------------------------------------
say "Comprobación"
for _ in $(seq 1 10); do
    curl -s -o /dev/null "http://127.0.0.1:${API_PORT}/" && break
    sleep 1
done
CURL_OPTS=(-s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$DOMAIN:443:127.0.0.1")
[[ $CERT_OK -eq 1 ]] || CURL_OPTS+=(-k)   # solo esta prueba local, con el certificado temporal
CODIGO=$(curl "${CURL_OPTS[@]}" "https://$DOMAIN/api/v1/config" || true)
if [[ "$CODIGO" == "200" ]]; then
    echo "La API responde en https://$DOMAIN/api/v1/config."
else
    warn "La API no responde como se esperaba (código ${CODIGO:-sin respuesta})."
    warn "Revisa journalctl -u mesalista-api y /var/log/apache2/mesalista-error.log."
fi

say "Listo"
cat <<EOF
  API:               https://${DOMAIN}/api/v1/config
  Servicio:          systemctl status mesalista-api   ·   journalctl -u mesalista-api
  Raíz de la web:    ${WEB_DIR}   (y sus directivas de Apache en /etc/apache2/mesalista-web.d/)
  Configuración:     ${CONFIG}
  Copias:            /var/backups/mesalista (diarias a las 03:30)

  Correo con Azure Communication Services (si no lo configuraste al instalar):
    sudo node ${APP_DIR}/bin/configure-mail.js
  Avisos push con Firebase (cuenta de servicio del proyecto):
    sudo node ${APP_DIR}/bin/configure-fcm.js <cuenta-de-servicio.json>
  Señal de los grupos con PayPal sandbox (opcional):
    sudo node ${APP_DIR}/bin/configure-paypal.js
  Después de cambiar las claves: sudo systemctl restart mesalista-api

  El restaurante ya está configurado (bd/restaurante.sql): se puede reservar.
  Las mesas, el plano, los horarios y las cuentas del personal se cambian en
  el panel, en Administración (entrando como ${ADMIN_EMAIL}).
EOF
