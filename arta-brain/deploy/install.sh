#!/usr/bin/env bash
# Arta brain on the artabot VM (Ubuntu 24.04, user `arta`) — install / sign in / control.
#
#   ./deploy/install.sh install     Node 22 + deps + browser, settings file, systemd unit + watchdog
#   ./deploy/install.sh login       one-time sign-in to the chat subscription, over an SSH-tunnelled VNC
#   ./deploy/install.sh calibrate   find ARTA_SEL_ANSWER (sends ONE harmless prompt)
#   ./deploy/install.sh check       settings (names only), site + token, sign-in state; sends no prompt
#   ./deploy/install.sh start|stop|restart|status|logs|uninstall
#
# Patterned on the old tools/ticket-agent/relay-install.sh: a SYSTEM unit with User=, Restart=always,
# StartLimitIntervalSec in [Unit], and a beat-file watchdog that lives in a script (not in the unit, where
# systemd would mangle % and $). Nothing listens on the network: the brain only makes outbound calls
# (the site, GitHub, the chat page), so no NSG rule is needed for it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="arta-brain"
ENV_DIR="$HOME/.config/arta-brain"
ENV_FILE="$ENV_DIR/env"
STATE_DIR="$HOME/.local/state/arta-brain"
BEAT="$STATE_DIR/beat"
# :99 is taken on artabot by the older artabot-xvfb.service; sign-in uses its own display.
DISPLAY_NUM="${ARTA_LOGIN_DISPLAY:-:98}"

need_node() {
  if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then return; fi
  echo "installing Node 22 (NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
}

build() {
  cd "$HERE"
  npm ci
  npm test
  npx playwright install --with-deps chromium
}

ask_secret() { # name prompt — only when empty in the env file; the value is never echoed
  local name="$1" prompt="$2" cur
  cur="$(grep -E "^$name=" "$ENV_FILE" | cut -d= -f2- || true)"
  [ -n "$cur" ] && return
  local val=""
  # No terminal (a scripted install): leave it empty instead of letting `set -e` abort on EOF.
  if [ -t 0 ]; then read -r -s -p "$prompt: " val || true; echo; fi
  [ -z "$val" ] && { echo "  (left empty — set $name in $ENV_FILE later)"; return; }
  python3 - "$ENV_FILE" "$name" "$val" <<'PY'
import sys
p, k, v = sys.argv[1:4]
lines = open(p).read().splitlines()
lines = [f"{k}={v}" if l.startswith(f"{k}=") else l for l in lines]
open(p, "w").write("\n".join(lines) + "\n")
PY
}

settings() {
  mkdir -p "$ENV_DIR" "$STATE_DIR"
  if [ ! -f "$ENV_FILE" ]; then install -m 600 "$HERE/deploy/env.example" "$ENV_FILE"; fi
  chmod 600 "$ENV_FILE"
  ask_secret ARTA_REPLY_TOKEN "ARTA_REPLY_TOKEN (same as the site's AQ_ARTA_REPLY_TOKEN)"
  ask_secret GITHUB_ISSUES_TOKEN "GITHUB_ISSUES_TOKEN (fine-grained, Issues RW on ArtaQuest/artasite)"
  if ! grep -qE '^ARTA_CHAT_URL=https://' "$ENV_FILE"; then
    local url=""
    if [ -t 0 ]; then read -r -p "ARTA_CHAT_URL (the chat page to answer on): " url || true; fi
    # An `if`, not `&&`: a false test as the last command would fail settings() under `set -e`.
    if [ -n "$url" ]; then sed -i "s|^ARTA_CHAT_URL=.*|ARTA_CHAT_URL=$url|" "$ENV_FILE"; fi
  fi
}

with_env() { set -a; . "$ENV_FILE"; set +a; "$@"; }

