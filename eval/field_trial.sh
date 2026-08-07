#!/usr/bin/env bash
# eval/field_trial.sh — Field Trial v1: the whole benchmark set, twice.
#   arm ON  — deterministic harness as shipped (no flag)
#   arm OFF — .runtime/harness_off present: stock-agent ablation (raw state,
#             no gates, no reflexes, no verified finishes)
# Rows land in pincercraft_evals.db tagged task_set=bench_on / bench_off,
# task_source=llm, referee-labeled. Measurement-only: no analyzer, no improver.
#
# Runs against the dedicated eval server (pincercraft-ts, :25566), NOT the
# owner's live world — see preregistration.md §7. Until 2026-08-07 this header
# claimed that while settings.js hardcoded :25565, so Field Trial v1 in fact ran
# on YOON. The target is now set explicitly via .runtime/target.json and
# verified after spawn; a campaign that cannot confirm the eval server aborts.
#
# Usage: bash eval/field_trial.sh            # both arms, N tasks each
#        ARMS=off bash eval/field_trial.sh   # one arm only (on|off|both)
#        EVAL_PORT=25565 bash ...            # deliberate override (not for campaigns)
# Requires: pincercraft-ts running, `claude` CLI, keys.json mcp_token.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
STATE_DIR="$ROOT/.runtime"; mkdir -p "$STATE_DIR"
RECONCILE="/usr/local/bin/daedelus404-reconcile.sh"
OFF_FLAG="$STATE_DIR/harness_off"
TARGET_FILE="$STATE_DIR/target.json"
EVAL_HOST="${EVAL_HOST:-127.0.0.1}"
EVAL_PORT="${EVAL_PORT:-25566}"
ARMS="${ARMS:-both}"
# process.stdout.write, NOT console.log — under FORCE_COLOR (set by some CI
# shells) console.log wraps numbers in ANSI codes and seq silently no-ops.
N=$(node -e 'process.stdout.write(String(require("./eval/benchmarks.json").length))')
case "$N" in (*[!0-9]*|'') die "benchmark count came out non-numeric: '$N'";; esac

say(){ printf '\n\033[1;33m■ %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Eval-session presence (same contract as session.sh): flag stores our PID so
# a dead runner never pins the bot up. play_logger stays quiet under this flag;
# loop.sh owns every row.
echo $$ > "$STATE_DIR/cycle_active"
# target.json is removed BEFORE the restart so the bot comes back on YOON and
# the owner's casual play is unaffected the moment the campaign ends.
cleanup(){
  rm -f "$STATE_DIR/cycle_active" "$OFF_FLAG" "$TARGET_FILE"
  sudo systemctl restart daedelus404.service >/dev/null 2>&1 || true
  "$RECONCILE" >/dev/null 2>&1 || true
  say "field trial ended — flags cleared, bot returned to YOON"
}
trap cleanup EXIT INT TERM

# Point the bot at the eval server. Written before any restart so every arm,
# including the first, joins pincercraft-ts rather than the owner's world.
ss -tln 2>/dev/null | grep -q ":${EVAL_PORT}\b" \
  || die "nothing listening on :${EVAL_PORT} — start the eval server before a campaign"
printf '{"host":"%s","port":%s}\n' "$EVAL_HOST" "$EVAL_PORT" > "$TARGET_FILE"
say "eval target set: ${EVAL_HOST}:${EVAL_PORT}"

wait_mcp(){
  local TOKEN deadline
  TOKEN="$(node -e 'process.stdout.write(require("./keys.json").mcp_token||"")')"
  [ -n "$TOKEN" ] || die "no mcp_token in keys.json"
  deadline=$(( $(date +%s) + 180 ))
  until curl -sf -m 5 -X POST http://127.0.0.1:8765/mcp \
          -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
          -d '{"jsonrpc":"2.0","id":1,"method":"ping"}' >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || die "bot MCP never came up within 180s"
    sleep 4
  done
}

# Cancel every not-done task so the next benchmark's add auto-starts. Reads
# the queue's persist file (bots/Daedelus404/tasks.json) for ids; cancels via
# MCP. A lingering in_progress task (timeout, or leftover from a previous
# session) would otherwise block every later add+start.
clear_queue(){
  local TOKEN ids id
  ids=$(node -e '
    try {
      const t = require("./bots/Daedelus404/tasks.json").tasks || [];
      console.log(t.filter(x => x.status !== "done").map(x => x.id).join(" "));
    } catch { /* no file -> nothing to clear */ }
  ')
  [ -n "$ids" ] || return 0
  TOKEN="$(node -e 'process.stdout.write(require("./keys.json").mcp_token||"")')"
  for id in $ids; do
    say "clearing lingering task #$id"
    curl -sf -m 10 -X POST http://127.0.0.1:8765/mcp \
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"run_raw_command","arguments":{"command":"!cancelTask('"$id"')"}}}' >/dev/null || true
  done
}

