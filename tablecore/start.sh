#!/usr/bin/env bash
# One-command start for Linux/macOS: `./start.sh` starts the game server
# AND the launcher together, with a fresh random secret generated
# automatically -- nothing to type, no env vars to set by hand.
#
# Always operates on the folder THIS FILE lives in, regardless of the
# directory it was invoked from (resolves symlinks too, so it still
# works if this script itself is symlinked from somewhere else).
set -euo pipefail
SCRIPT_PATH="${BASH_SOURCE[0]}"
while [ -h "$SCRIPT_PATH" ]; do
  DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" >/dev/null 2>&1 && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ $SCRIPT_PATH != /* ]] && SCRIPT_PATH="$DIR/$SCRIPT_PATH"
done
cd "$(cd -P "$(dirname "$SCRIPT_PATH")" >/dev/null 2>&1 && pwd)"

if [ ! -d node_modules ]; then
  echo "First run: installing dependencies, this can take a minute..."
  npm install
fi

# A fresh secret every run is fine and deliberate: nothing about a
# running match survives a server restart anyway (matches live only in
# memory -- see ADMIN.md), so there is no reason to persist one across
# runs, and generating it here means whoever runs this script never has
# to see or handle it directly.
export TABLECORE_SERVER_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
export TABLECORE_SERVER_CONFIG="${TABLECORE_SERVER_CONFIG:-tools/server/example.config.mjs}"

# Bind to all interfaces, not just loopback -- 127.0.0.1 is ONLY reachable
# from this exact machine. Real people testing this on their own laptops/
# phones over the same Wi-Fi/LAN need the server and launcher reachable
# from THEIR machine, which means binding to 0.0.0.0 here. The admin API
# is deliberately kept on loopback-only (see ADMIN.md's own security
# section: it can create matches and mint valid tokens, and isn't
# something every tester's machine needs to reach -- only whoever is
# running this script, from this same machine, needs it).
export TABLECORE_SERVER_HOST="${TABLECORE_SERVER_HOST:-0.0.0.0}"
export TABLECORE_LAUNCHER_HOST="${TABLECORE_LAUNCHER_HOST:-0.0.0.0}"
export TABLECORE_SERVER_ADMIN_HOST="${TABLECORE_SERVER_ADMIN_HOST:-127.0.0.1}"

echo "Starting the game server..."
node tools/server/start.mjs &
SERVER_PID=$!

echo "Starting the launcher..."
node tools/launcher/server.mjs &
LAUNCHER_PID=$!

CLEANED_UP=0
cleanup() {
  if [ "$CLEANED_UP" -eq 1 ]; then return; fi
  CLEANED_UP=1
  echo ""
  echo "Stopping server and launcher..."
  kill "$SERVER_PID" "$LAUNCHER_PID" 2>/dev/null || true
  wait "$SERVER_PID" "$LAUNCHER_PID" 2>/dev/null || true
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

sleep 1.5

LAUNCHER_PORT="${TABLECORE_LAUNCHER_PORT:-4170}"
LOCAL_LAUNCHER_URL="http://127.0.0.1:${LAUNCHER_PORT}"
LAN_IP="$(node tools/lan-ip.mjs 2>/dev/null || true)"

echo ""
echo "================================================================"
echo " Server and launcher are running."
echo " On this machine:        $LOCAL_LAUNCHER_URL"
if [ -n "$LAN_IP" ]; then
  echo " For other people on this network:  http://${LAN_IP}:${LAUNCHER_PORT}"
else
  echo " Could not detect a LAN IP for sharing with other machines --"
  echo " if others can't connect, check your network connection/firewall."
fi
echo " Admin API (this machine only, by design):  http://127.0.0.1:${TABLECORE_SERVER_ADMIN_PORT:-4181}"
echo ""
echo " Press Ctrl+C to stop both."
echo "================================================================"
echo ""

if command -v open >/dev/null 2>&1; then
  open "$LOCAL_LAUNCHER_URL" 2>/dev/null || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$LOCAL_LAUNCHER_URL" 2>/dev/null || true
fi

wait "$SERVER_PID" "$LAUNCHER_PID"