unit() {
  local NODE_BIN; NODE_BIN="$(command -v node)"
  sudo tee "/etc/systemd/system/$UNIT.service" >/dev/null <<UNITEOF
[Unit]
Description=Arta brain — answers public @arta mentions on ArtaQuest
Documentation=https://github.com/ArtaQuest/artasite/tree/main/arta-brain
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$HERE
Environment=HOME=$HOME
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $HERE/dist/src/main.js run
Restart=always
RestartSec=10
NoNewPrivileges=true
MemoryMax=1800M

[Install]
WantedBy=multi-user.target
UNITEOF
  sudo tee /usr/local/bin/arta-brain-watchdog >/dev/null <<WDEOF
#!/bin/sh
BEAT="$BEAT"
UNIT="$UNIT"
WDEOF
  sudo tee -a /usr/local/bin/arta-brain-watchdog >/dev/null <<'WDEOF'
# The daemon rewrites the beat after every tick (at most ~60 s apart, longer only while one answer
# runs). Stale for 10 minutes = alive but wedged: restart it.
[ -f "$BEAT" ] || exit 0
age=$(( $(date +%s) - $(cat "$BEAT") ))
[ "$age" -lt 600 ] && exit 0
echo "beat ${age}s stale — restarting $UNIT"
exec systemctl restart "$UNIT"
WDEOF
  sudo chmod +x /usr/local/bin/arta-brain-watchdog
  sudo tee "/etc/systemd/system/$UNIT-watchdog.service" >/dev/null <<EOF2
[Unit]
Description=Restart the Arta brain if it stops ticking

[Service]
Type=oneshot
ExecStart=/usr/local/bin/arta-brain-watchdog
EOF2
  sudo tee "/etc/systemd/system/$UNIT-watchdog.timer" >/dev/null <<EOF2
[Unit]
Description=Check every 2 minutes that the Arta brain is ticking

[Timer]
OnBootSec=5min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
EOF2
  sudo systemctl daemon-reload
}

case "${1:-}" in
  install)
    need_node
    sudo apt-get update -qq   # a VM resumed after weeks deallocated has a stale package index (404s)
    sudo apt-get install -y xvfb x11vnc novnc websockify >/dev/null
    build
    settings
    unit
    echo "✓ installed. Next: ./deploy/install.sh login, then calibrate, then check, then start."
    ;;
  login)
    # A throwaway X display, a VNC server bound to localhost only, and noVNC on localhost:6080.
    # Reach it from your own computer through SSH — nothing is opened to the internet:
    #   ssh -L 6080:localhost:6080 arta@<vm-ip>    then open http://localhost:6080/vnc.html
    sudo systemctl stop "$UNIT" 2>/dev/null || true
    Xvfb "$DISPLAY_NUM" -screen 0 1280x900x24 >/dev/null 2>&1 & XV=$!
    sleep 1
    x11vnc -display "$DISPLAY_NUM" -localhost -forever -shared -nopw -quiet >/dev/null 2>&1 & VNC=$!
    websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >/dev/null 2>&1 & WS=$!
    trap 'kill $WS $VNC $XV 2>/dev/null || true' EXIT
    echo "VNC ready on the VM's localhost:6080 — tunnel it: ssh -L 6080:localhost:6080 $(id -un)@<vm-ip>"
    DISPLAY="$DISPLAY_NUM" with_env node "$HERE/dist/src/main.js" login
    ;;
  calibrate) with_env node "$HERE/dist/src/main.js" calibrate ;;
  check)     with_env node "$HERE/dist/src/main.js" check ;;
  start)     sudo systemctl enable --now "$UNIT" "$UNIT-watchdog.timer"; echo "✓ started — logs: ./deploy/install.sh logs" ;;
  restart)   sudo systemctl restart "$UNIT" ;;
  stop)      sudo systemctl stop "$UNIT" ;;
  status)    systemctl status "$UNIT" --no-pager || true ;;
  logs)      exec journalctl -u "$UNIT" -n 60 -f ;;
  uninstall)
    sudo systemctl disable --now "$UNIT-watchdog.timer" "$UNIT" 2>/dev/null || true
    sudo rm -f "/etc/systemd/system/$UNIT.service" "/etc/systemd/system/$UNIT-watchdog.service" "/etc/systemd/system/$UNIT-watchdog.timer" /usr/local/bin/arta-brain-watchdog
    sudo systemctl daemon-reload
    echo "✓ removed (settings in $ENV_FILE and the browser profile are kept)"
    ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac
