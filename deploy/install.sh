#!/usr/bin/env bash
# TerminPilot – Installation/Update, vom Server selbst ausgeführt (als root in der Hetzner-Web-Konsole).
# Läuft neben einem evtl. vorhandenen Dienst (eigener Port 8788, eigener systemd-Dienst, eigener Caddy-Block).
# Der MASTER_KEY wird hier auf dem Server erzeugt und verlässt ihn nie.
# Erwartet den nur-lesenden Deploy-Key unter /root/.ssh/tp_deploy (der Ein-Zeilen-Befehl legt ihn an).
# DOMAIN=… setzt HTTPS; ohne DOMAIN läuft es über http://<server-ip> zum Testen.
set -euo pipefail

REPO="git@github.com:jimmjo/terminpilot.git"
DIR=/opt/terminpilot
PORT=8788
ENVF=/etc/terminpilot.env
DOMAIN="${DOMAIN:-}"
export DEBIAN_FRONTEND=noninteractive

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

say "Pakete prüfen"
command -v git >/dev/null || { apt-get update -q; apt-get install -y git; }
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 22 ] || { echo "Node >= 22 nötig (node:sqlite). Gefunden: $(node -v 2>/dev/null)"; exit 1; }
command -v caddy >/dev/null || { echo "Caddy ist nicht installiert. Bitte zuerst Caddy einrichten."; exit 1; }

say "Code holen (privates Repo via Deploy-Key)"
KEY=/root/.ssh/tp_deploy
GITSSH="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
[ -f "$KEY" ] || { echo "Deploy-Key $KEY fehlt – bitte den vollständigen Installationsbefehl verwenden."; exit 1; }
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" remote set-url origin "$REPO"
  git -C "$DIR" config core.sshCommand "$GITSSH"
  git -C "$DIR" fetch --depth 1 origin main
  git -C "$DIR" reset --hard origin/main
else
  rm -rf "$DIR"
  GIT_SSH_COMMAND="$GITSSH" git clone --depth 1 "$REPO" "$DIR"
  git -C "$DIR" config core.sshCommand "$GITSSH"
fi
chown -R root:root "$DIR"

say "Benutzer & Verzeichnisse"
id terminpilot >/dev/null 2>&1 || useradd --system --home-dir /var/lib/terminpilot --shell /usr/sbin/nologin terminpilot
mkdir -p /var/lib/terminpilot /var/backups/terminpilot
chown -R terminpilot:terminpilot /var/lib/terminpilot /var/backups/terminpilot
chmod 700 /var/lib/terminpilot /var/backups/terminpilot

say "Konfiguration"
IP=$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
ORIGIN=${DOMAIN:+https://$DOMAIN}; ORIGIN=${ORIGIN:-http://$IP}
if [ ! -f "$ENVF" ]; then
  MK=$(openssl rand -base64 32)
  OP=$(openssl rand -hex 12)
  umask 077
  cat > "$ENVF" <<EOF
MASTER_KEY=$MK
OPERATOR_SETUP_CODE=$OP
SIGNUP_ENABLED=1
PORT=$PORT
APP_ORIGINS=$ORIGIN
MAIL_FROM=termine@${DOMAIN:-localhost}
EOF
  chmod 600 "$ENVF"
  NEU=1
else
  # bestehende Secrets behalten, nur Origin/Port aktualisieren
  sed -i "s|^APP_ORIGINS=.*|APP_ORIGINS=$ORIGIN|" "$ENVF" || true
  grep -q '^PORT=' "$ENVF" || echo "PORT=$PORT" >> "$ENVF"
  NEU=0
fi
# Frontend spricht dieselbe Herkunft an (Node liefert Web + API zusammen aus)
echo "window.TP_API='';" > "$DIR/web/config.js"

say "Dienst einrichten"
cat > /etc/systemd/system/terminpilot.service <<UNIT
[Unit]
Description=TerminPilot – Terminbuchung
After=network.target

[Service]
Type=simple
User=terminpilot
EnvironmentFile=$ENVF
Environment=WEB_DIR=$DIR/web
Environment=DATA_DIR=/var/lib/terminpilot
Environment=BACKUP_DIR=/var/backups/terminpilot
WorkingDirectory=$DIR/server
ExecStart=/usr/bin/node $DIR/server/server.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/terminpilot /var/backups/terminpilot

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable terminpilot >/dev/null 2>&1 || true
systemctl restart terminpilot

say "Caddy (HTTPS) – eigener Block, vorhandene bleiben"
CADDY=/etc/caddy/Caddyfile
touch "$CADDY"
# evtl. alten TerminPilot-Block entfernen (idempotent)
sed -i '/# >>> terminpilot >>>/,/# <<< terminpilot <<</d' "$CADDY"
{
  echo "# >>> terminpilot >>>"
  if [ -n "$DOMAIN" ]; then echo "$DOMAIN {"; else echo "http://$IP {"; fi
  echo "    encode zstd gzip"
  echo "    reverse_proxy 127.0.0.1:$PORT"
  echo "    log { output discard }"
  echo "}"
  echo "# <<< terminpilot <<<"
} >> "$CADDY"
caddy validate --config "$CADDY" --adapter caddyfile >/dev/null 2>&1 || echo "Hinweis: Caddy-Konfig bitte prüfen."
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "Update-Befehl installieren"
cat > /usr/local/bin/terminpilot-update <<'UPD'
#!/usr/bin/env bash
set -e
git -C /opt/terminpilot fetch --depth 1 origin main
git -C /opt/terminpilot reset --hard origin/main
echo "window.TP_API='';" > /opt/terminpilot/web/config.js
chown -R root:root /opt/terminpilot
systemctl restart terminpilot
echo "TerminPilot aktualisiert."
UPD
chmod +x /usr/local/bin/terminpilot-update

say "Test"
sleep 2
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  echo "TerminPilot läuft (lokal auf Port $PORT)."
else
  echo "Noch nicht erreichbar – Logs: journalctl -u terminpilot -n 40 --no-pager"
fi

echo
echo "────────────────────────────────────────────────────────"
echo " FERTIG. Aufrufen:  ${DOMAIN:+https://$DOMAIN}${DOMAIN:-http://$IP}"
if [ "${NEU:-0}" = "1" ]; then
  echo " Betreiber-Zugang anlegen unter .../betreiber/ mit diesem Code:"
  echo "   OPERATOR_SETUP_CODE = $(grep '^OPERATOR_SETUP_CODE=' "$ENVF" | cut -d= -f2)"
  echo " MASTER_KEY liegt in $ENVF – bitte EINMAL sichern (nie verlieren):"
  echo "   sudo grep MASTER_KEY $ENVF"
fi
echo " Update künftig:  terminpilot-update"
echo "────────────────────────────────────────────────────────"
