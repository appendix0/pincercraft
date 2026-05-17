# PincerCraft — Agent Blueprint

> Status: draft, 2026-05-17.
> Scope: the Daedelus404 bot's evolution toward a Claude-Code-style agent.
> Companion: [`queue-design.md`](./queue-design.md) covers the action-queue layer this builds on.

---

## 1. Why this exists

The bot has the *parts* of a Claude-Code-style agent — `CLAUDE.md`, `MEMORY.md`, a task queue with end factors, a code-generation escape hatch (`!newAction`) — but uses them with the wrong loop shape. The LLM is invoked **per-primitive** (`!goToCoordinates`, `!digDown`, `!moveAway`, …) instead of **per-unit-of-work**. Every pathfinding obstacle becomes a multi-turn LLM negotiation, burning tokens and producing visible thrash.

On 2026-05-17, task #10 ("find diamond_ore deep underground") burned roughly 10 LLM turns chaining `!goToCoordinates → !digDown → !moveAway → !goToSurface → !goToCoordinates`, made zero forward progress, and was killed manually. That session crystallized the diagnosis: this is an architecture problem, not a prompt-polish problem.

This blueprint lays out the fix.

## 2. The framework — the orchestrator is the thing

The central insight, validated against Claude Code's [leaked source structure](https://github.com/codeaashu/claude-code) (`src/QueryEngine.ts`): **everything good about an agent comes from a clean orchestrator loop tying a smart planner to dumb-but-reliable tools.** Claude Code calls this the QueryEngine; we should call ours the same thing in spirit. The loop:

```
player input
   │
   ▼
┌─────────────────────────────────────────────────────────┐
│  Orchestrator (per-turn loop)                            │
│  - stream LLM response                                   │
│  - parse tool calls                                      │
│  - check permissions, classify intent                    │
│  - execute tool → terminal result                        │
│  - feed result back as system message                    │
│  - retry on transient, escalate on persistent failure    │
│  - track tokens/cost, manage context window              │
└─────────────────────────────────────────────────────────┘
   │
   ▼
tool returns terminal result → next loop iteration
```

The user-visible "smartness" of Claude Code is 20% the model and 80% this loop being well-shaped. Our bot has the LLM half but the loop is malformed — tools return partial states, so the LLM gets pulled into per-step micromanagement.

**This is the framework we are building.** Phases 1 and 2 below are not "improvements" — they are the framework itself. Everything in Phases 3-6 hangs off this.

## 2.5 The mental model

Claude Code feels smart because **its tools complete units of work**:

| Claude Code tool | Unit of work | What the LLM does |
|---|---|---|
| `Bash` | runs a whole shell command, returns stdout/stderr | decides which command to run |
| `Edit` | makes a complete change to a file | decides what to change |
| `Read` | returns the whole file (or a range) | decides which file |
| `Grep` | searches and returns matches | decides the query |
| `Task` | dispatches a subagent that runs to completion | decides the prompt |

The model spends turns **deciding**, not **stepping**. Errors come back as terminal failures the model can reason about and re-dispatch — not as half-progress states that require continuous nudging.

The bot needs the same shape. Our `!newAction(prompt)` command is the closest analog to `Bash`: it invokes the Coder subsystem, which generates a JS routine that runs to completion (with internal self-correction on errors). The problem is that the system prompt only points the LLM at `!newAction` for "complicated structures" (build a house, build a tower). For navigation, gathering, and obstacle traversal, the LLM is told to chain primitives — which is the wrong shape.

## 3. The mapping

