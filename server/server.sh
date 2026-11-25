#!/usr/bin/env bash
# TerminPilot – Fernwartung vom Mac. Lädt den App-Code auf den Hetzner-Server und steuert den Dienst.
# Server-IP wird in ~/.terminpilot_server gemerkt, damit du sie nicht jedes Mal tippen musst.
#
#   ./server.sh update [ip]   Code hochladen (rsync) + Dienst neu starten  ← der Haupt-Upload
#   ./server.sh status [ip]   läuft der Dienst?
#   ./server.sh log [ip]      letzte Logzeilen
#   ./server.sh ssh [ip]      auf den Server verbinden
#   ./server.sh backup [ip]   neueste Sicherung auf den Mac holen
#   ./server.sh cloud-init    Cloud-Config erzeugen (in Zwischenablage)
set -euo pipefail
HIER="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HIER/.." && pwd)"
MERK=~/.terminpilot_server
CMD="${1:-}"; ARG="${2:-}"

ip() {
  if [ -n "$ARG" ]; then echo "$ARG" > "$MERK"; echo "$ARG"; return; fi
  if [ -f "$MERK" ]; then cat "$MERK"; return; fi
  echo "Keine Server-IP. Aufruf z. B.: ./server.sh update 203.0.113.10" >&2; exit 1
}

case "$CMD" in
  cloud-init)
    python3 "$HIER/baue-cloud-init.py" | pbcopy && echo "Cloud-Config liegt in der Zwischenablage. In Hetzner beim Serveranlegen unter „Cloud config" einfügen." ;;
  update)
    IP="$(ip)"
    echo "Lade Code nach root@$IP:/opt/terminpilot …"
    rsync -az --delete \
      --exclude='.DS_Store' --exclude='server.sh' --exclude='baue-cloud-init.py' --exclude='wrangler.toml' \
      "$HIER"/ "root@$IP:/opt/terminpilot/server/"
    rsync -az --delete --exclude='.DS_Store' "$ROOT/web/" "root@$IP:/opt/terminpilot/web/"
    ssh "root@$IP" 'chown -R root:root /opt/terminpilot && systemctl restart terminpilot && sleep 1 && systemctl --no-pager --lines=0 status terminpilot | head -3'
    echo "Fertig. Test:  curl -s https://\$(cat $MERK)/api/health  (bzw. deine Domain)" ;;
  status) ssh "root@$(ip)" 'systemctl --no-pager status terminpilot | head -12' ;;
  log)    ssh "root@$(ip)" 'journalctl -u terminpilot --no-pager -n 40' ;;
  ssh)    ssh "root@$(ip)" ;;
  backup)
    IP="$(ip)"; mkdir -p "$ROOT/backups"
    ssh "root@$IP" 'ls -t /var/backups/terminpilot/*.db | head -1' | tr -d '\r' | while read -r f; do
      scp "root@$IP:$f" "$ROOT/backups/"; echo "Geladen: backups/$(basename "$f")"; done ;;
  *) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
