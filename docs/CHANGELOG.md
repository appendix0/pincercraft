# PincerCraft Changelog

## 2026-06-05 — parse "net +N <item>" gain end_factors (task-225)

**Change.** `matchCountIncrease` in `verify.js` now recognizes the
task-giver's `"net +6 cobblestone in inventory"` gain phrasing (the
leading `+` denotes a delta) in addition to the existing "increased
by N" / "N new <item>" forms. Because both `snapshotStartCounts` (queue
start hook) and `verifyEndFactor` (finishTask gate) route through this
one matcher, the change wires up the start-of-task snapshot *and* the
finish gate at once: finish is blocked until `count_now - count_start ≥
N`. Single-line matcher addition; no behavior change for any other
phrasing (existing matchers and fuzzy pass-through are untouched).

**Hypothesis (task-225 diagnosis).** #225 ("mine ≥6 NEW cobblestone")
mined nothing (`mine=0, collect=0, block_ops=0`) yet was marked `done`
via the honor-system path because its end_factor `"net +6 cobblestone in
inventory"` fell through every matcher to `{ programmatic: false }`. A
false success. Making the criterion measurable converts the false `done`
into a real, delta-aware check that the bot can only satisfy by actually
mining this run.

**Metric.** Success/failure correctness — block a `done` until
`work.mine`/`block_ops` are non-zero for "net +N" gather tasks (and
reject a finish that relies on pre-existing stock, since the check is a
delta vs. the start snapshot). Verify: `verifyEndFactor` for
`"net +6 cobblestone in inventory"` returns `verified:false` when the
run mined 0 (have 0, start 0) and `verified:true` only at start 0 / now
6; held-6-mined-0 (start 6, now 6) is still blocked.

## 2026-05-27 — sender-independent stuck recovery (task-197)

**Change.** The stuck watcher (`_startStuckWatcher` in `agent.js`) no
longer dead-ends when there is no `last_sender`. Previously, with no
player to `/tp` to (explore/autonomous mode), it logged `skip TP
(throttled)` and returned every tick, leaving a frozen
`searchForBlock`/`collectBlocks` wedged until `HARD_CAP`. Now the
no-sender branch calls `requestInterrupt()` (stopDigging +
collectBlock.cancelTask + pathfinder.stop + pvp.stop) so the in-flight
action unwinds and the orchestrator can re-issue it. Both recovery paths
(TP-to-player and self-unstick) now share the same cooldown + 3-in-5-min
kill-switch, so the new path can't loop. No random vertical-hop TP — the
lava/location-loss risk the original comment warned about is unchanged.

**Hypothesis (task-197 diagnosis).** #197 ("chop 5 oak logs") froze in
`searchForBlock`/`collectBlocks` and was cancelled with `block_ops=0`
after burning 19 turns / ~221k tokens to `HARD_CAP`. The freeze hit the
`no last_sender — skip TP` branch every cycle because recovery was gated
on a player message that never exists in explore mode, so the unstick
never fired. Removing that dead branch lets a wedged action recover
autonomously.

**Metric.** Move `block_ops` from 0 to >0 (restoring a finite
`tokens_per_block_op`) and flip the outcome away from `cancelled` for
autonomous-mode gather/mine tasks. Verify: re-run an explore-mode chop
task; when the bot freezes mid-`collectBlocks`, the log shows `[stuck]
… no last_sender → self-unstick (interrupt)` (not `skip TP`) and the
action resumes instead of parking at `HARD_CAP`.

## 2026-05-18 — Overnight build: phases B → I

The Daedelus404 bot becomes a Claude-Code-style agent. Phases A and 1
landed on 2026-05-17; everything below shipped in one autonomous overnight
session driven by a `/loop` task list (21 tasks, see commit log).

### Phase B — Tool metadata standardization
- `isReadOnly`, `isConcurrencySafe`, `prompt(ctx)`, and `checkPermissions`
  are now per-command hooks. Queries default to both safety flags via a
  one-line post-list loop; actions are tagged inline.
