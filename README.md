<h1 align="center">PincerCraft</h1>

<p align="center">
  <img src="banner.webp" alt="PincerCraft — an AI agent that plays Minecraft with the discipline of Claude Code" width="640">
</p>

<p align="center">A Mindcraft fork with a <strong>deterministic harness under the LLM</strong>: the bot can't guess its inventory, can't fake a finished task, and improves itself on a measured loop.</p>

<p align="center">
  <a href="https://github.com/kolbytn/mindcraft">Upstream Mindcraft</a> ·
  <a href="https://docs.openclaw.ai/concepts/agent-loop">OpenClaw (inspiration)</a>
</p>

---

Stock Mindcraft wires an LLM straight into Minecraft: one chat message in, one command out. The model eyeballs its own inventory, "remembers" tools it isn't holding, declares tasks done it never finished, and re-prompts itself into token-burn loops.

**PincerCraft draws one hard line: code owns the facts and the reflexes; the LLM owns only the plan and the judgment.** Inventory counts, *"can I mine this,"* the recipe gap, *"is this task actually done"* — computed in code every turn and handed to the model, never guessed. Around that sits an event-driven orchestrator that **parks** instead of bursting, and a closed-loop evaluator that grades the bot from world state and patches its own source on a branch for your review.

The payoff: an agent that **can't lie to itself** about what it holds or what it's finished — and that gets **measurably better** over time.

## What PincerCraft adds to Mindcraft

Six structural additions, in order of how much they matter.

### 1. A deterministic harness under the LLM — *the moat*

A layer of code answers every question of *fact* so the model never gets to guess one. This is the thing no other Mindcraft fork has.

- **Proprioception** (`src/agent/live_state.js`). Every turn, a `LIVE STATE` block is rebuilt from a single fresh inventory snapshot — health, position, inventory (used/36 slots), what's nearby, the craft gap for the current goal, and an authoritative `have / need` count. Because it's recomputed each turn it **can never go stale**, and it lives in the *uncached* half of the prompt so live state never busts the cache.
- **Deterministic queries** (`inventory_manager.js`, `mcdata.js`): `canMine(block)`, `craftGap(item)`, `cheapestCraftableTool(category)`, `count(item)` — recipe and harvest-tool math done in code, not eyeballed.
- **Precondition gates with correctives.** A doomed plan is bounced *with the fix* before it wastes a turn: craft a `diamond_axe` with 0 diamonds → *"a `wooden_axe` is craftable from what you hold and does the same job."* Name a tool you don't have → rejected before the Coder and pathfinder spin on it. Fetch a tool you already hold → skipped.
- **Loop-guard.** An acquisition action that runs and changes your inventory by *nothing* gets blocked — the deterministic end of the token-burn loop.
- **Anti-honor-system finish gate** (`verify.js`). The model cannot mark a task done unless the measurable `end_factor` is actually met in world state — with delta semantics (*"+30 from where you started,"* not 30 total), so a bot that mined nothing can't false-pass.

### 2. Event-driven orchestrator + native tool-use

**The model spends turns deciding, not stepping.** Stock Mindcraft re-prompts the LLM on every appended system line — a burst engine. PincerCraft's orchestrator (`orchestrator_v2.js`) invokes the model only when something actually changed — a player message, a finished action, a mode trigger — runs a tool loop until it has nothing left to call, then **parks**. Commands are native `tool_use` JSON-schema calls, not regex-parsed free text, so a structurally malformed command can't slip through. Read-only tools fan out in parallel, and the system prompt is split into a cached static prefix and an uncached live-state tail to hold cost down.

The executor itself is **discovery-first**: it perceives the world (`!searchForBlock` / `!nearbyBlocks` / `!inventory`) and bakes the found coordinates and counts into one detailed `!newAction`, instead of blind-chaining primitives. Smart primitives — `smartGoTo` / `smartGather` / `smartBuildAt` — escalate through tiers (walk → dig with an auto-equipped pickaxe → tower/bridge), and work can be handed to role-based subagents (miner / builder / scout) via `!dispatchAgent`.

### 3. Prioritized action queue + Plan Mode

Stock Mindcraft has a single naive loop: talk while the bot is mid-task and things race.

PincerCraft adds a **session lane** (serial queue, no self-collisions) with queue modes for inputs that arrive during a running task:

| Mode | Behavior | Use case |
|---|---|---|
| `interrupt` | Abort current run, switch to new input | "Stop, come here" |
| `steer` | Inject new input into the current run between tool calls | "Also pick up dirt while you're at it" |
| `followup` | Current run finishes, new input starts after | "After the build, go to bed" |
| `collect` | Multiple followups merge into one batched turn | Burst of instructions handled together |

Plus a fifth MC-event mode (low health, enemy spotted) routed through the same lane. On top sits a **Plan Mode**: difficulty is a judgment, so the LLM rates a request 1–10 and *code* owns the threshold — only genuinely multi-stage builds decompose into queued tasks, each with an observable `end_factor`, shown for your approval before executing (propose → approve, à la Claude Code). A task-size gate keeps individual tasks small so plans stay legible.

