<h1 align="center">PincerCraft</h1>

<p align="center">
  <img src="banner.webp" alt="PincerCraft — a Minecraft bot that can't lie to itself" width="640">
</p>

<p align="center"><b>A Minecraft bot that can't lie to itself.</b><br>A Mindcraft fork rebuilt Claude-Code-style: a deterministic harness under the LLM.</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT">
  <img src="https://img.shields.io/badge/fork%20of-Mindcraft-informational" alt="Fork of Mindcraft">
  <img src="https://img.shields.io/badge/lies%20to%20itself-no-brightgreen" alt="Lies to itself: no">
</p>

<p align="center">
  <a href="https://appendix0.github.io/pincercraft-site/">Site</a> ·
  <a href="https://github.com/kolbytn/mindcraft">Upstream</a> ·
  <a href="docs/agent-blueprint.md">Design</a> ·
  <a href="docs/CHANGELOG.md">Changelog</a>
</p>

---

Stock Mindcraft hands an LLM a pickaxe and hopes. The model guesses its own inventory, "remembers" tools it isn't holding, declares victory over tasks it never finished, and re-prompts itself straight into a rate limit.

PincerCraft fixes that with one rule:

> **Code owns the facts. The LLM owns the plan.**

Inventory counts, *"can I mine this?"*, the recipe gap, *"is this task actually done?"* — computed every turn and handed to the model. It doesn't get to guess. That's the discipline of a coding agent like Claude Code — check the ground truth before you act, gate anything destructive, plan before you execute — pointed at a Minecraft bot.

## What makes it different

🧠 **It can't lie to itself.** The hard facts — inventory counts, *"can I mine this?"*, the recipe gap, whether a task is actually finished — are computed in code every turn and handed to the model. So when it reaches for a diamond axe with zero diamonds, the bot catches it before the swing, points it at the wooden one, and carries on. The LLM owns the plan; it never gets to guess the facts. → [`live_state.js`](src/agent/live_state.js), [`verify.js`](src/agent/verify.js)

⚡ **It thinks, then shuts up.** Stock Mindcraft re-prompts the model on every new line and bursts itself straight into a rate limit. PincerCraft wakes the model only when something actually changed — a chat message, a finished action, a mob with bad intentions — then parks until the next one. Cheaper, calmer, and no more "my brain disconnected." → [`orchestrator_v2.js`](src/agent/orchestrator_v2.js)

📋 **It plans before it digs.** Talk to it mid-task and your words slot into a queue instead of starting a race. Hand it something big and it breaks the job into steps, posts the plan to chat, and waits for your "go" before touching a single block. Small stuff just runs — planning is reserved for builds that actually need it.

📖 **Players write house rules. Nobody rewrites the constitution.** The bot's conduct comes in two parts. The staple Code of Conduct — no griefing, no chest theft, protect the owner's base — ships in [`CLAUDE.md`](CLAUDE.md) and is never written at runtime. House rules live in a writable book on a lectern *inside Minecraft*: edit the book in vanilla MC and the bot re-reads it within ~2 seconds, no restart. On conflict, the constitution wins — we know, because someone put a book on the lectern that said "You are Groot" and it replaced the bot's entire personality for two weeks. Now it can't. → [`coc.js`](src/agent/coc.js), [`rulebook_lectern.js`](src/agent/rulebook_lectern.js)

🔁 **It grades itself — and the grader doesn't take its word.** An eval loop invents tasks, runs them, and labels success with a deterministic referee that snapshots inventory before the task and re-measures after. The bot's own "done!" doesn't count; the world state does. When the loop finds a weak spot it drafts a fix to `src/` on a branch and stops for human review — nothing merges itself. → [`eval/referee.mjs`](eval/referee.mjs), [`eval/loop.sh`](eval/loop.sh)

## Receipts

The referee exists because we caught the old honor system red-handed: eval cycle 2 asked the bot to *gather 32 cobblestone*, it already held 37, declared done in five seconds having moved zero blocks — and the LLM grader scored it a success. The deterministic delta check fails it: gained 0, needed 32. That disagreement is the whole thesis in one row of the database.

Every attempt now lands in a SQLite ledger (`task_attempts`: tokens, wall clock, failure mode, and `label_source` — whether the referee measured it or it fell back to the honor system). A full benchmark table — success rate and token cost across difficulty tiers, referee-labeled — is the current campaign; it goes here when the numbers exist. We're not going to hand-wave the one section the fork is named after.

## Stock Mindcraft vs PincerCraft

| | Stock | PincerCraft |
|---|---|---|
| Inventory & recipes | LLM eyeballs them | computed in code |
| "Task done?" | honor system | measured against world state |
| A bad plan | runs, fails, retries | bounced with a fix |
| Agent loop | re-prompts on every line | parks until something changes |
| Bot rules | config file | staple CoC + in-world editable house rules |
| Getting better | you edit the code | it drafts its own patches, you review |

## Setup

**Requirements:** Node **20.x** (hard requirement — Node 24 crashes the agent child with `ERR_INTERNAL_ASSERTION`; use `nvm install 20`), a Java-edition Minecraft server (tested on Paper 1.21.x; Bedrock players can join via Geyser/Floodgate), and an **Anthropic API key**. The v2 orchestrator speaks the structured tool-calling protocol and Claude is the tested brain (Haiku planner + Sonnet coder); providers that silently drop `tools[]` (e.g. DeepSeek) only work with the legacy loop.

```bash
git clone https://github.com/appendix0/pincercraft.git && cd pincercraft
nvm use 20
npm install
cp keys.example.json keys.json   # add ANTHROPIC_API_KEY (and mcp_token if you use the eval loop)
```

Then make `settings.js` yours — this is the part the upstream README won't tell you:

- `host` / `port` / `minecraft_version` / `auth` — point at your server.
- `only_chat_with` — your username. This is who the bot **listens** to. (Bedrock-via-Floodgate names: drop the `.` prefix.)
- `permissions` — what each listener may make the bot **do**. Two layers, not duplicates. Default-deny for strangers; give yourself `"allow": ["!*"]`.
- `profiles` — your bot's profile JSON (name, models). Start from [`profiles/claude.json`](profiles/claude.json).
- `mcp.enabled` — the bot can expose its commands as MCP tools on localhost (bearer-token auth) so external agents and the eval loop can drive it. Off if you don't want that.

```bash
npm start
```

The self-improvement loop lives in [`eval/`](eval/) (`bash eval/session.sh` runs cycles; the improver only ever writes to a branch). The deterministic graders live in [`evals/`](evals/).

## Based on Mindcraft

This is a fork of [kolbytn/mindcraft](https://github.com/kolbytn/mindcraft), which provides the core integration of LLMs with Minecraft via [Mineflayer](https://prismarinejs.github.io/mineflayer/). All credit for the foundation goes to the Mindcraft authors. License is MIT, preserved verbatim — see [LICENSE](LICENSE).

To pull upstream updates:

```bash
git fetch upstream
git merge upstream/develop
```

## License

MIT — same as upstream Mindcraft.
