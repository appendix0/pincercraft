<h1 align="center">PincerCraft</h1>

<p align="center">A Mindcraft fork that makes the bot <em>orderly</em>: prioritized action queue + customizable in-game Code of Conduct.</p>

<p align="center">
  <a href="https://github.com/kolbytn/mindcraft">Upstream Mindcraft</a> ·
  <a href="https://docs.openclaw.ai/concepts/agent-loop">OpenClaw (inspiration)</a>
</p>

---

## What PincerCraft adds to Mindcraft

PincerCraft turns stock Mindcraft from a one-message-in / one-command-out loop into a **Claude-Code-style autonomous agent with a self-improvement flywheel**. Five structural additions:

### 1. Prioritized action queue + Plan Mode

Stock Mindcraft has a single naive loop: one chat message in → one LLM call → one command → repeat. Talk while the bot is mid-task and things race.

PincerCraft adds a **session lane** (serial queue, no self-collisions) with queue modes for inputs that arrive during a running task:

| Mode | Behavior | Use case |
|---|---|---|
| `interrupt` | Abort current run, switch to new input | "Stop, come here" |
| `steer` | Inject new input into the current run between tool calls | "Also pick up dirt while you're at it" |
| `followup` | Current run finishes, new input starts after | "After the build, go to bed" |
| `collect` | Multiple followups merge into one batched turn | Burst of instructions handled together |

Plus a fifth MC-event mode (low health, enemy spotted) routed through the same lane. On top sits a **Plan Mode**: for a multi-step request the bot decomposes it into queued tasks — each with an observable `end_factor` — shows the plan, and waits for your approval before executing (propose → approve, à la Claude Code). A task-size gate keeps individual tasks small so plans stay legible.

### 2. Live, in-world Code of Conduct + layered memory

The bot's rules live in a **writable book on a lectern** in the Minecraft world. Edit the book in vanilla MC's UI and the bot re-reads `CLAUDE.md` within ~2s — the rules are injected as `$COC` at the top of *every* prompt, so they can't be forgotten across long conversations or talked-around. Rules span persona, anti-griefing, and base protection (never break beds/chests/fences — not even its owner's).

Memory is **layered**: `memory/server/*` (shared across bots), `memory/players/<player>` (per-player), and a bot layer, concatenated into `$MEMORY`. Standing rules ("from now on…") auto-route to `!remember`, not the task queue; named locations go to `!rememberHere`.

### 3. Closed-loop, DB-backed self-improvement

A continuous improvement cycle (`eval/loop.sh`): an LLM **task-giver** invents a challenge with an observable end_factor → the bot attempts it → `eval/metrics.mjs` scores token-efficiency (tokens-per-block-op, cache-hit, cost) → an **analyzer** writes a diagnosis → an **improver** patches `src/` **on a branch only** and stops for your approval — nothing is ever auto-merged. Every attempt and every approve/reject decision is written to a **SQLite system of record** (`pincercraft_evals.db`), so `eval/eval_report.py` can trend success-rate and cost-per-task across commits. A difficulty curriculum starts easy and ramps on clean successes. The loop's three agents run on the Claude **CLI subscription**, not the metered API.

### 4. Deterministic, anti-spec-gaming evaluation

A hardened layer (`evals/`) grades success **deterministically from a world-state snapshot** — never an LLM judge, never the bot's self-report (which the loop has repeatedly caught lying: a "done" with zero blocks moved). It uses **delta semantics** ("gained ≥N this run", not absolute counts the bot may already hold), per-tier timeouts, and a **train/eval holdout split** so gains are measured on tasks the loop never trained against.

### 5. Discovery-first agentic executor

A v2 orchestrator with per-command tool metadata (`isReadOnly` / `isConcurrencySafe` / `checkPermissions`) and a **discovery-first** executor: before targeting a resource it perceives the world (`!searchForBlock` / `!nearbyBlocks` / `!inventory`) and bakes the found coords/counts into a single detailed `!newAction`. Smart primitives — `smartGoTo` / `smartGather` / `smartBuildAt` — escalate through tiers (walk → dig with auto-equipped pickaxe → tower/bridge), and work can be routed to role-based subagents (miner / builder / scout) via `!dispatchAgent`.

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
- ✅ Closed-loop self-improvement (`eval/`) — task-giver → metrics → analyzer → improver (branch-only, human-gated), SQLite system of record (`pincercraft_evals.db`), `eval_report.py` cross-commit trends
- ✅ Deterministic anti-spec-gaming eval layer (`evals/`) — world-state snapshot checks, delta semantics, train/eval holdout split (24-test pytest suite)
- ✅ v2 orchestrator hardening — IPv4 Mojang session-join fix, `code_task_content` populated under v2, discovery-first executor + inventory-aware conduct rules

See [`docs/agent-blueprint.md`](docs/agent-blueprint.md) for the full design and [`docs/CHANGELOG.md`](docs/CHANGELOG.md) for the build history.

## License

MIT — same as upstream Mindcraft.
