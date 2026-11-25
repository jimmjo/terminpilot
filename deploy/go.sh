#!/usr/bin/env bash
# Kurz-Bootstrap: holt TerminPilot aus dem (öffentlichen) Repo und installiert.
# Aufruf auf dem Server als root:  curl -fsSL <kurz-url> | bash
# Optional mit Domain:             curl -fsSL <kurz-url> | DOMAIN=buchung.deine-domain.de bash
set -e
command -v git >/dev/null || { apt-get update -qq; apt-get install -y -qq git; }
rm -rf /opt/terminpilot
git clone --depth 1 https://github.com/jimmjo/terminpilot.git /opt/terminpilot
DOMAIN="${DOMAIN:-}" bash /opt/terminpilot/deploy/install.sh
