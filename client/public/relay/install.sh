#!/usr/bin/env bash
# Edgeline relay — installed as a service that starts at boot and restarts itself.
#
# On a Linux machine (Ubuntu/Debian, as root or with sudo):
#
#   curl -fsSL https://<your-journal>/relay/install.sh | sudo \
#     EDGELINE_URL=https://<your-journal> EDGELINE_RELAY_TOKEN=<from Settings> \
#     BINANCE_KEY=<api key> BINANCE_SECRET=<secret> bash
#
# Optional: BINANCE_ENV=testnet. Afterwards: `journalctl -u edgeline-relay -f` to watch it,
# `systemctl restart edgeline-relay` after changing /etc/edgeline-relay.env.
set -euo pipefail
: "${EDGELINE_URL:?set EDGELINE_URL}" "${EDGELINE_RELAY_TOKEN:?set EDGELINE_RELAY_TOKEN}"
: "${BINANCE_KEY:?set BINANCE_KEY}" "${BINANCE_SECRET:?set BINANCE_SECRET}"
EDGELINE_URL="${EDGELINE_URL%/}"

if [ "$(id -u)" -ne 0 ]; then echo "Run as root (sudo)." >&2; exit 1; fi

# Node 22 or newer, from NodeSource when the machine has none or an older one.
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  [ "$major" -ge 22 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  echo "Installing Node 22…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

install -d -m 755 /opt/edgeline-relay
curl -fsSL "$EDGELINE_URL/relay/edgeline-relay.mjs" -o /opt/edgeline-relay/edgeline-relay.mjs
chmod 644 /opt/edgeline-relay/edgeline-relay.mjs

# The key lives here, readable by root only.
umask 077
cat > /etc/edgeline-relay.env <<ENV
EDGELINE_URL=$EDGELINE_URL
EDGELINE_RELAY_TOKEN=$EDGELINE_RELAY_TOKEN
BINANCE_KEY=$BINANCE_KEY
BINANCE_SECRET=$BINANCE_SECRET
BINANCE_ENV=${BINANCE_ENV:-live}
ENV
umask 022

cat > /etc/systemd/system/edgeline-relay.service <<'UNIT'
[Unit]
Description=Edgeline relay (asks Binance for the journal from this machine)
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/edgeline-relay.env
ExecStart=/usr/bin/env node /opt/edgeline-relay/edgeline-relay.mjs
Restart=always
RestartSec=5
# Nothing here needs root once the env file is read.
DynamicUser=yes
ProtectSystem=strict
PrivateTmp=yes
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
UNIT

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable --now edgeline-relay
  sleep 2
  systemctl --no-pager --lines=5 status edgeline-relay || true
  echo
  echo "Installed. Watch it with: journalctl -u edgeline-relay -f"
else
  echo "No systemd here. Start it by hand:"
  echo "  set -a; . /etc/edgeline-relay.env; set +a; node /opt/edgeline-relay/edgeline-relay.mjs"
fi
