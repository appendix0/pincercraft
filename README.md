<h1 align="center">PincerCraft</h1>

<p align="center">
  <img src="banner.webp" alt="PincerCraft — code owns the facts, the LLM owns the plan" width="640">
</p>

<p align="center"><b>Code owns the facts. The LLM owns the plan.</b><br>A Minecraft agent with a deterministic backbone, built for open-world, long-horizon tasks. A Mindcraft fork.</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT">
  <img src="https://img.shields.io/badge/fork%20of-Mindcraft-informational" alt="Fork of Mindcraft">
  <img src="https://img.shields.io/badge/lies%20to%20itself-no-brightgreen" alt="Lies to itself: no">
  <img src="https://img.shields.io/badge/referee--verified-9%2F9%20harness%20on%20·%201%2F9%20off-blueviolet" alt="Referee-verified: 9/9 with the harness, 1/9 without">
</p>

<p align="center">
  <a href="https://appendix0.github.io/pincercraft-site/">Site</a> ·
  <a href="https://github.com/mindcraft-bots/mindcraft">Upstream</a> ·
  <a href="docs/agent-blueprint.md">Design</a> ·
  <a href="docs/receipts/">Receipts</a> ·
  <a href="docs/CHANGELOG.md">Changelog</a>
</p>

<!-- DEMO SLOT: 30–60s GIF goes here when recorded (storyboard: docs/receipts/2026-07-12-search-miss-before-after.md) -->

---

Open-world, long-horizon tasks are where LLM agents fall apart: they drift off-goal, loop on broken plans, and misreport their own progress. PincerCraft is an experiment in fixing that with architecture instead of bigger models — a deterministic harness that owns the facts, guards against loops, and grades the outcomes, under an LLM that only plans. Minecraft works as the arena — open-ended, unforgiving, cheap to measure — but the agenda reaches past the game: the same failures wait for any agent that has to act in the real, physical open world.

Stock Mindcraft hands an LLM a pickaxe and hopes. The model guesses its own inventory, "remembers" tools it isn't holding, declares victory over tasks it never finished, and re-prompts itself straight into a rate limit. We caught ours declaring a *gather 32 cobblestone* task done in five seconds — it hadn't moved; it already owned 37 and figured that counted.

PincerCraft fixes that with one rule:

> **Code owns the facts. The LLM owns the plan.**

Inventory counts, *"can I mine this?"*, the recipe gap, *"is this task actually done?"* — computed every turn and handed to the model. It doesn't get to guess. That's the discipline of a coding agent like Claude Code — check the ground truth before you act, gate anything destructive, plan before you execute — pointed at a Minecraft bot.

## The problem, named and measured

The distance between what an agent *says* it did and what the world's ledger *shows* — the **say-do gap** — is the problem this repo exists to close. We ran the same ten benchmark tasks with the harness on and off, every attempt graded by a deterministic referee from the world-state delta; the model's own "done!" counts for nothing:

| | claimed "done" | the world agreed |
|---|---|---|
| **Harness on** | 9/9 | **9/9** |
| **Harness off** | 9/9 | **1/9** |

Same model, same tasks, same server — the only variable is whether code or the LLM owns the facts. The gap is a loop-design problem, not a model problem, which means a bigger model won't close it and a referee will. (The referee itself was calibrated against blind human labels first: 11/12, 92%.) Full table, caveats included, in [Receipts](#receipts).

## The five features that matter

### 1. The deterministic layer — code owns every fact

The flagship, and the reason the fork exists. Everything the bot *believes* is computed in code and handed to the model; everything the bot *claims* is measured back against the world. The LLM plans — it never gets to guess a fact or grade its own work.

**1-1 · Perception.** Inventory counts, *"can I mine this?"*, the recipe gap, health, time of day — recomputed every turn and injected into the model's context. The model reads the world; it doesn't imagine it. → [`live_state.js`](src/agent/live_state.js)

**1-2 · Gates.** Impossible actions bounce before the swing: reach for a diamond axe with zero diamonds and the preflight check catches it, points the bot at the wooden one, and carries on. Crafting without ingredients, mining without the right tool — rejected with the fix attached, not discovered mid-failure. → [`verify.js`](src/agent/verify.js)

**1-3 · Reflexes.** Failure shapes that don't deserve an LLM round get hard-coded responses: an empty wide search parks the task and asks the player instead of looping (it once spent 24 rounds hunting spiders on a peaceful world — never again), a broken tool re-equips, a full inventory gets handled before it blocks the task.

**1-4 · The referee.** Task success is measured, not claimed: snapshot inventory before, re-measure after, label from the world-state delta. The bot's own "done!" counts for nothing. Every attempt lands in a SQLite ledger with tokens, wall clock, failure mode, and who labeled it — referee or honor system ([receipts below](#receipts)). → [`eval/referee.mjs`](eval/referee.mjs)

### 2. It thinks, then shuts up

Stock Mindcraft re-prompts the model on every chat line and bursts itself into rate limits. PincerCraft's orchestrator wakes the model only on real events — a message, a finished action, a mob with bad intentions — then parks. Mid-task requests slot into a queue instead of starting a race, and big asks get decomposed into a plan posted to chat for your "go" before it touches a block. Calmer, and no more "my brain disconnected." → [`orchestrator_v2.js`](src/agent/orchestrator_v2.js)

### 3. Loop guards and caching — the token savers

