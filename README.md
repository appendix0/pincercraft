<h1 align="center">PincerCraft</h1>

<p align="center">A Mindcraft fork that makes the bot <em>orderly</em>: prioritized action queue + customizable in-game Code of Conduct.</p>

<p align="center">
  <a href="https://github.com/kolbytn/mindcraft">Upstream Mindcraft</a> ·
  <a href="https://docs.openclaw.ai/concepts/agent-loop">OpenClaw (inspiration)</a>
</p>

---

## What PincerCraft adds to Mindcraft

Two architectural changes on top of upstream Mindcraft:

### 1. Prioritized action queue (OpenClaw-inspired)

Stock Mindcraft has a single naive loop: one chat message in → one LLM call → one command → repeat. If you talk while the bot is mid-task, things race.

PincerCraft adds a **session lane** (serial queue, no self-collisions) with four queue modes for handling new inputs that arrive during a running task:

| Mode | Behavior | Use case |
|---|---|---|
| `interrupt` | Abort current run, switch to new input | "Stop, come here" |
| `steer` | Inject new input into the current run between tool calls | "Also pick up dirt while you're at it" |
| `followup` | Current run finishes, new input starts after | "After the build, go to bed" |
| `collect` | Multiple followups merge into one batched turn | Burst of instructions handled together |

Plus a fifth MC-specific mode for game events (low health, enemy spotted, etc.) routed through the same lane as first-class inputs.

> Status: **design phase**. Not yet implemented.

### 2. Customizable in-game Code of Conduct

The bot reads its rules from a **writable book on a lectern** in the Minecraft world. Edit the book in vanilla MC's native UI; the bot picks up the new rules within ~2 seconds and refuses any future requests that violate them.

The COC lives at the top of every system prompt sent to the LLM, so it can't be forgotten across long conversations.

> Status: **planned**. Fallback `coc.md` file will exist for when no lectern is placed.

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

See [`docs/agent-blueprint.md`](docs/agent-blueprint.md) for the full design.

## License

MIT — same as upstream Mindcraft.