- The old hardcoded `SIDE_CHAT_SAFE_COMMANDS` Set is gone — adding a new
  safe command no longer requires touching `classify_and_gate.js`.

### Phase C — Plan Mode
- `!enterPlanMode` / `!exitPlanMode` commands plus a body-touching gate
  inside `executeCommand`. Plan-mode renders the task queue with a
  `(PLAN MODE — awaiting player approval)` header.
- Auto-trigger on task-request classifier; auto-exit on short approval
  replies (`ok`, `yes`, `go`, `lgtm`, `ship it`, …). Stale-plan ping
  after 10 minutes.

### Phase D — Smart pathfinding primitives
- `smartGoTo` — tier-1 default → tier-2 canDig (with auto-equipped
  best pickaxe) → tier-3 canDig + 1x1 towers/bridges.
- `smartGather` — composes find + smartGoTo + collectBlock with tool-tier
  escalation per a block→tool hint table (axes for logs, shovels for
  dirt/sand, the right pickaxe tier for ores including deepslate variants).
- `smartBuildAt` — aggregates material requirements, smartGathers any
  missing, then places.
- `!goToCoordinates` and `!collectBlocks` rebound to the smart versions.

### Phase E + H7 — `stuck` meta-skill
- `PATH_FAILURE_NUDGE` deleted; the tripwire counter now auto-invokes the
  `stuck` meta-skill. Trip 1: re-frame via `!newAction`. Trip 2 on the
  same task: `!cancelTask` + ping the player.

### Phase F — Memory unification + layers
- Legacy `saving_memory` summarizer is dormant — its output no longer
  reaches `$MEMORY`.
- `!remember` content goes through JSON-style escape parsing and
  CRLF/whitespace normalization.
- Summary truncation is now word-boundary aware.
- New layered memory: `memory/server/*.md` (shared across all bots) +
  `memory/players/<player>.md` (per-player). `$MEMORY` concatenates
  server + bot + active-player layers with section headers.

### Phase G — Coordinator
- `!dispatchAgent(role, description, end_factor)` routes focused work to
  a role-specific subagent. Roles: miner / builder / navigator / scout,
  each with its own profile in `profiles/roles/<role>.json` (tight
  system prompt + Sonnet model).
- Per-subagent model routing: `Prompter._modelForActiveTurn()` lazy-
  creates and caches the role's model. `daedelus404.json` also sets
  `code_model: claude-sonnet-4-6` so every `!newAction` already uses
  the action model.
- `!setSubagentSummary` / `!setSubagentResult` let the subagent shape
  its own `[subagent finished]` report.
- `!sendMessage` for fire-and-forget bot-to-bot signaling.

### Phase H — Skill registry
- `/init`, `/review`, `/explore`, `/sleep`, `/restock` player slash
  skills (Bedrock players use `!!` as the alias prefix). Each composes
  the right `!addTask` + `!newAction` chain.
- `stuck`, `loop`, `verify` meta-skills are bot-self-invokable via
  `!invokeSkill`.
- Authorization reuses `settings.only_chat_with` so strangers can't
  dispatch slash skills.

### Phase I — Permissions + MCP server mode
- New `src/agent/permissions.js` enforces per-player allow/deny rules
  with glob patterns. `executeCommand` checks permissions first, before
  the plan-mode gate, so denials short-circuit cleanly.
- `src/mcp_server.js` exposes a curated set of bot tools as MCP tools
  via JSON-RPC 2.0 over HTTP — `say`, `read_stats`, `read_inventory`,
  `read_nearby_blocks`, `mine_block`, `go_to_coords`, `go_to_player`,
  `add_task`, `show_queue`, `invoke_skill`, `dispatch_agent`,
  `run_raw_command`. External agents appear as the synthetic player
  `mcp` for permission purposes.

### What didn't ship
- No tests were added — the user's Anthropic API was rate-limited at
  build time, so live-server verification wasn't possible. Static
  syntax checks (`node --check`) confirm every changed file parses.
- The blueprint's earlier note about deleting the path-failure regex
  classifier itself wasn't taken — the deterministic detector now
  acts as the safety-net trigger for `stuck` instead of being a
  duplicate of the LLM's prompt rules.

