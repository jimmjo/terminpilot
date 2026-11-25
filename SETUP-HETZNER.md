# TerminPilot auf Hetzner (eigener Server, EU)

Ein **neuer, eigener** Server (NICHT der Praxis-Server). Caddy macht HTTPS und reicht alles an Node weiter; Node serviert Website + API, Daten liegen verschlüsselt in SQLite auf dem Server.

```
Browser ──HTTPS──▶ Caddy ──▶ Node (server.mjs → server.js) ──▶ SQLite (/var/lib/terminpilot)
                                        └─ serviert auch die web/-Seiten
```

## 0. Vorbereiten (Mac, Terminal)

```
# SSH-Schlüssel (falls noch keiner):
ssh-keygen -t ed25519 -C "terminpilot"
pbcopy < ~/.ssh/id_ed25519.pub        # öffentlicher Schlüssel in der Zwischenablage

# Geheimwerte anlegen:
MASTER=$(openssl rand -base64 32)
cat > ~/.terminpilot_secrets <<EOF
MASTER_KEY=$MASTER
OPERATOR_SETUP_CODE=$(openssl rand -hex 12)
DOMAIN=DEINE-DOMAIN.de
EOF
chmod 600 ~/.terminpilot_secrets
```
`MASTER_KEY` zusätzlich im Passwort-Manager sichern – **nie ändern/verlieren**, sonst sind Kundendaten unlesbar.
(Optional später in die Datei ergänzen: `BREVO_API_KEY=…`, `STRIPE_SECRET=…` usw. – siehe Kopf von `server/baue-cloud-init.py`.)

## 1. Cloud-Config erzeugen

```
cd ~/Downloads/terminpilot/server
./server.sh cloud-init        # legt die fertige Cloud-Config in die Zwischenablage
```

## 2. Server anlegen (Hetzner Console → Add Server)

| Feld | Auswahl |
|---|---|
| Standort | **Falkenstein oder Nürnberg** (Deutschland) |
| Image | **Ubuntu 24.04** |
| Typ | kleinster Shared-vCPU reicht zum Start |
| SSH-Key | deinen öffentlichen Schlüssel einfügen |
| Backups | aktivieren (empfohlen) |
| Cloud config | Inhalt aus der Zwischenablage einfügen |
| Name | `terminpilot` |

→ **Erstellen**. Danach die **IPv4** des Servers kopieren.

## 3. DNS setzen

Beim DNS-Anbieter deiner Domain einen **A-Record** auf die Server-IP setzen (bei Cloudflare-DNS: **graue Wolke / DNS only**, damit Caddy das HTTPS-Zertifikat holen kann). Für Betriebs-Buchungsseiten reicht die Hauptdomain – Kunden buchen unter `https://DEINE-DOMAIN.de/buchen.html?b=<betrieb>`.

## 4. Code hochladen (Mac) — das ist der eigentliche „Deploy"

Nach ~2 Minuten (Cloud-Init fertig):
```
./server.sh update DEINE-SERVER-IP
```
Lädt `server/` und `web/` hoch und startet den Dienst. Danach merkt sich `server.sh` die IP.

## 5. Testen

- `https://DEINE-DOMAIN.de/` → Landingpage
- `https://DEINE-DOMAIN.de/api/health` → `{"ok":true,...}`
- `https://DEINE-DOMAIN.de/betreiber/` → mit `OPERATOR_SETUP_CODE` deinen Betreiber-Zugang anlegen
- `https://DEINE-DOMAIN.de/registrieren.html` → ersten Testbetrieb anlegen

## Laufender Betrieb (Mac)

```
./server.sh update     # neue Version hochladen (nach Code-Änderungen)
./server.sh status     # läuft der Dienst?
./server.sh log        # Logzeilen
./server.sh backup     # neueste DB-Sicherung auf den Mac holen
./server.sh ssh        # auf den Server
```

Automatisch auf dem Server: alle 5 Min Erinnerungen prüfen, nachts aufräumen + DB-Sicherung (14 Tage), Sicherheitsupdates, Neustart 04:30 bei Bedarf, Firewall nur 22/80/443, Dienst startet nach Absturz/Neustart von selbst.

## Später frei schaltbar (Geheimwerte ergänzen + `./server.sh cloud-init` neu … bzw. direkt in `/etc/terminpilot.env` auf dem Server)
- **E-Mail**: `BREVO_API_KEY`
- **WhatsApp/SMS**: `WA_API_URL`, `WA_API_KEY`
- **Abrechnung**: `STRIPE_SECRET`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_BASIS|PLUS|PRO`
  (Stripe-Webhook → `https://DEINE-DOMAIN.de/api/stripe/webhook`)
