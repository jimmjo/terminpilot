#!/usr/bin/env bash
# TerminPilot – Installation/Update, vom Server selbst ausgeführt (als root in der Hetzner-Web-Konsole).
# Läuft neben einem evtl. vorhandenen Dienst (eigener Port 8788, eigener systemd-Dienst, eigener Caddy-Block).
# Der MASTER_KEY wird hier auf dem Server erzeugt und verlässt ihn nie.
# Erwartet den nur-lesenden Deploy-Key unter /root/.ssh/tp_deploy (der Ein-Zeilen-Befehl legt ihn an).
# DOMAIN=… setzt HTTPS; ohne DOMAIN läuft es über http://<server-ip> zum Testen.
set -euo pipefail

REPO_SSH="git@github.com:jimmjo/terminpilot.git"
REPO_HTTPS="https://github.com/jimmjo/terminpilot.git"
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

say "Code holen"
KEY=/root/.ssh/tp_deploy
if [ -f "$KEY" ]; then
  # privates Repo via read-only Deploy-Key
  REPO="$REPO_SSH"
  GITSSH="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
else
  # öffentliches Repo via HTTPS (kein Schlüssel nötig)
  REPO="$REPO_HTTPS"
  GITSSH=""
fi
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" remote set-url origin "$REPO"
  [ -n "$GITSSH" ] && git -C "$DIR" config core.sshCommand "$GITSSH" || git -C "$DIR" config --unset core.sshCommand 2>/dev/null || true
  GIT_SSH_COMMAND="$GITSSH" git -C "$DIR" fetch --depth 1 origin main
  git -C "$DIR" reset --hard origin/main
else
  rm -rf "$DIR"
  GIT_SSH_COMMAND="$GITSSH" git clone --depth 1 "$REPO" "$DIR"
  [ -n "$GITSSH" ] && git -C "$DIR" config core.sshCommand "$GITSSH"
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

say "Caddy (HTTPS)"
CADDY=/etc/caddy/Caddyfile
# alte Konfig einmalig sichern, dann durch eine saubere, konfliktfreie ersetzen
[ -f "$CADDY" ] && [ ! -f "$CADDY.vor-terminpilot" ] && cp "$CADDY" "$CADDY.vor-terminpilot" || true
if [ -n "$DOMAIN" ]; then
  cat > "$CADDY" <<EOF
$DOMAIN {
    encode zstd gzip
    reverse_proxy 127.0.0.1:$PORT
}
EOF
else
  cat > "$CADDY" <<EOF
:80 {
    encode zstd gzip
    reverse_proxy 127.0.0.1:$PORT
}
EOF
fi
systemctl restart caddy 2>/dev/null || systemctl reload caddy 2>/dev/null || echo "Caddy-Neustart fehlgeschlagen – siehe: journalctl -xeu caddy"

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
echo " Betreiber-Zugang anlegen unter  ${DOMAIN:+https://$DOMAIN}${DOMAIN:-http://$IP}/betreiber/  mit:"
echo "   OPERATOR_SETUP_CODE = $(grep '^OPERATOR_SETUP_CODE=' "$ENVF" | cut -d= -f2)"
echo " MASTER_KEY (einmal sichern, nie verlieren):"
echo "   $(grep '^MASTER_KEY=' "$ENVF" | cut -d= -f2-)"
echo " Update künftig:  terminpilot-update"
echo "────────────────────────────────────────────────────────"
