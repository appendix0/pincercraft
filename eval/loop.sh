#!/usr/bin/env bash
# eval/loop.sh — ONE cycle of the Daedelus404 self-improvement loop:
#   give a task → watch it run → measure → diagnose → draft a fix (branch only).
# The improver STOPS for your review; nothing is ever merged or pushed by this
# script. Run it again (or `/loop eval/loop.sh`) for the next cycle.
#
# Env knobs:  MODE=explore|bench  WATCH_TIMEOUT=900  TASKGIVER_BUDGET=0.50  IMPROVER_BUDGET=2.00
#             RUN_ANALYZER=0 RUN_IMPROVER=0  — measurement-only cycles (e.g. the
#             referee-agreement run: task + referee verdict + DB row, no LLM
#             diagnosis and no fix branch).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
EVAL="$ROOT/eval"; BOTLOG="$ROOT/bot.log"; QLOG="$ROOT/queue.log"
MODE="${MODE:-explore}"
WATCH_TIMEOUT="${WATCH_TIMEOUT:-900}"
TASKGIVER_BUDGET="${TASKGIVER_BUDGET:-0.50}"
IMPROVER_BUDGET="${IMPROVER_BUDGET:-2.00}"
RUN_ANALYZER="${RUN_ANALYZER:-1}"
RUN_IMPROVER="${RUN_IMPROVER:-1}"

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
# Pre-add referee baseline: read BEFORE the task exists, so an instantly
# completable task can't outrace its own snapshot (run-3 false-FAIL race).
node eval/referee.mjs preinv >/dev/null 2>&1 || true
QSTART=$(wc -l < "$QLOG")
if [ "$MODE" = bench ]; then
  N=$(node -e 'process.stdout.write(String(require("./eval/benchmarks.json").length))')
  # BENCH_IDX (from field_trial.sh) pins the benchmark explicitly; the
  # metrics-count fallback repeats a benchmark forever when cycles fail
  # without appending a row (run 6 ground 19 cycles on #9).
  IDX="${BENCH_IDX:-$(( $(wc -l < "$EVAL/metrics.jsonl") % N ))}"
  DESC=$(node -e "process.stdout.write(require('./eval/benchmarks.json')[$IDX].description)")
  EF=$(node -e "process.stdout.write(require('./eval/benchmarks.json')[$IDX].end_factor)")
  TIER=$(node -e "process.stdout.write(String(require('./eval/benchmarks.json')[$IDX].tier))")
  say "benchmark #$IDX (tier $TIER): $DESC"
  # Output captured, not discarded: run 6's task-giver died 19x in a row with
  # zero evidence because stdout went to /dev/null. Credit/usage-limit
  # failures exit 42 so the trial runner can park everything (owner rule).
  TG_OUT=$(claude -p "Call add_task with description=\"$DESC\" and end_factor=\"$EF\". Do nothing else." \
    --mcp-config "$MCP_CFG" --strict-mcp-config \
    --allowedTools "mcp__pincer__add_task" --max-budget-usd "$TASKGIVER_BUDGET" --output-format text 2>&1)
  TG_RC=$?
  if [ "$TG_RC" -ne 0 ] || printf '%s' "$TG_OUT" | grep -qiE 'usage limit|credit balance|out of credit|insufficient credit'; then
    printf 'task-giver output (rc=%s):\n%s\n' "$TG_RC" "$TG_OUT" >&2
    printf '%s' "$TG_OUT" | grep -qiE 'usage limit|credit balance|out of credit|insufficient credit' && exit 42
  fi
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
if [ -z "$TASKID" ]; then
  [ -n "${TG_OUT:-}" ] && printf 'task-giver said:\n%s\n' "$TG_OUT" >&2
  # Distinct code so the trial runner can tell "add failed" from a task that
  # ran and timed out (both are non-zero otherwise).
  printf '\033[1;31m✗ no new task id appeared in queue.log after task-giver\033[0m\n' >&2
  exit 43
fi

# Referee snapshot: pre-task inventory + the task's end_factor (from the ef=
# field on the queue.log add line). Runs right after the id appears — with
# add+start the bot may already be moving, so a late baseline can only shrink
# the measured delta (bias toward false FAIL, never false pass). Non-fatal:
# on failure the judge falls back to the honor-system label.
SNAP=$(node eval/referee.mjs snapshot "$TASKID" 2>/dev/null) || SNAP='{}'
DESC=$(node -e 'const s=JSON.parse(process.argv[1]||"{}");process.stdout.write(s.description||"")' "$SNAP")
EF=$(node -e 'const s=JSON.parse(process.argv[1]||"{}");process.stdout.write(s.end_factor||"")' "$SNAP")
# Fallback description parse if the snapshot failed (first JSON string on the add line).
[ -n "$DESC" ] || DESC=$(grep -m1 -E "#$TASKID " "$QLOG" | node -e 'const l=require("fs").readFileSync(0,"utf8");const m=l.match(/"(?:[^"\\]|\\.)*"/);process.stdout.write(m?JSON.parse(m[0]):"")')
say "task #$TASKID queued: $DESC${EF:+   [done when: $EF]}"

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