### 4. Live, in-world Code of Conduct + layered memory

The bot's rules live in a **writable book on a lectern** in the Minecraft world. Edit the book in vanilla MC's UI and the bot re-reads `CLAUDE.md` within ~2s — the rules are injected as `$COC` at the top of *every* prompt, so they can't be forgotten across long conversations or talked-around. Rules span persona, anti-griefing, and base protection (never break beds/chests/fences — not even its owner's).

Memory is **layered**: `memory/server/*` (shared across bots), `memory/players/<player>` (per-player), and a bot layer, concatenated into `$MEMORY`. Standing rules ("from now on…") auto-route to `!remember`, not the task queue; named locations go to `!rememberHere`.

### 5. Closed-loop, DB-backed self-improvement

A continuous improvement cycle (`eval/loop.sh`): an LLM **task-giver** invents a challenge with an observable end_factor → the bot attempts it → `eval/metrics.mjs` scores token-efficiency (tokens-per-block-op, cache-hit, cost) → an **analyzer** writes a diagnosis → an **improver** patches `src/` **on a branch only** and stops for your approval — nothing is ever auto-merged. Every attempt and every approve/reject decision is written to a **SQLite system of record** (`pincercraft_evals.db`), so `eval/eval_report.py` can trend success-rate and cost-per-task across commits. A difficulty curriculum starts easy and ramps on clean successes. The loop's three agents run on the Claude **CLI subscription**, not the metered API.

### 6. Deterministic, anti-spec-gaming evaluation

A hardened layer (`evals/`) grades success **deterministically from a world-state snapshot** — never an LLM judge, never the bot's self-report (which the loop has repeatedly caught lying: a "done" with zero blocks moved). It uses **delta semantics** ("gained ≥N this run", not absolute counts the bot may already hold), per-tier timeouts, and a **train/eval holdout split** so gains are measured on tasks the loop never trained against.

---

## Based on Mindcraft

This is a fork of [kolbytn/mindcraft](https://github.com/kolbytn/mindcraft), which provides the core integration of LLMs with Minecraft via [Mineflayer](https://prismarinejs.github.io/mineflayer/). All credit for the foundation goes to the Mindcraft authors. License is MIT (preserved verbatim — see [LICENSE](LICENSE)).

To pull upstream updates:

```bash
git fetch upstream
git merge upstream/develop
```

## Setup

Same as upstream Mindcraft — see Mindcraft's [README](https://github.com/kolbytn/mindcraft/blob/main/README.md) and [FAQ](https://github.com/kolbytn/mindcraft/blob/main/FAQ.md) for installation, model configuration, and running the bot.

PincerCraft-specific notes:

- This fork ships with a `nvidia` profile (`profiles/nvidia.json`) for NVIDIA's free [build.nvidia.com](https://build.nvidia.com) NIM endpoint — Llama 3.3 70B is the recommended default.
- Active profile is set in `settings.js` under `profiles:`.

## Status

- ✅ Base Mindcraft functionality (inherited from upstream)
- ✅ NVIDIA NIM endpoint support via OpenAI-compatible adapter
- ✅ Lectern-based CLAUDE.md (live-editable in-game rulebook)
- ✅ Session lane + queue modes (Phase 1 + Phase A shipped)
- ✅ Claude-Code-style agent orchestrator (Phases A–I, 2026-05-18)
  - Tool metadata (isReadOnly / isConcurrencySafe / prompt / checkPermissions)
  - Plan Mode (`!enterPlanMode`/`!exitPlanMode` + auto-trigger on task-request)
  - Slash skills (`/init`, `/review`, `/explore`, `/sleep`, `/restock`)
  - Meta-skills (`stuck`, `loop`, `verify`) self-invokable via `!invokeSkill`
  - Role-based subagents (miner / builder / navigator / scout) via `!dispatchAgent`
  - Per-subagent model routing (Sonnet for action, Haiku for chat)
  - Inter-bot `!sendMessage`
  - Smart pathfinding/gathering/building (`smartGoTo`, `smartGather`, `smartBuildAt`) with tiered escalation
  - Layered memory (server / bot / per-player)
  - Per-player permission rules
  - MCP server mode (external agents can drive the bot)
- ✅ Deterministic state authority — live-state proprioception, `canMine`/`craftGap` queries, precondition gates with correctives, loop-guard, anti-honor-system finish gate
- ✅ Closed-loop self-improvement (`eval/`) — task-giver → metrics → analyzer → improver (branch-only, human-gated), SQLite system of record (`pincercraft_evals.db`), `eval_report.py` cross-commit trends
- ✅ Deterministic anti-spec-gaming eval layer (`evals/`) — world-state snapshot checks, delta semantics, train/eval holdout split (24-test pytest suite)
- ✅ v2 orchestrator hardening — IPv4 Mojang session-join fix, `code_task_content` populated under v2, discovery-first executor + inventory-aware conduct rules

See [`docs/agent-blueprint.md`](docs/agent-blueprint.md) for the full design and [`docs/CHANGELOG.md`](docs/CHANGELOG.md) for the build history.

## License

MIT — same as upstream Mindcraft.