## 2026-05-25 — v2 integration shipped + production tuning

Single-session push that took v2 steps 1–6 (standalone modules from
2026-05-20) all the way to live operation on YOON, plus production
tuning discovered during the live smoke. Five commits on `develop`:
`943766e` (integration), `a9a86c0` (chores), `e50544a` (production
tuning), `549ca3d` (UX feedback), and this changelog entry.

### Engine fleet narrowed to Claude

- **DeepSeek-v4-flash via NVIDIA Build dropped as default.** Live smoke
  on 2026-05-25 found that NVIDIA's OpenAI-compat endpoint forwards the
  `tools[]` field but DeepSeek's serving stack ignores it — the model
  returns empty content with no `tool_calls`. The orchestrator parks
  silently and the bot doesn't respond. Verifying this took flipping
  the engine to Claude (which supports `tool_use` natively as an
  Anthropic concept) and watching the orchestrator immediately work.
- **Groq + Cerebras profiles deleted** — fleet is now Claude (default)
  + NVIDIA (fallback, non-tool-use code paths only). Updated
  `bot-engine` script and `settings.js` rate_limit entries accordingly.
- `profiles/daedelus404.json` symlink → `daedelus404.claude.json`
  (Haiku chat + Sonnet code_model).

### v2 orchestrator wired live (`use_tool_use_protocol`,
`use_orchestrator_v2` flipped ON in `settings.js`)

**`agent.js`**
- `_initOrchestratorV2()` constructs `OrchestratorV2` + `BackgroundTasks`
  when both flags are on; warns when only one is set.
- `handleMessage` delegates to `orchestrator.handleEvent({type:
  'user_message'})` when the orchestrator is initialized; legacy
  `for(i<max_responses)` loop stays as the fallback path.
- `_buildSystemPromptForTools()` strips `$COMMAND_DOCS` from the
  conversing template (tools advertised via `tools[]`, not prose).
- `_promptViaModel()` bridges neutral history → provider native shape
  via `neutralToAnthropic` / `neutralToOpenAI`, then calls
  `sendRequestWithTools`.
- Plan-mode 90s hard-cap; plan-mode released on death so recovery
  isn't gated; drive loop nudges the bot when run_queue is idle but a
  task is in_progress; empty-response reissue safety net.

**`models/claude.js` + `gpt.js` + `tool_protocol.js`**
- `sendRequestWithTools` per provider returns normalized
  `{text, toolCalls, stopReason}`.
- `neutralToAnthropic` / `neutralToOpenAI` converters for orchestrator
  history → provider shape.

**`process/init_agent.js`**
- `unhandledRejection` / `uncaughtException` handlers so pathfinder
  async throws stop dying silently; `bot.log` now ends with the stack.

### Bug fixes uncovered during smoke

- **bg_complete event shape**: Anthropic rejects `tool_result` blocks
  whose `tool_use_id` doesn't match a prior `tool_use` in the same
  turn sequence. `bg_complete` arrives long after the originating
  `tool_use` already returned a started-handle response. Reshaped to
  emit a synthetic user-role text turn carrying the bg outcome instead
  of a tool_result block.
- **No-op assistant turn**: when the LLM emits no text AND no
  toolCalls (a parking signal), the orchestrator was still recording an
  assistant turn with empty content. `neutralToAnthropic` then pushed
  an empty text block — Anthropic 400s on replays. Fix: skip recording
  no-op assistant turns entirely in the orchestrator, AND defensively
  skip them in the converter.
- **bg_complete loopback**: `_executeOne` now passes `onComplete` to
  `backgroundTasks.spawn` that re-enters the dispatcher with a
  `bg_complete` event.

### Prompt caching (Anthropic ephemeral)

- `sendRequestWithTools` marks the system prompt + the last tool
  descriptor with `cache_control: { type: 'ephemeral' }`. Two
  breakpoints (well under the 4-breakpoint limit).