# ── 2a. what the HARNESS did, as distinct from what the agent claimed and what
# the referee measured. Read from this run's own bot.log slice so the three
# outcomes are independently recoverable per attempt:
#   agent   -> $OUTCOME        (did the model declare completion?)
#   harness -> below           (did verify block it / did autofinish trigger?)
#   referee -> $VERDICT        (was the world state actually correct?)
# Without this the middle term lived only in bot.log, unlinked to the row, so
# no analysis could separate "the agent got it right" from "the harness caught
# it". `off` is read from the ablation flag rather than inferred from silence —
# a layer that is ON but never had cause to fire must not look ablated.
SLICE_TXT=$(sed -n "${LSTART},${LEND}p" "$BOTLOG")
if [ -e "$ROOT/.runtime/harness_off" ] || [ -e "$ROOT/.runtime/harness_off_verify" ] \
   || [ -e "$ROOT/.runtime/harness_off_measurement" ]; then
  HVERIFY=off
elif printf '%s' "$SLICE_TXT" | grep -qa "\[verify\] Task #$TASKID not finished"; then
  HVERIFY=blocked
else
  HVERIFY=passed
fi
if [ -e "$ROOT/.runtime/harness_off" ] || [ -e "$ROOT/.runtime/harness_off_autofinish" ] \
   || [ -e "$ROOT/.runtime/harness_off_measurement" ]; then
  HAUTOFIN=off
elif printf '%s' "$SLICE_TXT" | grep -qa "auto-finishing #$TASKID"; then
  HAUTOFIN=fired
else
  HAUTOFIN=not_fired
fi
say "harness: verify=$HVERIFY autofinish=$HAUTOFIN"

# ── 2b. referee verdict — success from world state, not the bot's say-so ────
# Independent re-read of the inventory vs the pre-task snapshot. When the
# end_factor parses to an inventory shape, THIS is the success label; the
# queue outcome only labels rows the referee can't measure (honor_system).
VERDICT=$(node eval/referee.mjs judge "$TASKID" "$OUTCOME" 2>/dev/null)
[ -n "$VERDICT" ] || VERDICT='{"parseable":false,"label_source":"honor_system","referee_failure_mode":null}'
say "referee: $VERDICT"

# ── 3. metrics → metrics.jsonl ─────────────────────────────────────────────
M=$(node eval/metrics.mjs "$BOTLOG" --range "$LSTART" "$LEND")
M=$(node -e 'const m=JSON.parse(process.argv[1]);Object.assign(m,{ts:new Date().toISOString(),id:+process.argv[2],description:process.argv[3],outcome:process.argv[4],mode:process.argv[5]});process.stdout.write(JSON.stringify(m))' \
     "$M" "$TASKID" "$DESC" "$OUTCOME" "$MODE")
echo "$M" >> "$EVAL/metrics.jsonl"
printf '%s' "$M" | node -e 'const m=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(`  outcome=${m.outcome} turns=${m.turns} block_ops=${m.work.block_ops} tok/op=${m.tokens_per_block_op} in/turn=${m.avg_input_per_turn} cache_hit=${m.cache_hit_ratio} ~$${m.est_cost_usd}`)'

# ── 4. analyze (read-only) ─────────────────────────────────────────────────
if [ "$RUN_ANALYZER" = 1 ]; then
sed -n "${LSTART},${LEND}p" "$BOTLOG" > "$SLICE"
if [ "$(wc -l < "$SLICE")" -gt 600 ]; then
  { head -150 "$SLICE"; echo "...[trimmed middle]..."; tail -450 "$SLICE"; } > "$SLICE.t" && mv "$SLICE.t" "$SLICE"
fi
DIAG="$EVAL/diagnoses/task-$TASKID-$(date +%Y%m%d-%H%M%S).md"
say "analyzer diagnosing → $DIAG"
claude -p "$(cat "$EVAL/prompts/analyzer.md")

## Task
#$TASKID — $DESC   (outcome: $OUTCOME)

## Referee verdict (deterministic inventory check — trust this over the bot's claims)
$VERDICT

## Metrics
$M

