#!/usr/bin/env bash
# eval/loop.sh — ONE cycle of the Daedelus404 self-improvement loop:
#   give a task → watch it run → measure → diagnose → draft a fix (branch only).
# The improver STOPS for your review; nothing is ever merged or pushed by this
# script. Run it again (or `/loop eval/loop.sh`) for the next cycle.
#
# Env knobs:  MODE=explore|bench  WATCH_TIMEOUT=900  TASKGIVER_BUDGET=0.50  IMPROVER_BUDGET=2.00
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
EVAL="$ROOT/eval"; BOTLOG="$ROOT/bot.log"; QLOG="$ROOT/queue.log"
MODE="${MODE:-explore}"
WATCH_TIMEOUT="${WATCH_TIMEOUT:-900}"
TASKGIVER_BUDGET="${TASKGIVER_BUDGET:-0.50}"
IMPROVER_BUDGET="${IMPROVER_BUDGET:-2.00}"

# The three loop agents (task-giver, analyzer, improver) run through the `claude`
# CLI on the Claude subscription (OAuth in ~/.claude/.credentials.json), NOT the
# metered API. keys.json carries an ANTHROPIC_API_KEY for the in-world bot; if it
# leaks into our env the CLI silently bills it as API usage, so strip it (and any
# auth token) here. The bot runs as a separate process and is unaffected.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)  # code under eval
TIER="explore"                                                    # overridden in bench mode