- Observed savings: ~70% on system prompt across multi-turn builds.
  Turn 2 `cache_read=13859`; sustained `cache_read=6240–28435` across
  30+ turns within a session. 5-minute TTL.
- **Known not-yet-cached**: `kind=coding` (Sonnet `!newAction`
  generator) still goes through legacy `sendRequest`. Each `!newAction`
  invocation pays ~2.5–3.5K input tokens uncached. Worth fixing
  but lower-impact than the convo_tools path.

### Plan-mode auto-commit (no approval ceremony)

- After `orchestrator.handleEvent`, check if plan-mode was entered
  this turn AND tasks were queued. If so, auto-exit plan-mode and
  auto-start task #1 immediately. Player can interrupt anytime with
  chat; no approval gating.
- 90s hard-cap stays as a safety net for the rare case the LLM enters
  plan mode but emits no tasks.
- Plan-mode supersede path retained: if a player issues a new task
  request mid-plan, the old plan is abandoned and the LLM rebuilds
  from scratch.

### Task-size decomposition gate (3 layers, defense in depth)

Problem: Haiku planner was cramming entire builds ("20×50 floor =
1000 blocks") into single `!newAction` JS double-loops. Fragile
recovery; ignored incremental progress.

**Rule 1 — Pre-plan inbound nudge** (`classify_and_gate.js`):
- `estimateTaskSize(message)` regex-scans for size signals:
  - Dimensions: `NxM`, `N×M`, `N*M`, `NxMxK` (handles `x`, `×`, `*`)
  - Big numerics + material: `\d{2,}\s+\w+` (e.g. "991 cobblestone")
- When ≥ `SIZE_DECOMP_THRESHOLD` (200), `SIZE_DECOMP_NUDGE` injects
  sizing math via `nudgesForUserMessage` before the planner LLM runs:
  *"~1000 blocks (signal: 20×50 = 1000). HARD RULE: max 200 per
  !addTask. Emit ≥5 !addTask calls. Example: 5 row-chunk tasks of 10
  rows × 50 blocks each."*

**Rule 2 — Post-plan thin-decomposition gate** (`agent.js`):
- If exactly 1 task was queued AND the message had a size signal
  ≥ threshold, auto-cancel via `task_queue.cancelTask(badId)` and
  re-prompt the planner with `THIN_DECOMPOSITION_NUDGE`. Stays in
  plan mode so body-touching commands stay blocked during the
  re-decompose turn.

**Rule 3 — `!addTask` structural gate** (`commands/actions.js`):
- The `!addTask` command's `perform` runs `estimateTaskSize` on the
  description itself. Any description ≥ 200 blocks is rejected at the
  command layer, regardless of source (planner, slash skill, reboot
  resume, manual op).
- This caught task #173 ("Mine 991 stone blocks") and task #175
  ("Build 20×50 cobblestone floor") that were already in tasks.json
  from before the fix — both got `cancelled` manually since they
  couldn't be re-queued after the gate.

**Subtask exemption** (`SUBTASK_MARKERS` regex):
- Descriptions containing chunk/row/section/layer/tier/phase markers
  (e.g. *"rows 1-10 of 20×50 floor"*, *"layer 2 of watchtower"*,
  *"chunk 3 of 5"*) pass through. The numeric mentioned is
  parent-context reference, not work-for-this-task.

### Plan-mode classifier split

- `detectTaskRequest` (broad: `MULTI_STEP_VERBS` + `COMPLEXITY_PATTERNS`)
  gates the `!addTask` nudge to encourage queue use even on routine
  multi-step requests.
- `detectPlanRequest` (NEW, explicit `"plan it out" / "step by step" /
  "first … then"` language) is reserved for future use; plan-mode
  auto-entry stays on `detectTaskRequest` because the auto-commit
  ceremony is now lightweight.
- `PLAN_MODE_AUTO_NUDGE` strengthened with quantified rule + worked
  example: *"max ~200 blocks/items per task. A 20×50=1000-block floor
  MUST be at least 5 tasks (e.g. 10-row chunks)."*

### UX feedback features

- **Throttle chat** (`rate_limited_client.js` + `agent.js`):
  module-level `rateLimitEvents` (TinyEmitter) fires `throttle`/`resume`
  events on 429-backoff lifecycle. Agent subscribes once during
  `start()`; posts *"I need to rest for a moment. It'll take less than
  a minute!"* on first throttle of a session, *"Back on it."* on
  resume. 60s debounce so a 429 cluster doesn't spam chat.
- **Task-start chat** (`task_queue.js` + `agent.js`): `task_queue`
  fires a new `'start'` event when a task transitions to in_progress
  (from `addTask` auto-promote, explicit `startTask`, or `finishTask`
  auto-advance). `_onQueueChange` chats *"Starting task #N:
  <description>"* with a 5s debounce. Fixes the "bot looks frozen
  between chunks" UX where a 10–25s gap (Sonnet code-gen + planner
  re-invoke) was silent.