| Claude Code | Bot equivalent (today) | Gap |
|---|---|---|
| `Bash` (runs to completion) | `!newAction(prompt)` via Coder | Underused — prompt doesn't promote it for navigation/gathering |
| `Edit` / `Write` | primitive commands (`!collectBlocks`, `!craftRecipe`) | Too low-level — no auto-retry, return after one attempt |
| `Read` / `Grep` | `!nearbyBlocks`, `!entities`, `!stats`, `!inventory` | OK as-is |
| `CLAUDE.md` (system rules) | `CLAUDE.md` + `$COC` token re-read every prompt | ✅ (instant via file watch — see §6.1) |
| `/memory` (MEMORY.md + topic files) | `MemoryStore` (`MEMORY.md` + slug `.md` files) | ✅ structure mirrors Claude Code; legacy `saving_memory` summarizer duplicates it (see §6.3) |
| `TodoWrite` | `TaskQueue` with required `end_factor` | ✅ |
| `Task` tool (subagents) | — | Missing — see Phase G |
| Skills (`/init`, `/review`) | — | Missing — see Phase H |
| Auto-compaction of history | — | Missing (cross-cutting) |
| `EnterPlanModeTool` / `ExitPlanModeTool` | — | Missing — see Phase C |
| Tool metadata (`isReadOnly`, `isConcurrencySafe`, per-tool `prompt()`) | command name + params + perform | Missing — see Phase B |
| Coordinator (`TeamCreate`, `SendMessage`, multi-agent) | — | Missing — see Phase G |
| Skill registry (`/skills` + `remember`, `loop`, `stuck`) | informal | Missing — see Phase H |
| Permission System (per-tool gating) | informal (only_chat_with) | Missing — see Phase I |
| MCP server mode (expose tools to other agents) | — | Missing — see Phase I |

## 4. The plan — hybrid order: Phase 1 ROI-first, then foundations-first

**Decision (2026-05-17):** Phase 1 ships immediately as a small ROI-first patch because the bot is burning tokens *now* on per-step thrash. Once Phase 1 stops the bleeding, everything else is built foundations-first so each piece lands on the proper orchestrator contract instead of being retrofitted later.

```
Phase 1  Stop the burn (today, ROI-first)              ← prompt + path-failure classifier
─────────────── switch to foundations-first ───────────────
Phase A  Orchestrator contract                          ← multi-command parsing, retry, tracking
Phase B  Tool metadata standardization                  ← isReadOnly, isConcurrencySafe, prompt()
Phase C  Plan Mode (queue + planning live alive)        ← !enterPlanMode/!exitPlanMode
Phase D  Smart tools (smartGoTo, smartGather)           ← built on B's contract
Phase E  `stuck` meta-skill                             ← replaces Phase 1's Lever-2 classifier
Phase F  Memory unification + layered hierarchy
Phase G  Coordinator (subagents + SendMessage)
Phase H  Skill registry (slash skills + meta-skills)
Phase I  Permissions + MCP server mode
```

The Lever-2 path-failure classifier from Phase 1 is *deliberate throwaway code* — it gets deleted when Phase E lands the proper `stuck` meta-skill. ~30 lines, worth it to stop the burn today.

### Phase 1 — Stop the per-step burn (SHIPPED 2026-05-17)

**Goal:** end the pathfinding thrash. One-shot fix for the diagnosed bug.

- **1a. Prompt promotion of `!newAction`.** Rewrite the queue/action rules in `profiles/defaults/_default.json` so `!newAction(prompt)` is the **default executor** for any multi-step physical task — navigation with expected obstacles, gathering across distance, building, complex mining. Demote primitive commands to "one-shot operations where no obstacle is expected."
- **1b. Path-failure classifier.** Same Lever-2 pattern as the existing task/memory triggers. In `agent.js`, count consecutive system messages containing `Path not found` / `Unable to reach` / `Cannot break ... with current tools` / `Pathfinding stopped`. After two in a row on the same task, inject a system note before the next LLM turn:
  > `[pathfinding stuck — 2 consecutive failures] Your next action MUST be !newAction(...) with a multi-step plan that handles the obstacle (dig stairs, bridge water, tower up), OR !cancelTask + tell the player you're stuck.`

**Decision point after Phase 1:** if Haiku still micro-steps despite the prompt + classifier, the answer is "Haiku is not smart enough to be the planner — use Sonnet." Skip ahead to Phase G (Coordinator with model routing). Don't keep polishing Haiku's discipline.

---

## After Phase 1: foundations-first order