## bot.log slice (lines $LSTART–$LEND)
$(cat "$SLICE")" --output-format text > "$DIAG"
else
  DIAG=/dev/null
  say "analyzer skipped (RUN_ANALYZER=0) — referee verdict is the only label"
fi

# ── 4a. configuration and trace pointer ────────────────────────────────────
# The model/inference config in force, and where this attempt's action trace
# lives. Neither was recoverable from the row before: a model or sampling
# change mid-campaign would have been invisible in the data — arms could have
# differed in the one variable the protocol most insists on holding fixed —
# and the trace could only be found by guessing the filename.
# Resolved from settings.js -> the active profile, i.e. what actually launched.
MODELCFG=$(node -e '
  import("./settings.js").then(async (m) => {
    const s = m.default || m;
    const p = (s.profiles || [])[0];
    const prof = JSON.parse((await import("fs")).readFileSync(p, "utf8"));
    process.stdout.write(JSON.stringify({
      profile: p, name: prof.name, planner: prof.model,
      coder: prof.code_model, max_tokens: prof.max_tokens,
    }));
  }).catch(() => process.stdout.write(""));
' 2>/dev/null)
BOTNAME=$(printf '%s' "$MODELCFG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).name||"")}catch{}})' 2>/dev/null)
EPISODE=""
if [ -n "$BOTNAME" ] && [ -f "$ROOT/bots/$BOTNAME/episodes/$TASKID.jsonl" ]; then
  EPISODE="bots/$BOTNAME/episodes/$TASKID.jsonl"
fi

# ── 4b. log the attempt to pincercraft_evals.db ────────────────────────────
PROG=$(grep -oE 'PROGRESS_SCORE=[0-9.]+'        "$DIAG" | head -1 | cut -d= -f2)
FMODE=$(grep -oE 'FAILURE_MODE=[A-Za-z0-9_-]+'  "$DIAG" | head -1 | cut -d= -f2)
ROW=$(node -e '
  const m=JSON.parse(process.argv[1]), t=m.tokens||{};
  const id=process.argv[2], name=process.argv[3], tier=process.argv[4],
        commit=process.argv[5], outcome=process.argv[6], wall=process.argv[7],
        prog=process.argv[8], fmode=process.argv[9], taskset=process.argv[10],
        v=JSON.parse(process.argv[11]||"{}"), ef=process.argv[12],
        seed=process.argv[13], armpos=process.argv[14],
        hverify=process.argv[15], hautofin=process.argv[16],
        modelcfg=process.argv[17], episode=process.argv[18];
  // Referee verdict is the label when it could measure; queue outcome only
  // labels unmeasurable criteria (label_source records which one applied).
  const success = typeof v.success==="boolean" ? v.success : outcome==="done";
  const row={ task_id:id, task_name:name, difficulty_tier:tier, task_set:taskset,
    task_source:"llm", commit_hash:commit, success,
    label_source: v.label_source||"honor_system",
    input_tokens:(t.input||0)+(t.cache_read||0)+(t.cache_creation||0),
    output_tokens:(t.output||0), steps:m.turns||0, wall_clock_seconds:Number(wall||0) };
  if (seed) row.seed=Number(seed);
  if (armpos) row.arm_position=Number(armpos);
  if (hverify) row.harness_verify=hverify;
  if (hautofin) row.harness_autofinish=hautofin;
  if (modelcfg) row.model_config=modelcfg;
  if (episode) row.episode_path=episode;
  if (ef) row.end_factor=ef;
  if (prog) row.progress_score=Number(prog);
  if (!success) row.failure_mode = v.referee_failure_mode || fmode || outcome;
  else if (v.referee_failure_mode) row.failure_mode = v.referee_failure_mode; // e.g. verified but queue_never_finished
  process.stdout.write(JSON.stringify(row));
' "$M" "$TASKID" "$DESC" "$TIER" "$COMMIT" "$OUTCOME" "$WALL" "${PROG:-}" "${FMODE:-}" "${TASKSET:-$MODE}" "$VERDICT" "${EF:-}" "${SEED:-0}" "${ARM_POSITION:-0}" "$HVERIFY" "$HAUTOFIN" "$MODELCFG" "$EPISODE")
printf '%s' "$ROW" | python3 eval/eval_db.py log-attempt >/dev/null \
  && say "logged attempt → pincercraft_evals.db (commit $COMMIT, tier $TIER, ${PROG:-auto} progress)"

# ── 5. improve (branch only, never merge) ──────────────────────────────────
if [ "$RUN_IMPROVER" != 1 ]; then
  say "improver skipped (RUN_IMPROVER=0) — CYCLE DONE (attempt logged; label it: python3 eval/agreement.py label $TASKID <0|1> [notes])"
  exit 0
fi
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