### Memory authority nudge

- `MEMORY_AUTHORITY_NUDGE` fires whenever the player's message
  contains an explicit parameter (size signal != null). Tells the
  planner: *"player message wins over saved memory; if dimensions /
  material / coords conflict, use the new value and !remember to
  overwrite the stale entry."*
- Addresses observed regression where the bot pulled *"20×50 floor"*
  from prior memory while the player had just said *"30×30"*.

### Production smoke results (YOON, 30×30 deepslate floor)

- `[plan mode] auto-commit (5 task(s) queued)` — clean decomposition
  into row chunks of 180 blocks each (well under the 200 threshold).
- Cache: `total_cache_read = 364K tokens` across 60+ turns. Strong
  savings vs uncached baseline.
- Rate limits: 2–3 anthropic 429s during heavy execution, all
  self-recovered via backoff. Haiku 50 RPM ceiling is the limit;
  drive loop + heartbeat + side-chat + planner re-invokes stack fast
  during chunk transitions.
- No `HARD_CAP=12` hits in the production smoke session after the
  fixes (one earlier hit before the bg_complete + empty-turn fixes).
- No `[v2 orch] handleEvent failed` errors after the bug fixes.

### Settings flipped

- `use_tool_use_protocol: true`
- `use_orchestrator_v2: true`
- `use_background_handles: false` (deferred — wiring in place, not
  yet exercised; requires individual skill refits to honor
  AbortSignal)
- `use_subagent_isolation: false` (only tools-filter piece is wired;
  full child-history isolation deferred)

### Known follow-ups (not blocking)

- `kind=coding` (Sonnet code_model) still uncached on
  `claude.js.sendRequest`. Trivial to fix; just add the same
  `cache_control` markers as `sendRequestWithTools`.
- `wipe_memory_on_start: true` blows away every `!remember` call on
  restart. User wants to flip to `false` so memory persists; deferred
  until next planned restart.
- Drive loop interval (10s) could be raised to 30s if 429s become
  chronic; current rate is acceptable.
- Side-chat `_handleSideChat` still uses legacy `promptConvo`
  (`kind=convo input=~11K cache_read=0`). Low impact, but the
  cleanest fix is routing through the orchestrator with a tools_filter
  that strips body-touching commands.

### Memory feedback saved (auto-memory `~/.claude/.../memory/`)

- `feedback_pincercraft_claude_primary` — Claude is default; v2
  orchestrator requires it (DeepSeek silently drops `tools[]`).
- `feedback_pincercraft_no_plan_mode_for_simple` — routine
  gather/craft tasks should just execute; reserve plan-mode for
  genuinely complex builds. (Superseded in practice by the auto-commit
  flow — plan-mode now lightweight enough to fire on any multi-step.)
- `feedback_pincercraft_task_size_gate` — three-layer enforcement
  (pre-plan, thin-decomp, !addTask gate). Subtask markers exempt.
- `feedback_bot_dev_target_yoon` — bot dev/smoke runs against YOON
  :25565, not PT. PT retired as dev target 2026-05-25.

## 2026-05-25 — finishTask observability (task-186)