The phases below are renumbered A–I. Each phase explicitly states what foundation it relies on, so the dependency chain is visible.

### Phase A — Orchestrator contract

**Goal:** the central loop in `agent.js` (`_processInput` + `_runWorker`) satisfies the 9-point contract in §6.5 below. This is the bedrock everything else lands on.

- **A1. Multi-command parsing.** Today `parseCommandMessage` returns the first command and drops the rest. Bot responses like `!stop\n\n!remember(...)` lose the `!remember`. Upgrade to parse N tool calls per response.
- **A2. Per-command retry policy.** For transient failures (network blip, momentary chunk unload), retry with backoff before reporting to the LLM. Terminal failures pass through.
- **A3. Token + cost telemetry.** Log tokens-per-turn and per-task to `queue.log`. Surfaces which tasks burn.
- **A4. Context auto-compaction.** When prompt exceeds 8K tokens, summarize turns >30 min old into a single system message. Mirrors Claude Code's `/compact`.
- **A5. Centralized classify+gate step.** Today `SIDE_CHAT_SAFE_COMMANDS`, interrupt classifier, task/memory triggers all live as scattered checks. Pull them into one `classifyAndGate(input, response)` function that produces a single decision: execute / block / nudge / interrupt.

### Phase B — Tool metadata standardization

**Goal:** mirror Claude Code's tool definition pattern. Each command in `commands/actions.js` gets the metadata the orchestrator (Phase A) and downstream subsystems (Plan Mode, Permissions) need.