say(){ printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
SLICE=$(mktemp); trap 'rm -f "$SLICE"' EXIT

# ── 0. preflight ───────────────────────────────────────────────────────────
command -v claude >/dev/null || die "claude CLI not found"
TOKEN="$(node -e 'process.stdout.write(require("./keys.json").mcp_token||"")')"
[ -n "$TOKEN" ] || die "no mcp_token in keys.json"
MCP_CFG='{"mcpServers":{"pincer":{"type":"http","url":"http://127.0.0.1:8765/mcp","headers":{"Authorization":"Bearer '"$TOKEN"'"}}}}'
curl -sf -m 5 -X POST http://127.0.0.1:8765/mcp -H "Authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}' >/dev/null \
  || die "MCP not reachable on :8765 — start the bot (after enabling mcp):  cd $ROOT && node main.js >> bot.log 2>&1 &"
say "preflight ok — MCP reachable, mode=$MODE"

# ── 1. give a task ─────────────────────────────────────────────────────────
QSTART=$(wc -l < "$QLOG")
if [ "$MODE" = bench ]; then
  N=$(node -e 'console.log(require("./eval/benchmarks.json").length)')
  IDX=$(( $(wc -l < "$EVAL/metrics.jsonl") % N ))
  DESC=$(node -e "process.stdout.write(require('./eval/benchmarks.json')[$IDX].description)")
  EF=$(node -e "process.stdout.write(require('./eval/benchmarks.json')[$IDX].end_factor)")
  TIER=$(node -e "process.stdout.write(String(require('./eval/benchmarks.json')[$IDX].tier))")
  say "benchmark #$IDX (tier $TIER): $DESC"
  claude -p "Call add_task with description=\"$DESC\" and end_factor=\"$EF\". Do nothing else." \
    --mcp-config "$MCP_CFG" --strict-mcp-config \
    --allowedTools "mcp__pincer__add_task" --max-budget-usd "$TASKGIVER_BUDGET" --output-format text >/dev/null
else
  say "task-giver inventing a challenge…"
  claude -p "$(cat "$EVAL/prompts/task-giver.md")

## Recent efficiency metrics (last 5 cycles)
$(tail -5 "$EVAL/metrics.jsonl" 2>/dev/null || echo '(none yet)')

## Recent changelog
$(sed -n '1,40p' docs/CHANGELOG.md)" \
    --mcp-config "$MCP_CFG" --strict-mcp-config \
    --allowedTools "mcp__pincer__add_task,mcp__pincer__show_queue,mcp__pincer__read_stats" \
    --max-budget-usd "$TASKGIVER_BUDGET" --output-format text
fi

# ── 2. find the new task id, wait for start, then terminal state ───────────
sleep 2
TASKID=$(tail -n +$((QSTART+1)) "$QLOG" | grep -oE '#[0-9]+' | head -1 | tr -d '#')
[ -n "$TASKID" ] || die "no new task id appeared in queue.log after task-giver"
DESC=$(grep -m1 "#$TASKID " "$QLOG" | sed -E 's/^[^"]*"//; s/"[^"]*$//')
say "task #$TASKID queued: $DESC"

deadline=$(( $(date +%s) + WATCH_TIMEOUT ))
until grep -qE "(start|add\+start) #$TASKID " "$QLOG"; do
  [ "$(date +%s)" -lt "$deadline" ] || die "task #$TASKID never started in ${WATCH_TIMEOUT}s"
  sleep 3
done
LSTART=$(wc -l < "$BOTLOG"); T0=$(date +%s)
say "task #$TASKID running (bot.log @ $LSTART) — watching for finish/cancel…"

OUTCOME=timeout
while [ "$(date +%s)" -lt "$deadline" ]; do
  if grep -qE "finish #$TASKID done" "$QLOG"; then OUTCOME=done; break; fi
  if grep -qE "cancel #$TASKID " "$QLOG";   then OUTCOME=cancelled; break; fi
  sleep 5
done
LEND=$(wc -l < "$BOTLOG"); WALL=$(( $(date +%s) - T0 ))
say "task #$TASKID → $OUTCOME in ${WALL}s (bot.log lines $LSTART–$LEND)"

# ── 3. metrics → metrics.jsonl ─────────────────────────────────────────────
M=$(node eval/metrics.mjs "$BOTLOG" --range "$LSTART" "$LEND")
M=$(node -e 'const m=JSON.parse(process.argv[1]);Object.assign(m,{ts:new Date().toISOString(),id:+process.argv[2],description:process.argv[3],outcome:process.argv[4],mode:process.argv[5]});process.stdout.write(JSON.stringify(m))' \
     "$M" "$TASKID" "$DESC" "$OUTCOME" "$MODE")
echo "$M" >> "$EVAL/metrics.jsonl"
printf '%s' "$M" | node -e 'const m=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(`  outcome=${m.outcome} turns=${m.turns} block_ops=${m.work.block_ops} tok/op=${m.tokens_per_block_op} in/turn=${m.avg_input_per_turn} cache_hit=${m.cache_hit_ratio} ~$${m.est_cost_usd}`)'

# ── 4. analyze (read-only) ─────────────────────────────────────────────────
sed -n "${LSTART},${LEND}p" "$BOTLOG" > "$SLICE"
if [ "$(wc -l < "$SLICE")" -gt 600 ]; then
  { head -150 "$SLICE"; echo "...[trimmed middle]..."; tail -450 "$SLICE"; } > "$SLICE.t" && mv "$SLICE.t" "$SLICE"
fi
DIAG="$EVAL/diagnoses/task-$TASKID-$(date +%Y%m%d-%H%M%S).md"
say "analyzer diagnosing → $DIAG"
claude -p "$(cat "$EVAL/prompts/analyzer.md")

## Task
#$TASKID — $DESC   (outcome: $OUTCOME)

## Metrics
$M

## bot.log slice (lines $LSTART–$LEND)
$(cat "$SLICE")" --output-format text > "$DIAG"

# ── 4b. log the attempt to pincercraft_evals.db ────────────────────────────
PROG=$(grep -oE 'PROGRESS_SCORE=[0-9.]+'        "$DIAG" | head -1 | cut -d= -f2)
FMODE=$(grep -oE 'FAILURE_MODE=[A-Za-z0-9_-]+'  "$DIAG" | head -1 | cut -d= -f2)
ROW=$(node -e '
  const m=JSON.parse(process.argv[1]), t=m.tokens||{};
  const id=process.argv[2], name=process.argv[3], tier=process.argv[4],
        commit=process.argv[5], outcome=process.argv[6], wall=process.argv[7],
        prog=process.argv[8], fmode=process.argv[9], taskset=process.argv[10];
  const success = outcome==="done";
  const row={ task_id:id, task_name:name, difficulty_tier:tier, task_set:taskset,
    commit_hash:commit, success,
    input_tokens:(t.input||0)+(t.cache_read||0)+(t.cache_creation||0),
    output_tokens:(t.output||0), steps:m.turns||0, wall_clock_seconds:Number(wall||0) };
  if (prog) row.progress_score=Number(prog);
  if (!success) row.failure_mode = fmode || outcome;
  process.stdout.write(JSON.stringify(row));
' "$M" "$TASKID" "$DESC" "$TIER" "$COMMIT" "$OUTCOME" "$WALL" "${PROG:-}" "${FMODE:-}" "$MODE")
printf '%s' "$ROW" | python3 eval/eval_db.py log-attempt >/dev/null \
  && say "logged attempt → pincercraft_evals.db (commit $COMMIT, tier $TIER, ${PROG:-auto} progress)"

# ── 5. improve (branch only, never merge) ──────────────────────────────────
BR="improve/task-$TASKID-$(date +%H%M%S)"
say "improver drafting a fix on branch $BR …"
claude -p "$(cat "$EVAL/prompts/improver.md")

Create and work on git branch: $BR (off develop).

## Diagnosis
$(cat "$DIAG")

## Metrics for this task
$M" \
  --add-dir "$ROOT" \
  --allowedTools "Read,Edit,Write,Grep,Glob,Bash(git:*),Bash(node:*),Bash(npx:*)" \
  --disallowedTools "Bash(rm:*),Bash(sudo:*),Bash(git push:*),Bash(git merge:*)" \
  --permission-mode acceptEdits --max-budget-usd "$IMPROVER_BUDGET" --output-format text

# ── 6. surface for approval — NOTHING merged ───────────────────────────────
say "CYCLE DONE — review:"
if git rev-parse --verify "$BR" >/dev/null 2>&1; then
  BHASH=$(git rev-parse --short "$BR"); BSUBJ=$(git log -1 --format=%s "$BR")
  node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({branch:process.argv[2],commit:process.argv[3],summary:process.argv[4]}))' \
    "$EVAL/.pending_gate.json" "$BR" "$BHASH" "$BSUBJ"
  git --no-pager diff develop.."$BR" --stat
  echo
  echo "  approve: bash eval/gate.sh approve \"why you accepted it\""
  echo "  reject : bash eval/gate.sh reject  \"why you rejected it\""
  echo "  (either way, the gate decision is logged to gate_decisions)"
else
  echo "  improver made no branch (judged no safe change). See $DIAG"
fi
echo
say "nothing merged. Re-run for the next cycle, or: /loop eval/loop.sh"