**Change.** `!finishTask` now logs one line at the finish boundary
recording how the end_factor was checked:
`[finishTask] #ID end_factor "..." — verified (item=NN)` when the
criterion was programmatically confirmed, or `— honor-system
(unmeasurable end_factor)` when it passed through unparsed.
`verifyEndFactor` was enriched to return the observed inventory count
(`observed`) on its verified-true paths so the log can carry it.

**Hypothesis (task-186 diagnosis).** The run was healthy — 2 turns,
`outcome=done`, no errors — but with `block_ops=0` a legitimate
early-out (≥32 cobblestone already in inventory) is indistinguishable
in the log from a false-done like task-185. No functional fix was
warranted; the only gap was observability. This is the diagnosis's
minimal suggestion: record the verifying count so the loop can tell the
two apart. (For task-186's exact phrasing the line reads `honor-system
(unmeasurable end_factor)` — itself the key signal that the done was
not programmatically gated.)

**Metric.** Moves nothing on cost/efficiency by design (pure log). It
makes 0-ops `done` outcomes auditable going forward — the residual risk
the diagnosis flagged.

## 2026-05-25 — surface mining API for gather tasks (task-188)

**Change.** `SkillLibrary.getRelevantSkillDocs` now injects the
`skills.mineBlockAt` and `skills.collectBlock` docs into the selected
set whenever the code-task text contains a resource-gathering verb
(chop/mine/break/collect/gather/harvest/dig). Docs are matched on their
first line (`startsWith(name + '\n')`) rather than a loose `includes`,
because `breakBlockAt`'s docstring cross-references `skills.mineBlockAt`
and would otherwise be returned in its place.

**Hypothesis (task-188 diagnosis).** Over 43 turns the bot broke zero
blocks (`block_ops=0`, `outcome=timeout`): the skill-doc selector only
ever surfaced the static `placeBlock/wait/breakBlockAt` set, so with no
correct mining signature in context the coder hallucinated
`skills.mineBlock` and passed `oakLog.x` instead of `oakLog.position.x`.
`mineBlockAt`'s existing docstring already names the right function and
shows the `.position.x` arg shape — it simply was never retrieved.
Surfacing it for gather tasks should stop both errors.

**Metric.** Targets `block_ops` (0 → ≥5) and `tokens_per_block_op`
(`null` → finite), flipping the gather-task outcome from timeout to
success. Verify: re-run a chop/mine task and confirm `Selected skill
docs` now lists `skills.mineBlockAt`/`skills.collectBlock` and that a
break/collect lands (`block_ops > 0`).

## 2026-05-26 — verify delta-style "fresh production" end_factors (task-189)

**Change.** `verifyEndFactor` now recognizes delta-phrased gather
criteria — `"<item> count has increased by at least N"`, `"≥N new
<item> mined and collected this run"` — via a new `matchCountIncrease`
parser, and checks them against an inventory snapshot taken at task
start. A new exported `snapshotStartCounts(agent, task)` records the
baseline count for such criteria; `agent._onQueueChange` calls it on the
queue `start` event. At `!finishTask`, the gain must be `≥ N` since the
task started, or the finish is blocked. Absolute counts, multi-item, and
fuzzy criteria are unchanged.

**Hypothesis (task-189 diagnosis).** #189 ("mine ≥10 NEW cobblestone
THIS run") closed `done` with every work counter at zero — a false done.
Its end_factor "cobblestone count has increased by at least 10" is a
textbook inventory-delta check, but the verifier had no parser for the
"increased by" shape and fell back to honor-system, so a 0-op completion
sailed through. The diagnosis also asked to "reject any honor-system
done when `block_ops == 0`"; `block_ops` is a post-hoc metric computed by
`eval/metrics.mjs` from `bot.log`, not a runtime counter, so the
delta-vs-snapshot check is the runtime mechanism that captures the same
"no real work happened" signal — when nothing was mined, the gain is 0
and the finish is blocked. The snapshot (vs. an absolute check) is what
makes "NEW this run" correct: a bot already holding ≥10 cobblestone can
no longer pass by mining nothing.

**Metric.** Eliminate `outcome=done` with `block_ops=0` (false-done
rate) for gather/mine tasks; secondarily restore a non-null
`tokens_per_block_op` once real mining occurs. Verify: re-run #189 — with
no mining, `!finishTask` returns `[verify] … not met — cobblestone rose
by 0 this task … need +10` instead of a honor-system done; with ≥10
mined, it logs `verified (cobblestone+N)`.

## 2026-05-26 — Checkpoint: self-improvement loop operational + reliability fixes

Consolidation checkpoint after 6 self-improvement cycles: the reconnect/coder
fixes that unblocked live runs, the eval-DB logging repair + history backfill,
and the conduct/prompt rules tuned from a live play session.

### Reliability — the bot now joins and codes reliably under v2
- **IPv4 Mojang session-join (`5be4026`).** This host advertises IPv6 for
  `sessionserver.mojang.com` but has no working v6 route; under the full bot's
  event-loop pressure Node's happy-eyeballs mishandled the dead-v6 race and the
  session join died with a bare `ETIMEDOUT`. Fix: pass `https.Agent({family:4})`
  through `createBot` → minecraft-protocol's yggdrasil join. Scoped to Mojang
  HTTP only (the local MC socket is separate raw TCP).
- **`code_task_content` under OrchestratorV2 (`d3ef9e1`).** v2 generates code
  via its own channel, not the legacy `!newAction(...)` string, so the RAG
  doc-selector was fed an empty task string and surfaced the same three docs
  279/279 times. Now falls back to the active task's description when no
  `!newAction(` capture exists — gather tasks correctly surface
  `mineBlockAt`/`collectBlock`.

### Eval harness — logging fixed, history backfilled
- **`task_attempts` logging repaired.** `eval/eval_db.py` had drifted to a
  positional 13-value INSERT against a 16-column table, so every cycle from 2
  on silently failed to log. Rewrote the schema to 16 columns and the insert to
  **named columns** so it survives future drift (the same pattern that kept
  `log_gate` working).
- **Schema fork resolved — "eval/ wins."** The DB shared by the loop (`eval/`)
  and the hardened layer (`evals/`) carried CHECK enums the loop's free-form
  values (`explore`, `cancelled`) couldn't satisfy. Dropped the `task_attempts`
  enum CHECKs in both the live DB and `evals/__init__.sql` (vocab is now
  convention, enforced in `evals/checks.py`/`task_battery.py`); kept the
  `gate_decisions.decision` CHECK. `evals/` pytest suite stays green.
- **Backfilled cycles 1–6** (task_ids 185–190) into `task_attempts` from
  `metrics.jsonl` + the diagnosis trailers, with per-row commit hashes
  correlated to each attempt's timestamp.
- **Loop agents moved off the metered API.** `eval/loop.sh` now `unset`s
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, so the task-giver, analyzer, and
  improver run on the Claude CLI subscription. The in-world bot still uses the
  API key (Mindcraft SDK, not the CLI).

### Conduct + prompt rules — tuned from a live session
- **Base protection (`CLAUDE.md`).** New rule: never break beds, chests,
  fences, or any block that's part of a build — including the owner's base — and
  never dig or path through base blocks to finish a task. Re-read into `$COC`
  every turn.
- **Inventory-aware behavior (`profiles/defaults/_default.json`).** A live
  session showed the bot over-gathering (it had the 3 iron the task wanted but
  kept mining) and claiming deliveries it never verified. The conversing prompt
  now (a) `!finishTask` immediately when the live inventory already shows the
  end_factor met — never gather/mine/craft more than needed; (b) for
  give/deliver tasks, confirm the item leaves inventory before claiming it,
  replacing the old "trust `!givePlayer` fire-and-forget" line.

### State of the art
Five structural features now operational (see README): **prioritized queue +
Plan Mode** · **live in-world Code of Conduct + layered memory** · **closed-loop
DB-backed self-improvement** · **deterministic anti-spec-gaming eval layer** ·
**discovery-first agentic executor**. Baseline ~45% success; the human-gated
loop drives it down one approved patch at a time.
