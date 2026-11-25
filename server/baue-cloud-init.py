#!/usr/bin/env python3
"""Erzeugt die Cloud-Config für einen NEUEN Hetzner-Server (Ubuntu 24.04).
Richtet alles ein (Node, Caddy/HTTPS, Firewall, Dienst, Secrets) – der App-Code kommt
danach per `./server.sh update <ip>` (rsync). So lädst du den Code selbst hoch.

Liest Geheimwerte aus ~/.terminpilot_secrets (Zeilen KEY=WERT):
  MASTER_KEY=...            (Pflicht, `openssl rand -base64 32`, NIE ändern/verlieren)
  OPERATOR_SETUP_CODE=...   (Pflicht, selbst gewählt)
  DOMAIN=terminpilot.app    (Pflicht, deine Domain)
  BREVO_API_KEY=...         (optional)
  WA_API_URL=...            (optional)   WA_API_KEY=... (optional)
  STRIPE_SECRET=...         (optional)   STRIPE_WEBHOOK_SECRET=... STRIPE_PRICE_BASIS=... STRIPE_PRICE_PLUS=... STRIPE_PRICE_PRO=...
  MAIL_FROM=termine@...     (optional)

Aufruf:  python3 baue-cloud-init.py | pbcopy      (dann in Hetzner „Cloud config" einfügen)
"""
import base64, gzip, os, sys

HIER = os.path.dirname(os.path.abspath(__file__))
g = {}
pfad = os.path.expanduser("~/.terminpilot_secrets")
if not os.path.exists(pfad):
    sys.exit(f"Fehlt: {pfad}\nLege die Datei an (siehe Kopf dieses Skripts).")
with open(pfad) as f:
    for z in f:
        z = z.strip()
        if z and not z.startswith("#") and "=" in z:
            k, v = z.split("=", 1)
            g[k.strip()] = v.strip()

for pflicht in ("MASTER_KEY", "OPERATOR_SETUP_CODE", "DOMAIN"):
    if not g.get(pflicht):
        sys.exit(f"In ~/.terminpilot_secrets fehlt: {pflicht}")

domain = g["DOMAIN"]
env_zeilen = [
    f"MASTER_KEY={g['MASTER_KEY']}",
    f"OPERATOR_SETUP_CODE={g['OPERATOR_SETUP_CODE']}",
    "SIGNUP_ENABLED=1",
    f"APP_ORIGINS=https://{domain}",
    f"MAIL_FROM={g.get('MAIL_FROM', f'termine@{domain}')}",
]
for opt in ("BREVO_API_KEY", "WA_API_URL", "WA_API_KEY", "STRIPE_SECRET", "STRIPE_WEBHOOK_SECRET",
            "STRIPE_PRICE_BASIS", "STRIPE_PRICE_PLUS", "STRIPE_PRICE_PRO"):
    if g.get(opt):
        env_zeilen.append(f"{opt}={g[opt]}")
env = "\n".join(env_zeilen) + "\n"

caddyfile = (f"{domain} {{\n    encode zstd gzip\n    reverse_proxy 127.0.0.1:8787\n"
             "    log {\n        output discard\n    }\n}\n")

def gz(b):  # gz+b64 für cloud-init write_files
    return base64.b64encode(gzip.compress(b, 9)).decode()

def datei(ziel, inhalt_bytes, rechte="0644"):
    return f"  - path: {ziel}\n    encoding: gz+b64\n    permissions: '{rechte}'\n    content: {gz(inhalt_bytes)}\n"

with open(os.path.join(HIER, "server-dateien", "terminpilot.service"), "rb") as f:
    service = f.read()
with open(os.path.join(HIER, "server-dateien", "52terminpilot-updates"), "rb") as f:
    updates = f.read()

write_files = (
    datei("/etc/terminpilot.env", env.encode(), "0600")
    + datei("/etc/caddy/Caddyfile", caddyfile.encode(), "0644")
    + datei("/etc/systemd/system/terminpilot.service", service, "0644")
    + datei("/etc/apt/apt.conf.d/52terminpilot-updates", updates, "0644")
)

yaml = ("""#cloud-config
# TerminPilot – Hetzner (Ubuntu 24.04). Enthält Geheimwerte: NICHT weitergeben.
package_update: true
package_upgrade: true
packages: [caddy, ufw, unattended-upgrades, ca-certificates, curl, gnupg, rsync]
ssh_pwauth: false
timezone: Europe/Berlin
write_files:
""" + write_files + """runcmd:
  - curl -fsSL https://deb.nodesource.com/setup_24.x -o /root/n.sh && bash /root/n.sh && apt-get install -y nodejs && rm -f /root/n.sh
  - useradd --system --home-dir /var/lib/terminpilot --shell /usr/sbin/nologin terminpilot || true
  - mkdir -p /opt/terminpilot/server /opt/terminpilot/web /var/lib/terminpilot /var/backups/terminpilot
  - chown -R terminpilot:terminpilot /var/lib/terminpilot /var/backups/terminpilot
  - chmod 700 /var/lib/terminpilot /var/backups/terminpilot
  - ufw default deny incoming
  - ufw allow OpenSSH
  - ufw allow 80/tcp
  - ufw allow 443/tcp
  - ufw --force enable
  - systemctl daemon-reload
  - systemctl enable terminpilot
  - systemctl restart caddy
  - echo "BEREIT. Jetzt vom Mac:  ./server.sh update <server-ip>" > /root/NAECHSTER_SCHRITT.txt
""")

groesse = len(yaml.encode())
if groesse > 32 * 1024:
    sys.exit(f"Zu groß für Hetzner ({groesse} Bytes, max. 32 KB)")
sys.stdout.write(yaml)
print(f"Cloud-Config erzeugt: {groesse} Bytes. Danach: ./server.sh update <server-ip>", file=sys.stderr)
