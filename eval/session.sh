#!/usr/bin/env bash
# eval/session.sh — run self-improvement cycles with the bot's YOON presence
# managed automatically. Marks an eval session active (bot joins YOON), runs
# cycles back-to-back, and on exit clears the flag (bot quits — unless the owner
# is online, in which case the watcher keeps it up). This replaces driving the
# loop with `/loop eval/loop.sh`: presence is scoped to the whole session, so
# the bot logs in once instead of thrashing a re-login every cycle.
#
# Usage:
#   bash eval/session.sh        # run cycles until you Ctrl-C
#   bash eval/session.sh 3      # run 3 cycles, then stop
# Env knobs pass straight through to loop.sh (MODE, WATCH_TIMEOUT, *_BUDGET).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
STATE_DIR="$ROOT/.runtime"; mkdir -p "$STATE_DIR"
RECONCILE="/usr/local/bin/daedelus404-reconcile.sh"
MCP_PORT=8765
MAX_CYCLES="${1:-0}"   # 0 = run until interrupted

say(){ printf '\n\033[1;35m◆ %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Mark the eval session active and bring the bot up. The flag stores our PID so
# a session killed without running its cleanup trap (kill -9 / reboot) doesn't
# pin the bot up — the reconciler drops a flag whose PID is dead.
echo $$ > "$STATE_DIR/cycle_active"
cleanup(){
  rm -f "$STATE_DIR/cycle_active"
  "$RECONCILE" || true
  say "eval session ended — bot quits unless the owner is online"
}
trap cleanup EXIT INT TERM

say "eval session $$ started — bringing the bot onto YOON"
"$RECONCILE"

# Wait for the bot's MCP to answer (service start + YOON login takes a bit).
TOKEN="$(node -e 'process.stdout.write(require("./keys.json").mcp_token||"")')"
[ -n "$TOKEN" ] || die "no mcp_token in keys.json"
deadline=$(( $(date +%s) + 150 ))
until curl -sf -m 5 -X POST "http://127.0.0.1:${MCP_PORT}/mcp" \
        -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"ping"}' >/dev/null 2>&1; do
  [ "$(date +%s)" -lt "$deadline" ] || die "bot MCP never came up on :${MCP_PORT} within 150s"
  sleep 3
done
say "bot MCP reachable — starting cycles (MAX_CYCLES=${MAX_CYCLES:-∞})"

i=0
while :; do
  i=$((i+1))
  say "──────── cycle $i ────────"
  bash eval/loop.sh || { echo "loop.sh exited non-zero — ending session"; break; }
  if [ "$MAX_CYCLES" -gt 0 ] && [ "$i" -ge "$MAX_CYCLES" ]; then break; fi
done
