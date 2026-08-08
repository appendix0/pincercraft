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
# Usage: bash eval/field_trial.sh                       # on+off, 1 seed (smoke)
#        ARMS=off bash eval/field_trial.sh              # one arm
#        ARMS="on off perception gates reflexes measurement" SEEDS=3 \
#          bash eval/field_trial.sh                     # the full campaign
#        EVAL_PORT=25565 bash ...                       # deliberate override (not for campaigns)
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
SEEDS="${SEEDS:-1}"   # campaign uses 3; default stays 1 so a smoke run is cheap
# TAG namespaces the rows. Campaign rows must be tagged `bench` — that is what
# campaign_report.py selects on (task_set LIKE 'bench_%'). A validation run uses
# TAG=smoke so its rows are inert to the analysis: shaking down the rig must
# never be able to add attempts to a published rate.
TAG="${TAG:-bench}"
# TASKS restricts the run to explicit benchmark indices, repeats allowed
# ("7 7 7" = three attempts at #7). Empty means the full shuffled order. Only
# for targeted validation; a campaign arm always runs the whole set.
TASKS="${TASKS:-}"
# process.stdout.write, NOT console.log — under FORCE_COLOR (set by some CI
# shells) console.log wraps numbers in ANSI codes and seq silently no-ops.
N=$(node -e 'process.stdout.write(String(require("./eval/benchmarks.json").length))')

