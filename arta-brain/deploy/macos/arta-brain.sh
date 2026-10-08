#!/bin/bash
# Arta brain on the operator's Mac — no VM, no VNC, no git checkout. Everything lives in ~/ArtaBrain:
#
#   ~/ArtaBrain/app/             the built daemon (dist/ + package.json + lock; `npm ci --omit=dev`)
#   ~/ArtaBrain/env              settings, mode 600 (template: app/deploy/env.example + the Mac lines below)
#   ~/ArtaBrain/chrome-profile/  a DEDICATED Google Chrome profile — never the everyday one
#   ~/ArtaBrain/state/           pace counters, heartbeat, probe screenshots
#   ~/ArtaBrain/logs/            launchd stdout/stderr
#
#   arta-brain.sh login          open the dedicated profile on the chat page in plain Chrome; sign in by hand,
#                                then QUIT that Chrome (⌘Q) — the command returns and the sign-in is saved
#   arta-brain.sh check          settings (names only), site + token, sign-in state; sends no prompt
#   arta-brain.sh calibrate      one harmless prompt; prints ARTA_SEL_ANSWER candidates
#   arta-brain.sh install-agent  write ~/Library/LaunchAgents/com.artaquest.arta-brain.plist (NOT loaded; disabled)
#   arta-brain.sh start|stop     enable + load the agent (KeepAlive) | unload + disable it
#   arta-brain.sh restart|status|logs
#   arta-brain.sh run            what launchd runs (foreground daemon)
#
# The daemon drives the INSTALLED Google Chrome (Playwright channel "chrome") on that profile, so nothing
# big is downloaded. Login uses plain Chrome without automation so the sign-in page behaves normally; the
# daemon keeps the real Keychain so that sign-in stays readable (see launchOptions in src/browser.ts).
# Chrome allows one process per profile: stop the agent before `login`, and quit the login window before
# `start`.
set -euo pipefail

ROOT="${ARTA_HOME:-$HOME/ArtaBrain}"
APP="$ROOT/app"
ENV_FILE="$ROOT/env"
PROFILE="$ROOT/chrome-profile"
LABEL="com.artaquest.arta-brain"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DOMAIN="gui/$(id -u)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

load_env() {
  [ -f "$ENV_FILE" ] || { echo "✗ $ENV_FILE is missing"; exit 1; }
  chmod 600 "$ENV_FILE"
  set -a; . "$ENV_FILE"; set +a
  export ARTA_PROFILE_DIR="${ARTA_PROFILE_DIR:-$PROFILE}"
  export ARTA_STATE_DIR="${ARTA_STATE_DIR:-$ROOT/state}"
  export ARTA_BROWSER_CHANNEL="${ARTA_BROWSER_CHANNEL:-chrome}"
  export ARTA_HEADLESS="${ARTA_HEADLESS:-0}"
}

loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

profile_busy() { pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null 2>&1; }

case "${1:-}" in
  login)
    load_env
    if loaded; then echo "✗ the agent is running — run: $0 stop   (Chrome allows one process per profile)"; exit 1; fi
    if profile_busy; then echo "✗ a Chrome is already open on $PROFILE — quit it first"; exit 1; fi
    [ -x "$CHROME" ] || { echo "✗ Google Chrome not found at $CHROME"; exit 1; }
    [ -n "${ARTA_CHAT_URL:-}" ] || { echo "✗ ARTA_CHAT_URL is empty in $ENV_FILE"; exit 1; }
    mkdir -p "$PROFILE"
    echo "Opening the dedicated Arta profile on $ARTA_CHAT_URL."
    echo "Sign in there (2FA as usual), send one short message to confirm it answers, then QUIT that Chrome with ⌘Q."
    echo "This command waits until you do."
    "$CHROME" --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check --new-window "$ARTA_CHAT_URL" >/dev/null 2>&1 || true
    echo "✓ Chrome closed — the sign-in is saved in $PROFILE. Next: $0 check"
    ;;
  run)
    load_env
    mkdir -p "$ARTA_STATE_DIR" "$ROOT/logs"
    exec node "$APP/dist/src/main.js" run
    ;;
  check|calibrate)
    load_env
    if loaded; then echo "✗ the agent is running — run: $0 stop   first"; exit 1; fi
    if profile_busy; then echo "✗ a Chrome is open on $PROFILE (the login window?) — quit it first"; exit 1; fi
    exec node "$APP/dist/src/main.js" "$1"
    ;;
  install-agent)
    mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$APP/deploy/macos/arta-brain.sh</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StandardOutPath</key><string>$ROOT/logs/arta-brain.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/arta-brain.err.log</string>
</dict>
</plist>
PLISTEOF
    plutil -lint "$PLIST"
    # Disabled until `start`: otherwise the next log-in would load it before the profile is signed in.
    launchctl disable "$DOMAIN/$LABEL"
    echo "✓ wrote $PLIST (not loaded, disabled until: $0 start)"
    ;;
  start)
    [ -f "$PLIST" ] || { echo "✗ no $PLIST — run: $0 install-agent"; exit 1; }
    if profile_busy && ! loaded; then echo "✗ a Chrome is open on $PROFILE (the login window?) — quit it first"; exit 1; fi
    launchctl enable "$DOMAIN/$LABEL"
    loaded || launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "✓ started — logs: $0 logs"
    ;;
  stop)      # Stays stopped across log-ins until the next `start`.
             launchctl disable "$DOMAIN/$LABEL"
             launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null && echo "✓ stopped" || echo "(not running)" ;;
  restart)   launchctl kickstart -k "$DOMAIN/$LABEL" ;;
  status)    if loaded; then launchctl print "$DOMAIN/$LABEL" | grep -E "state =|pid =|last exit code" || true; else echo "not loaded"; fi ;;
  logs)      exec tail -n 60 -f "$ROOT/logs/arta-brain.log" "$ROOT/logs/arta-brain.err.log" ;;
  *)         awk 'NR > 1 && /^set -euo/ { exit } NR > 1' "$0"; exit 2 ;;
esac