# Bot fully in-world, not just MCP-up: commands issued pre-spawn can hang an
# orchestrator run forever (run-4 wedge). !stats answers with a Position only
# once spawned.
wait_spawn(){
  local TOKEN deadline out
  TOKEN="$(node -e 'process.stdout.write(require("./keys.json").mcp_token||"")')"
  deadline=$(( $(date +%s) + 180 ))
  while :; do
    out=$(curl -sf -m 8 -X POST http://127.0.0.1:8765/mcp \
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"run_raw_command","arguments":{"command":"!stats"}}}' 2>/dev/null) || out=''
    case "$out" in (*Position*) return 0;; esac
    [ "$(date +%s)" -lt "$deadline" ] || die "bot never spawned in-world within 180s"
    sleep 4
  done
}

# Confirm from the OS, not from our own config file, that the bot really is on
# the eval server. settings.js could have been overridden, the file could have
# been cleared by a concurrent session, or a stale process could have survived
# the restart — any of which would silently run the campaign in the owner's
# live world and confound the whole dataset. Cheap check, catastrophic miss.
assert_target(){
  local pid
  pid=$(systemctl show -p MainPID --value daedelus404.service 2>/dev/null)
  [ -n "$pid" ] && [ "$pid" != 0 ] || die "cannot resolve bot PID to verify the eval target"
  if ! ss -tnp 2>/dev/null | grep "pid=${pid}," | grep -q "127.0.0.1:${EVAL_PORT}"; then
    die "bot (pid $pid) is NOT connected to :${EVAL_PORT} — refusing to run a campaign in the owner's live world (preregistration.md §7)"
  fi
  say "verified: bot pid $pid connected to eval server :${EVAL_PORT}"
}

run_arm(){
  local arm="$1" i
  if [ "$arm" = off ]; then touch "$OFF_FLAG"; else rm -f "$OFF_FLAG"; fi
  # Fresh bot process per arm: clean orchestrator history, and the arm's
  # harness mode is unambiguous from the first turn.
  say "arm $arm: restarting bot (harness_off flag: $([ -f "$OFF_FLAG" ] && echo present || echo absent))"
  sudo systemctl restart daedelus404.service || die "bot restart failed"
  wait_mcp
  wait_spawn
  assert_target
  clear_queue
  # The queue's anti-churn guard rejects re-adding a just-cancelled description
  # for thrashWindowMs (15s); benchmark descriptions repeat across runs, so an
  # arm-start cancel of a leftover would eat cycle 1 (runs 3 & 4). Wait it out.
  sleep 20
  say "arm $arm: bot up — running $N benchmark tasks"
  # Failure budget: rc=42 (credit/usage-limit) parks the whole rig immediately
  # (owner rule: park everything when the token balance hits 0); two
  # consecutive rc=43 (task never added) parks too — run 6 burned 19 cycles
  # re-failing the same add with the evidence discarded.
  local addfails=0 rc
  for i in $(seq 1 "$N"); do
    say "arm $arm — task $i/$N"
    MODE=bench BENCH_IDX=$((i-1)) TASKSET="bench_$arm" RUN_ANALYZER=0 RUN_IMPROVER=0 \
      WATCH_TIMEOUT="${WATCH_TIMEOUT:-480}" bash eval/loop.sh
    rc=$?
    case "$rc" in
      0)  addfails=0 ;;
      42) die "task-giver hit the usage/credit limit — parking the rig" ;;
      43) addfails=$((addfails+1))
          [ "$addfails" -ge 2 ] && die "task-giver failed to add a task $addfails times in a row — parking the rig"
          say "arm $arm task $i: task never added (rc=43) — retry budget $addfails/2" ;;
      *)  addfails=0
          say "arm $arm task $i: loop.sh rc=$rc (timeout/cancel) — row still logged, continuing" ;;
    esac
    clear_queue
  done
  say "arm $arm complete"
}

case "$ARMS" in
  on)   run_arm on ;;
  off)  run_arm off ;;
  both) run_arm on; run_arm off ;;
  *)    die "ARMS must be on|off|both" ;;
esac

say "FIELD TRIAL DONE — summarize with:
  python3 - <<'EOF'
import sqlite3
con = sqlite3.connect('pincercraft_evals.db')
for arm in ('bench_on','bench_off'):
    n, ok = con.execute(\"select count(*), sum(success) from task_attempts where task_set=?\", (arm,)).fetchone()
    print(arm, f'{ok or 0}/{n or 0}')
EOF"