The mechanisms that keep the API bill boring. A circuit-breaker cancels any task that stops converging (12 rounds on the same fingerprint and it's done — no more $100 of "discussing nonsense"). The prompt is laid out cache-first: the static system block and tools sit before the cache breakpoint, per-turn live state goes in a separate uncached block after it, so the expensive prefix is read from cache on every wake instead of re-billed. And the orchestrator's own history auto-compacts before it can grow unbounded. → [`claude.js`](src/models/claude.js), [`orchestrator_v2.js`](src/agent/orchestrator_v2.js)

### 4. Players write house rules inside Minecraft

Conduct comes in two parts. The staple Code of Conduct — no griefing, no chest theft, protect the owner's base — ships in [`CLAUDE.md`](CLAUDE.md) and is never written at runtime. House rules live in a writable book on a lectern *in the world*: edit it in vanilla Minecraft and the bot re-reads it within ~2 seconds, no restart. On conflict, the constitution wins — we know, because someone once put "You are Groot" on the lectern and it replaced the bot's entire personality for two weeks. Now it can't. → [`coc.js`](src/agent/coc.js), [`rulebook_lectern.js`](src/agent/rulebook_lectern.js)

### 5. Appendix: a self-improvement loop, open for study

A closed eval loop invents tasks (easy first, ramping on clean successes), runs them, referee-labels the outcomes, finds the weak spot, and drafts a fix to `src/` — **on a branch, stopped for human review**. Nothing merges itself. The loop is how most of the fixes in the [changelog](docs/CHANGELOG.md) were found, and it's why the repo doubles as a case study: every attempt it ever made is in the ledger, episode traces included, failures and all. → [`eval/`](eval/)

## Receipts

The referee exists because we caught the old honor system red-handed: eval cycle 2 asked the bot to *gather 32 cobblestone*, it already held 37, declared done in five seconds having moved zero blocks — and the LLM grader scored it a success. The deterministic delta check fails it: gained 0, needed 32. That disagreement is the whole thesis in one row of the database.

For a worked before/after with real transcripts — the same impossible task with and without the harness — see [the search-miss receipt](docs/receipts/2026-07-12-search-miss-before-after.md).

### Field Trial v1 — harness on vs. harness off (2026-07-19)

The promised benchmark: the same ten fixed tasks run twice — once with the full harness, once with it ablated (raw state injection, no gates, no reflexes, no verified finishes; player-safety stays on in both arms). Every attempt referee-labeled from the world-state delta, every row in the ledger under `task_set = bench_on` / `bench_off`.

| Tier | Benchmark | Harness ON | Harness OFF |
|---|---|---|---|
| 1 | Mine 16 cobblestone | ✅ verified | ❌ claimed done at 6s, gained 0 |
| 1 | Chop 6 oak logs | ✅ verified | ❌ claimed at 5s, gained 0 |
| 1 | Collect 8 dirt | ✅ verified | ❌ claimed at 5s, gained 5 of 8 |
| 2 | Craft 16 oak planks | ✅ verified | ❌ claimed instantly, gained 0 |
| 2 | Craft 12 sticks | ✅ verified | ❌ claimed at 5s, gained 0 |
| 2 | Craft 1 furnace | ✅ verified | ❌ claimed at 5s, gained 0 |
| 3 | Craft 8 torches | ✅ verified | ❌ claimed at 16s, gained 0 |
| 3 | Craft 1 stone pickaxe | ✅ verified | ❌ claimed at 10s, gained 0 |
| 3 | Craft 3 ladders | ✅ verified | ✅ verified |
| 3 | 5×5 platform *(honor-system)* | "pass" — 191s of actual building | "pass" — claimed at 35s, no building |

**Referee-verified success: 9/9 with the harness, 1/9 without.** Both arms *claimed* 9/9. The off-arm failure shape is uniform — declare done within seconds, referee measures nothing gained. The one honest off-arm pass (ladders) had the materials already on hand. And the platform row is the honor-system exhibit hiding in plain sight: builds have no referee coverage yet, so both arms "pass" — including the 35-second claim with zero blocks placed. That's why honor labels never make a headline here.

Fine print, because receipts cut both ways: the off arm inherited a stocked inventory from the on arm's runs (an *easier* setup) and still went 1/9 — the gap is conservative. The referee itself was calibrated first: **11/12 (92%)** agreement with blind human labels across gain, loss, and cancel criteria. Token cost tells the same story — the harness arm spent ~413k input / 6.5k output tokens doing the actual work; the ablated arm spent ~318k / 2k mostly generating claims.

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

**Requirements:** Node **20.x** (hard requirement — Node 24 crashes the agent child with `ERR_INTERNAL_ASSERTION`; use `nvm install 20`), a Java-edition Minecraft server (tested on Paper 1.21.x; Bedrock players can join via Geyser/Floodgate), and an **Anthropic API key**. Both planning and code run **Claude Sonnet 4.6** (`model` and `code_model` in the profile). Why: the v2 orchestrator is built on structured tool calling, and Claude is the brain that's proven reliable at it — providers that silently drop `tools[]` (e.g. DeepSeek) only work with the legacy loop. And Sonnet-tier judgment is a deliberate choice: the meta-behaviors live in prompt rules the model has to actually follow, so upgrading judgment beat piling on code band-aids, while the cache-first layout and event-driven loop keep the bill sane.

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

This is a fork of [mindcraft-bots/mindcraft](https://github.com/mindcraft-bots/mindcraft) (formerly kolbytn/mindcraft), which provides the core integration of LLMs with Minecraft via [Mineflayer](https://prismarinejs.github.io/mineflayer/). All credit for the foundation goes to the Mindcraft authors. License is MIT, preserved verbatim — see [LICENSE](LICENSE).

To pull upstream updates:

```bash
git fetch upstream
git merge upstream/develop
```

## License

MIT — same as upstream Mindcraft.
