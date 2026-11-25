#!/usr/bin/env bash
# Hinterlegt den SSH-Key dieses Macs auf dem Server, damit der Deploy direkt (ohne Konsole-Tippen) läuft.
# Enthält nur einen ÖFFENTLICHEN Schlüssel (kein Geheimnis). Wieder entfernbar: Zeile aus /root/.ssh/authorized_keys löschen.
set -e
mkdir -p /root/.ssh
KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDvMwCKPSlsFShsa3RqQAZtNwpJ/6tQYuDGXO70Du9pW praxis-termine'
grep -q 'DvMwCKPSlsFShsa3RqQAZtNwpJ' /root/.ssh/authorized_keys 2>/dev/null || echo "$KEY" >> /root/.ssh/authorized_keys
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys
echo "SSH-Key hinterlegt – Claude kann jetzt direkt deployen."