- **B1.** `isReadOnly: (args) => boolean` — non-destructive (`!inventory`, `!nearbyBlocks`, `!getCraftingPlan`). Read-only tools are always allowed in plan mode, never need permission gating.
- **B2.** `isConcurrencySafe: (args) => boolean` — can run in parallel with the current body action. Today informally captured by `SIDE_CHAT_SAFE_COMMANDS`; promote to per-tool flag.
- **B3.** `prompt(ctx)` — optional per-tool system prompt contribution. Today all command docs concatenate into `$COMMAND_DOCS`; per-tool ownership lets a tool turn itself on/off based on context (e.g. don't advertise `!sleep` during the day).
- **B4.** `checkPermissions(args, ctx)` — hook the permission rules from Phase I in advance.

### Phase C — Plan Mode (queue + planning live alive)

**Depends on:** B (needs `isReadOnly` to know what to block).

**Goal:** make planning a first-class subsystem the player can see and interact with, exactly like Claude Code's `EnterPlanModeTool` / `ExitPlanModeTool`.

When the bot enters plan mode, it can propose a plan but cannot execute non-read-only tools. Memory writes, queue mutations, and observation tools (`!inventory`, `!nearbyBlocks`, `!getCraftingPlan`, `!showQueue`) all still work. The bot lays out the full task chain via `!addTask` calls, posts the plan in chat, and waits for the player to approve.

- **C1.** New commands `!enterPlanMode` and `!exitPlanMode`. While in plan mode, attempting a non-read-only command returns `"In plan mode — execute blocked. Post the plan in chat and wait for approval."` back to the LLM.
- **C2.** Auto-trigger: when the task-request classifier fires (player asks for a multi-step thing), the orchestrator auto-enters plan mode. The LLM plans via `!addTask`, posts the plan, the player says "yes" → bot auto-exits plan mode → first task auto-starts.
- **C3.** Plan mode is visible. Chat prefix changes: `[planning] Plan: 1) … 2) … 3) … (say ok to start)`. After approval: `[executing] Starting task #1: mine 5 iron_ore.`
- **C4.** TaskQueue + Plan Mode together = the planning subsystem. TaskQueue is the *what*; Plan Mode is the *when does it start*.

### Phase D — Smart tools

**Goal:** make primitives Bash-tool-quality. Each command completes a unit of work, retries internally, returns terminal success/fail.

- **2a. `smartGoTo(bot, x, y, z)` in `src/agent/library/skills.js`** — tries Mineflayer pathfinder with progressively aggressive `Movements`:
  1. Default (no dig, no place)
  2. `canDig=true` if a pickaxe is in inventory (and choose the right tier)
  3. `canPlace=true` with dirt/cobblestone for bridging
  4. Escalate to a generated `!newAction`-equivalent code routine if all of the above fail
  Returns terminal success/fail with explanatory message.
- **2b. `smartGather(bot, item, count)`** — composes `findBlock + smartGoTo + collectBlock`, retries each step, returns terminal.
- **2c. `smartBuildAt(bot, position, template)`** — handles auto-leveling, block-replacement, missing-material errors.
- **2d. Rebind primitives.** `!goToCoordinates` and `!collectBlocks` point at the smart versions. Keep the originals as low-level fallbacks but hide them from the prompt.
- **2e. Audit Mineflayer `Movements` config.** Currently too conservative for an agent with a pickaxe. With a stone-pickaxe or better in inventory, `canDig` should be enabled for stone-family blocks. With dirt/cobblestone in inventory, `canPlace` for bridging.

After Phase D: the LLM almost never needs to micromanage physical execution. Same shape as Claude Code's `Bash` being smart enough that you rarely need to chain commands manually.

### Phase E — `stuck` meta-skill (replaces Phase 1's classifier)

**Depends on:** B (tool metadata + `prompt()`), H (skill registry — but `stuck` can ship as a precursor).

**Goal:** replace the Lever-2 path-failure classifier with a proper meta-skill, mirroring Claude Code's `stuck` skill. When the bot detects it's making no progress, it invokes `!invokeSkill("stuck")` which dispatches a curated escalation script: try `!newAction` with a different framing → fall back to `!cancelTask` + ask player.

When this lands, the Phase 1 classifier in `agent.js` (`PATH_FAILURE_PATTERNS`, `_consecutivePathFailures`) gets deleted — `stuck` covers it more generally.

### Phase F — Memory unification

**Goal:** one source of truth for `$MEMORY`. Stop the cross-contamination.

- **3a. Kill the legacy `saving_memory` summarizer**, or scope its output to a separate "session log" that does not feed `$MEMORY`. Today it duplicates `MemoryStore` and the summarizer LLM pollutes the memory field with current task state (which the prompt explicitly forbids — but the LLM ignores).
- **3b. Fix `!remember` arg parsing.** `src/agent/commands/index.js:121` strips outer quotes but does not interpret `\n`/`\t` escapes. The LLM emits `"...water.\\n\\nLosPollos929..."` as a JSON-style literal; we store it as literal backslash-n. Parse escape sequences.
- **3c. Normalize topic content.** Auto-trim trailing whitespace, normalize line endings, cap summary lines at word boundaries (currently truncates mid-word at 120 chars).
- **3d. Layered memory hierarchy** (mirrors Claude Code's project + user + extracted + team layers):
  - `CLAUDE.md` at repo root = **server-wide rules** (live, lectern-editable)
  - `bots/<name>/memory/MEMORY.md` + slugs = **bot-specific facts** (today)
  - **New:** `memory/server/*.md` = **shared facts across all bots** on the server (base coords, ally list, no-mine zones)
  - **New:** `memory/players/<player>.md` = **per-player preferences, history, do-not-do list** (e.g. `LosPollos929.md` accumulates "avoid water", "diamond > iron preference", "asleep nightly 22:00–06:00")

  Each layer loaded into `$MEMORY` with clear section headers so the LLM knows which it's reading.

### Phase G — Coordinator (subagents + inter-bot messaging)

**Goal:** Claude Code's `Task` tool, for the bot. Delegate complex tasks to focused agents on a stronger model.

- **4a.** New command `!dispatchAgent(role, task_description, end_factor)` — spawns a subagent process that gets exclusive control of the bot's body for the task duration. Returns a summary on completion or stuck-state.
- **4b. Roles:** `navigator`, `miner`, `builder`, `scout`. Each role has its own focused system prompt — no memory rules, no chat rules, just "do this physical task well." Tighter prompt = better instruction-following on smaller context.
- **4c. Model routing:**
  ```
  model_for_planner: claude-haiku-4-5     # cheap conversational planning
  model_for_action:  claude-sonnet-4-6    # smarter execution + Coder routines
  ```
  Configurable per role.
- **4d. Result protocol.** Subagent reports back via `[subagent finished] role=miner result=success summary="Got 5 diamonds, no casualties, returned to spawn"` system message. Planner integrates into the queue (`!finishTask` etc.).
- **4e. SendMessage between bots.** Mirroring Claude Code's `SendMessageTool` / `TeamCreate` — if a second bot is on the server (e.g. a builder partner), they can coordinate without going through the player. `!sendMessage(targetBot, content)` + receiving bot gets it as a `[message from <bot>]` system event.

### Phase H — Skill registry (slash skills + meta-skills)

**Goal:** Claude Code's `/init`, `/review`, `/explore` — but in chat.

Each player-typed `/command` is a small wrapper that builds the right `!addTask` + `!newAction` chain. Examples:

- `/init` — bot surveys spawn area, saves biome / landmarks / important coordinates to memory
- `/review` — bot reports current base safety + inventory + outstanding tasks + recent activity
- `/explore <radius>` — structured exploration with running notes saved to memory
- `/sleep` — auto-bed routine when night falls
- `/restock <item>` — top up an item to a target quantity

Implementation: in-game chat handler in `agent.js` recognizes `/` prefix from authorized players, dispatches to a `slash_skills.js` registry. Each skill is a small JS function that knows the right task decomposition.

**Meta-skills** (Claude Code's `loop`, `stuck`, `verify`, `simplify` analogs — invokable by the bot itself, not just players):
- `stuck` — when the path-failure classifier fires, the bot can `!invokeSkill("stuck")` to get a curated escalation script (try newAction → cancelTask → ask player). Replaces ad-hoc Lever-2 nudges with a proper skill.
- `loop` — for iterative tasks like "keep mining iron until you have 64." Skill manages the outer loop, queue handles each iteration.
- `verify` — re-checks an end_factor before `!finishTask` (was inventory actually updated? is the block actually placed?). Closes the LLM-honor-system loophole in the queue.

### Phase I — Permissions + MCP server mode

**Goal:** make the bot a citizen of the broader agent ecosystem. Mirrors Claude Code's Permission System + MCP-server-mode entrypoint.

- **6a. Permission System.** Per-tool permission rules with allowlist/blocklist by player. Today `only_chat_with` is a single coarse list; Claude Code gates *each tool* with rules like `Bash(git *)`. We'd want: `LosPollos929` can use everything; trusted allies can use `!give*`/`!showQueue`/`!setMode`; strangers can chat but can't queue tasks. Lives in `settings.js` `permissions` map.
- **6b. MCP server mode.** Run the bot as an MCP server. External agents (a Claude Code session on the laptop, another AI on the network) can connect and call the bot's tools — `mine_block(type, count)`, `go_to_player(name)`, `read_inventory()`, etc. Useful for: orchestrating from outside the game, building dashboards, automation scripts. Claude Code already has `src/entrypoints/mcp.ts` as the pattern. Ours would live at `src/mcp_server.js` exposing the existing skills as MCP tools.

## 5. Cross-cutting upgrades

These can ship in any phase, low effort each:

- **History compaction.** When the prompt grows past ~8K tokens, auto-summarize turns older than 30 min into a single system message. Mirrors Claude Code's auto-compact.
- **Cost telemetry.** Log tokens-per-task to `queue.log` so we can see which tasks burn.
- **Sonnet for the Coder.** Even before full subagents, route `!newAction`'s internal Coder calls to Sonnet. Better JS = fewer Coder iterations = faster + cheaper overall.
- **Inventory-aware tool selection.** Auto-equip the right tool before mining (already partially done by Mindcraft).

## 6. What's already shipped (2026-05-17 session)

These are the pre-Phase-1 ground-clearing changes that landed in the same session as this blueprint:

### 6.1 CLAUDE.md as the COC

- Renamed `coc.md` → `CLAUDE.md` (matches Claude Code mental model).
- `prompter.js` re-reads `CLAUDE.md` on every prompt build → any disk edit is **instantly** reflected next turn.
- **Lectern auto-watcher** (`src/agent/rulebook_lectern.js`): `!designateRulebookLectern` saves the lectern coords to `bots/<name>/rulebook_lectern.json`; bot installs a `blockUpdate` listener on those coords; when `has_book` flips false→true (player takes book off, edits, places back) we debounce 1.5s then re-read the book and overwrite `CLAUDE.md`. Constraint: lectern's chunk must stay loaded — patrol range, spawn chunks, or `forceload add`.

### 6.2 MemoryStore (MEMORY.md mirror)

- `src/agent/memory_store.js` provides `MEMORY.md` index + per-topic slug `.md` files at `bots/<name>/memory/`.
- Caps: 30 topics, 4 KB each, 200-line index, 120-char summary.
- Commands: `!remember`, `!recall`, `!forget`, `!listMemory`.
- Layout matches Claude Code's auto-memory exactly (`~/.claude/projects/.../memory/`).

### 6.3 Bug fixes — interrupt and side-chat

These bugs were silently breaking memory writes and stop commands while the bot was busy:

- **Interrupt classifier** (`src/agent/input_router.js`): "stop", "stop everything", "halt", "abort", "cancel", "pause", "wait", "nevermind", "hold on" all classify as `interrupt` now (word-boundary so "stopped by the lake" doesn't fire). Previously only literal `!stop` worked, so "stop everything" was processed as a normal side-chat reply and the bot kept grinding.
- **Side-chat safe-command whitelist** (`agent.js` `_handleSideChat`): when a player chats mid-task, the bot now executes a curated set of commands that don't touch the body — `!remember`, `!rememberHere`, `!forget`, `!recall`, `!listMemory`, `!addTask`, `!cancelTask`, `!showQueue`, `!clearDoneTasks`, `!setMode`, `!loadCOCFromLectern`, `!designateRulebookLectern`. Body-touching commands (`!goToPlayer`, `!attack`, etc.) still get blocked from hijacking the running task. Previously **all** commands were stripped, so `!remember` and `!stop` were silently dropped while the bot was busy.

### 6.4 Lever-2 trigger classifiers

The pattern: a deterministic regex in `agent.js` `_processInput` injects a pre-response system note when the player message matches a known intent, re-asserting the relevant prompt rule the LLM might otherwise drop.

- **Task-request classifier:** imperative verbs (`mine|craft|build|make|get|bring|fetch|give|smelt|gather|find|collect|hand|deliver|cook|grab|harvest|chop|dig`) → nudge: "your first action MUST be one or more `!addTask` calls, including the final tell-the-player step."
- **Memory-cue classifier:** memory phrases (`remember|don't forget|note that|save this/that|from now on|always|never|keep in mind|my name is|i (like|prefer|hate|live|work)`) → nudge: "call `!remember(topic, content)` — don't skip this."

These are safety nets, not replacements for prompt rules. The prompt covers the smart path; the classifier covers Haiku's misses.

## 6.5 The orchestrator contract

After Phases 1-2 land, our orchestrator loop in `agent.js` `_processInput` + `_runWorker` should satisfy this contract — same shape as Claude Code's QueryEngine:

1. **Stream the LLM response** — already done via the Anthropic SDK.
2. **Parse tool calls** — already done via `containsCommand` + `parseCommandMessage`. Needs upgrade: parse multiple commands per response (today drops everything after the first).
3. **Check permissions and intent classification** — partially done (`SIDE_CHAT_SAFE_COMMANDS`, interrupt classifier, task/memory triggers). Need to centralize into a single `classifyAndGate(input, response)` step.
4. **Execute the tool to a terminal result** — done for most commands; Phase D makes the *result* actually terminal instead of partial.
5. **Feed the result back as a system message** — already done via `this.history.add('system', execute_res)`.
6. **Retry on transient failures** — partial (Coder retries internally on `!newAction`). Need: command-level retry policy for primitives that hit "network blip" type failures.
7. **Escalate on persistent failures** — Phase 1b path-failure classifier covers pathfinding (shipped); Phase E `stuck` skill generalizes it and replaces the classifier.
8. **Track tokens/cost per turn** — cost-telemetry cross-cutting upgrade in §5.
9. **Manage context window** — auto-compaction cross-cutting upgrade in §5.

When all nine are in place, the bot's orchestrator IS a QueryEngine, just specialized for Minecraft's tools instead of file/shell tools.

## 7. Success criteria per phase

| Phase | Pass criterion |
|---|---|
| 1 | One run of "go get me 5 diamonds" produces ≤2 LLM turns before `!newAction` dispatch; total turn count ≤8 to completion (down from 10+ to *zero progress*) |
| A | Orchestrator loop satisfies the 9-point contract in §6.5; multi-command-per-response works; auto-compaction triggers at 8K tokens |
| B | Every command in `actions.js` has `isReadOnly` + `isConcurrencySafe` declared. `SIDE_CHAT_SAFE_COMMANDS` deleted (replaced by the per-tool flag) |
| C | `!enterPlanMode` blocks body-touching tools; player approves plan in chat → `!exitPlanMode` → execution begins. Bot never starts work the player hasn't OK'd in plan-mode flows |
| D | Same diamond task as Phase 1: 0–1 LLM turns on navigation. `smartGoTo` handles its own bridging/digging in 90%+ of common cases |
| E | Phase 1's Lever-2 path-failure classifier deleted; the `stuck` meta-skill covers the same recovery paths and more |
| F | `MEMORY.md` contains no task-state pollution after a 1-hour session; `!remember` produces clean text (no `\n` literals); server / bot / player memory layers loaded with section headers |
| G | `!dispatchAgent("miner", "get 5 diamonds")` runs end-to-end with the planner LLM only invoked twice (dispatch + integrate result) |
| H | Player types `/init` in chat → bot autonomously surveys + memorizes spawn area in <2 minutes |
| I | External Claude Code session connects to bot via MCP, calls `mine_block("iron_ore", 5)` from outside the game, gets terminal success. Permission rules block strangers from `!addTask` |

## 8. Open questions

- **Coder model.** Does `!newAction` use the same model as the planner, or can we route it independently? (Phase G wants Sonnet for execution but Haiku for planning — needs verifying that the Coder respects per-call model selection.)
- **Subagent state isolation.** When a subagent finishes, what state does the planner inherit? (Inventory snapshot, position, last action — needs a `[subagent finished]` system message schema.)
- **Bedrock chat ergonomics.** Slash-skills in §5 assume the player can type `/init` in chat. Bedrock's `/` is reserved for vanilla commands — will need a different prefix or whisper-only handling.
- **Multi-command per response.** Claude Code parses N tool calls per LLM turn (parallel-safe ones run concurrently). Today our parser takes only the first match and drops the rest, which is why `!stop\n\n!remember(...)` only ever stops. Fixed in Phase A1; concurrency control falls out of Phase B's `isConcurrencySafe`.
- **Plan-mode auto-approval timeouts.** If the bot enters plan mode and the player doesn't reply, does it sit forever, abort after N minutes, or auto-execute? Probably abort + ping. Needs a UX decision.

## 9. Related docs

- [`queue-design.md`](./queue-design.md) — action queue + priority design (Phase 1 underlying primitive)
- `../CLAUDE.md` — the live code of conduct (rebuilt by the lectern watcher)
- `bots/Daedelus404/memory/MEMORY.md` — the live memory index
- Memory: `project_pincercraft_bot_plan` (the pointer in the user's auto-memory)
- Reference: [codeaashu/claude-code](https://github.com/codeaashu/claude-code) — leaked Claude Code source; used at the architecture/pattern level only (QueryEngine loop shape, tool metadata contract, task vs queue distinction, skill registry pattern, plan mode, MCP server mode). No implementation copied.