say(){ printf '\n\033[1;33m■ %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Checked after die() exists: called above its definition this printed
# "die: command not found" and carried on with a non-numeric N, which is the
# one case it was written to stop.
case "$N" in (*[!0-9]*|'') die "benchmark count came out non-numeric: '$N'";; esac
case "$TAG" in (*[!a-z0-9_]*|'') die "TAG must be lowercase alnum/underscore: '$TAG'";; esac
case "$TASKS" in (*[!0-9\ ]*) die "TASKS must be space-separated indices: '$TASKS'";; esac
for _t in $TASKS; do
  [ "$_t" -lt "$N" ] || die "TASKS index $_t out of range (benchmarks.json has $N tasks, 0-$((N-1)))"
done

# Eval-session presence (same contract as session.sh): flag stores our PID so
# a dead runner never pins the bot up. play_logger stays quiet under this flag;
# loop.sh owns every row.
echo $$ > "$STATE_DIR/cycle_active"
# target.json is removed BEFORE the restart so the bot comes back on YOON and
# the owner's casual play is unaffected the moment the campaign ends.
cleanup(){
  rm -f "$STATE_DIR/cycle_active" "$OFF_FLAG" "$TARGET_FILE"
  rm -f "$STATE_DIR"/harness_off_*
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

# Fixed pre-attempt world state — the §7 commitment ("bot returned to a known
# position and its inventory cleared between attempts") that was never actually
# implemented. Without it the bot's stock carries across attempts AND arms, and
# since arms always ran in the same order within a backtest, the 4th arm
# (`gates`) inherited the richest inventory in all three backtests and scored
# 30/30 — starting cobblestone predicts success (69%→89% across quartiles), so
# that reads as a layer effect when it is a position confound.
#
# Runs over RCON so the runner, not the agent, holds console powers: an
# LLM-driven bot with op could kill/ban/op itself and the CoC layer is not a
# security boundary.
#
# Opt-in via RESET_STATE=1. It changes conditions, so it must never silently
# apply to a campaign meant to match already-collected backtests.
BOT_NAME="${BOT_NAME:-Daedelus404}"
# Near the middle of the stock actually observed across the campaign, so a
# controlled run sits in the same regime rather than a new one. Net-gain
# criteria are unaffected by held stock: "+16 cobblestone" still needs 16 mined.
RESET_KIT="${RESET_KIT:-128 cobblestone,32 oak_log,64 stick,32 oak_planks,8 coal,1 stone_pickaxe,1 stone_axe,1 crafting_table}"
RESET_POS=""

pin_reset_pos(){
  [ "${RESET_STATE:-0}" = "1" ] || return 0
  [ -n "$RESET_POS" ] && return 0
  RESET_POS="$(python3 eval/rcon.py "data get entity $BOT_NAME Pos" 2>/dev/null \
    | grep -oE '\-?[0-9]+\.[0-9]+' | head -3 | tr '\n' ' ')"
  say "reset position pinned: ${RESET_POS:-<unavailable, position reset skipped>}"
}

reset_state(){
  [ "${RESET_STATE:-0}" = "1" ] || return 0
  local cmds=("clear $BOT_NAME") item qty name
  local IFS=','
  for item in $RESET_KIT; do
    qty="${item%% *}"; name="${item#* }"
    cmds+=("give $BOT_NAME minecraft:$name $qty")
  done
  unset IFS
  [ -n "$RESET_POS" ] && cmds+=("tp $BOT_NAME $RESET_POS")
  python3 eval/rcon.py "${cmds[@]}" >/dev/null 2>&1 \
    || say "reset_state: RCON call failed — attempt runs on carried-over state"
}

# Steps recorded for the attempt loop.sh just logged. Feeds the per-task health
# check: a wedged or brain-dead bot logs 0. Empty output on any error, which the
# caller reads as "healthy" — a broken query must not trigger restarts.
last_steps(){
  python3 -c "import sqlite3;r=sqlite3.connect('pincercraft_evals.db').execute('SELECT COALESCE(steps,0) FROM task_attempts ORDER BY rowid DESC LIMIT 1').fetchone();print(r[0] if r else '')" 2>/dev/null
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

# MainPID and every descendant. Mindcraft's main.js spawns each agent as a
# CHILD process (src/process/agent_process.js), so the Minecraft socket belongs
# to a descendant and never to MainPID itself — checking MainPID alone is a
# guaranteed false negative, which is exactly how the first smoke run aborted
# on a bot that was correctly connected.
service_pids(){
  local root
  root=$(systemctl show -p MainPID --value daedelus404.service 2>/dev/null)
  [ -n "$root" ] && [ "$root" != 0 ] || return 1
  _descend "$root"
}
_descend(){
  local kid
  printf '%s\n' "$1"
  for kid in $(pgrep -P "$1" 2>/dev/null); do _descend "$kid"; done
}

# Confirm from the OS, not from our own config file, that the bot really is on
# the eval server. settings.js could have been overridden, the file could have
# been cleared by a concurrent session, or a stale process could have survived
# the restart — any of which would silently run the campaign in the owner's
# live world and confound the whole dataset. Cheap check, catastrophic miss.
#
# Polled rather than sampled once: the socket appears a moment after spawn, and
# a single early sample would abort a healthy run. Only a sustained absence is
# treated as the real thing.
assert_target(){
  local deadline pids pid socks
  deadline=$(( $(date +%s) + 30 ))
  while :; do
    pids=$(service_pids) || die "cannot resolve bot PID to verify the eval target"
    socks=$(ss -tnp state established 2>/dev/null)
    for pid in $pids; do
      if printf '%s\n' "$socks" | grep "pid=${pid}," \
           | grep -qE "127\.0\.0\.1:${EVAL_PORT}([^0-9]|$)"; then
        say "verified: bot (pid $pid) connected to eval server :${EVAL_PORT}"
        return 0
      fi
    done
    [ "$(date +%s)" -lt "$deadline" ] \
      || die "bot never connected to :${EVAL_PORT} within 30s — refusing to run a campaign in the owner's live world (preregistration.md §7)"
    sleep 2
  done
}

# Deterministic shuffle of the benchmark indices for a seed. Fixed order would
# confound tier with world depletion — later tasks always meet a more chewed-up
# world (preregistration.md §6). An LCG rather than `shuf` so the order is
# reproducible from the seed number alone, and it is echoed into the run log.
task_order(){
  node -e '
    const n = Number(process.argv[1]), seed = Number(process.argv[2]);
    let s = (seed * 2654435761) % 2147483647 || 1;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const a = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    process.stdout.write(a.join(" "));
  ' "$N" "$1"
}

run_arm(){
  local arm="$1" seed="$2" i idx order rc addfails
  # Clear every ablation flag first: an arm must never inherit the previous
  # arm's, which would silently ablate two layers and misattribute the result.
  rm -f "$OFF_FLAG"; rm -f "$STATE_DIR"/harness_off_*
  case "$arm" in
    on)   : ;;
    off)  touch "$OFF_FLAG" ;;
    # `measurement` is the seeds-1-2 compound (verify+autofinish), kept so the
    # published arm stays reproducible; harness_mode.js resolves it.
    perception|gates|reflexes|verify|autofinish|measurement) touch "$STATE_DIR/harness_off_$arm" ;;
    *)    die "unknown arm '$arm' (on|off|perception|gates|reflexes|verify|autofinish|measurement)" ;;
  esac
  # Fresh bot process per arm: clean orchestrator history, and the arm's
  # harness mode is unambiguous from the first turn.
  say "arm $arm seed $seed: restarting bot (flags: $(ls "$STATE_DIR" | grep -c '^harness_off' || true) set)"
  sudo systemctl restart daedelus404.service || die "bot restart failed"
  wait_mcp
  wait_spawn
  assert_target
  clear_queue
  # The queue's anti-churn guard rejects re-adding a just-cancelled description
  # for thrashWindowMs (15s); benchmark descriptions repeat across runs, so an
  # arm-start cancel of a leftover would eat cycle 1 (runs 3 & 4). Wait it out.
  sleep 20
  order=${TASKS:-$(task_order "$seed")}
  say "arm $arm seed $seed: bot up — tasks in order: $order"
  # Failure budget: rc=42 (credit/usage-limit) parks the whole rig immediately
  # (owner rule: park everything when the token balance hits 0); two
  # consecutive rc=43 (task never added) parks too — run 6 burned 19 cycles
  # re-failing the same add with the evidence discarded.
  addfails=0
  # Consecutive zero-step attempts. Two faults have each silently poisoned a
  # whole arm, because the bot is otherwise restarted only BETWEEN arms:
  # bench_measurement seed 2 (API credit exhausted — every LLM call refused,
  # 10 attempts at 0 turns) and bench_on seed 3 (agent wedged holding the
  # action-execution lock — 10 attempts cancelled at 0 steps). Both land in the
  # DB looking like a catastrophic layer effect. See docs/paper/aborts.md.
  deadruns=0
  i=0
  for idx in $order; do
    i=$((i+1))
    say "arm $arm seed $seed — task $i (benchmark #$idx)"
    pin_reset_pos
    reset_state
    MODE=bench BENCH_IDX="$idx" TASKSET="${TAG}_$arm" SEED="$seed" RUN_ANALYZER=0 RUN_IMPROVER=0 \
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
    # Per-task health check. A functioning bot cannot record 0 steps, so this
    # never fires on a real result — only on a bot that is unable to act. Credit
    # exhaustion is not recoverable by a restart, so it parks (owner rule, same
    # as rc=42); a wedge is, so it restarts and carries on.
    if tail -n 800 bot.log 2>/dev/null | grep -qa 'credit balance is too low'; then
      die "Anthropic API credit exhausted — the bot cannot act; parking the rig"
    fi
    if [ "$(last_steps)" = "0" ]; then
      deadruns=$((deadruns+1))
      say "arm $arm task $i: attempt recorded 0 steps ($deadruns in a row)"
      if [ "$deadruns" -ge 2 ]; then
        say "arm $arm: bot looks wedged — restarting before it eats the rest of the arm"
        sudo systemctl restart daedelus404.service || die "bot restart failed"
        wait_mcp; wait_spawn; assert_target; clear_queue
        sleep 20
        deadruns=0
      fi
    else
      deadruns=0
    fi
  done
  say "arm $arm seed $seed complete"
}

# `both` kept for the v1 two-arm invocation; the campaign passes an explicit
# arm list. Seeds are the OUTER loop so arms interleave: any drift in the server
# or the model over a multi-day campaign then hits every arm roughly equally,
# instead of landing entirely on whichever arm ran last (preregistration.md §6).
case "$ARMS" in
  both) ARM_LIST="on off" ;;
  *)    ARM_LIST="$ARMS" ;;
esac

for seed in $(seq "${SEED_START:-1}" "$SEEDS"); do
  for arm in $ARM_LIST; do
    run_arm "$arm" "$seed"
  done
done

say "CAMPAIGN SEGMENT DONE (arms: $ARM_LIST · seeds: $SEEDS) — summarize with:
  python3 eval/campaign_report.py"
