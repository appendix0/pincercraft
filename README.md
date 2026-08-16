<h1 align="center">PincerCraft</h1>

<p align="center">
  <img src="banner.webp" alt="PincerCraft — code owns the facts, the LLM owns the plan" width="640">
</p>

<p align="center"><b>Code owns the facts. The LLM owns the plan.</b><br>A Minecraft agent with a deterministic backbone, built for open-world, long-horizon tasks. A Mindcraft fork.</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT">
  <img src="https://img.shields.io/badge/fork%20of-Mindcraft-informational" alt="Fork of Mindcraft">
  <img src="https://img.shields.io/badge/lies%20to%20itself-no-brightgreen" alt="Lies to itself: no">
  <img src="https://img.shields.io/badge/scorer--verified-67%25%20on%20·%2029%25%20off%20(n%3D356)-blueviolet" alt="Scorer-verified success: 67.3% with the harness, 29.4% without, over 356 attempts">
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

The distance between what an agent *says* it did and what the world's ledger *shows* — the **say-do gap** — is the problem this repo exists to close. A pre-registered campaign ran 13 benchmark tasks × 7 arms × 4 replicates — **356 attempts**, one model, one world, one commit — every attempt graded by a deterministic scorer from the world-state delta; the model's own "done!" counts for nothing:

| | claimed "done" | the world agreed |
|---|---|---|
| **Harness on** (n=52) | 71.2% | **67.3%** |
| **Harness off** (n=51) | 74.5% | **29.4%** |

**The two arms claim success at statistically indistinguishable rates and deliver less than half as much. The harness does not make the agent claim less — it makes the claims true.** Verified success +37.9pp, 95% CI [+20.2, +56.9]; false completion −41.3pp, [−60.8, −23.1]. Under ablation the agent overstated its success on 23 of 51 attempts and understated on none (McNemar p = 2.4 × 10⁻⁷).

Same model, same tasks, same server — the only variable is whether code or the LLM owns the facts. The gap is a loop-design problem, not a model problem, which means a bigger model won't close it and a scorer will. Full tables, limitations included, in [results.md](docs/paper/results.md).

> Earlier copy here headlined a **9/9 vs 1/9** pilot at a single seed. That result is real and is preserved below, but it is superseded: the confirmatory campaign measured less than half that gap, and [the pre-registration](docs/paper/preregistration.md) §11 committed in advance to headlining whatever the confirmatory run produced. It does.

## The five features that matter

Five features, one underlying split. **System1** is the deterministic layer: perception, gates, reflexes, and the scorer (§1 below), plus the loop guards in §3 — all code, all CPU, all free to run. **System2** is the LLM — invoked only to plan and to write code (§2) — the only part that costs a token. It's the same dual-process pattern physical-AI models like NVIDIA's GR00T use (fast reactive control vs. slow reasoning), applied to an agent loop instead of a robot arm: keep the fast layer in code, spend the slow layer's budget on judgment. Cache-first prompt layout (§3) keeps even that budget small — 79% of measured tokens are cache reads, not fresh billing. → [`modes.js`](src/agent/modes.js) (11 named reflexes), [`live_state.js`](src/agent/live_state.js), [`orchestrator_v2.js`](src/agent/orchestrator_v2.js)

### 1. The deterministic layer — code owns every fact

The flagship, and the reason the fork exists. Everything the bot *believes* is computed in code and handed to the model; everything the bot *claims* is measured back against the world. The LLM plans — it never gets to guess a fact or grade its own work.

**1-1 · Perception.** Inventory counts, *"can I mine this?"*, the recipe gap, health, time of day — recomputed every turn and injected into the model's context. The model reads the world; it doesn't imagine it. → [`live_state.js`](src/agent/live_state.js)

**1-2 · Gates.** Impossible actions bounce before the swing: reach for a diamond axe with zero diamonds and the preflight check catches it, points the bot at the wooden one, and carries on. Crafting without ingredients, mining without the right tool — rejected with the fix attached, not discovered mid-failure. → [`verify.js`](src/agent/verify.js)

**1-3 · Reflexes.** Failure shapes that don't deserve an LLM round get hard-coded responses: an empty wide search parks the task and asks the player instead of looping (it once spent 24 rounds hunting spiders on a peaceful world — never again), a broken tool re-equips, a full inventory gets handled before it blocks the task.

**1-4 · The scorer.** Task success is measured, not claimed: snapshot inventory before, re-measure after, label from the world-state delta. The bot's own "done!" counts for nothing. Every attempt lands in a SQLite ledger with tokens, wall clock, failure mode, and who labeled it — scorer or honor system ([receipts below](#receipts)). → [`eval/referee.mjs`](eval/referee.mjs)

### 2. It thinks, then shuts up

Stock Mindcraft re-prompts the model on every chat line and bursts itself into rate limits. PincerCraft's orchestrator wakes the model only on real events — a message, a finished action, a mob with bad intentions — then parks. Mid-task requests slot into a queue instead of starting a race, and big asks get decomposed into a plan posted to chat for your "go" before it touches a block. Calmer, and no more "my brain disconnected." → [`orchestrator_v2.js`](src/agent/orchestrator_v2.js)

### 3. Loop guards and caching — the token savers

The mechanisms that keep the API bill boring. A circuit-breaker cancels any task that stops converging (12 rounds on the same fingerprint and it's done — no more $100 of "discussing nonsense"). The prompt is laid out cache-first: the static system block and tools sit before the cache breakpoint, per-turn live state goes in a separate uncached block after it, so the expensive prefix is read from cache on every wake instead of re-billed. And the orchestrator's own history auto-compacts before it can grow unbounded. → [`claude.js`](src/models/claude.js), [`orchestrator_v2.js`](src/agent/orchestrator_v2.js)

### 4. Players write house rules inside Minecraft

Conduct comes in two parts. The staple Code of Conduct — no griefing, no chest theft, protect the owner's base — ships in [`CLAUDE.md`](CLAUDE.md) and is never written at runtime. House rules live in a writable book on a lectern *in the world*: edit it in vanilla Minecraft and the bot re-reads it within ~2 seconds, no restart. On conflict, the constitution wins — we know, because someone once put "You are Groot" on the lectern and it replaced the bot's entire personality for two weeks. Now it can't. → [`coc.js`](src/agent/coc.js), [`rulebook_lectern.js`](src/agent/rulebook_lectern.js)

### 5. Appendix: a self-improvement loop, open for study

A closed eval loop invents tasks (easy first, ramping on clean successes), runs them, scorer-labels the outcomes, finds the weak spot, and drafts a fix to `src/` — **on a branch, stopped for human review**. Nothing merges itself. The loop is how most of the fixes in the [changelog](docs/CHANGELOG.md) were found, and it's why the repo doubles as a case study: every attempt it ever made is in the ledger, episode traces included, failures and all. → [`eval/`](eval/)

## Receipts

The scorer exists because we caught the old honor system red-handed: eval cycle 2 asked the bot to *gather 32 cobblestone*, it already held 37, declared done in five seconds having moved zero blocks — and the LLM grader scored it a success. The deterministic delta check fails it: gained 0, needed 32. That disagreement is the whole thesis in one row of the database.

For a worked before/after with real transcripts — the same impossible task with and without the harness — see [the search-miss receipt](docs/receipts/2026-07-12-search-miss-before-after.md).

### The data pyramid — how the numbers get trusted

Physical-AI teams calibrate broad automated data against a small, expensive, human-verified set before trusting it at scale. Same shape here:

| Tier | What | Rows | Role |
|---|---|---|---|
| Apex — calibration | blind human verdicts (`gold_attempts`) | 85 tagged | certifies the scorer, per verdict cell |
| Middle — scale | scorer labels from world-state delta (`task_attempts`) | 356 primary | cheap, automated, trustworthy *because* calibrated |
| Base — raw | the model's own honor-system word | the counter-exhibit | **0/5** agreement with blind humans — included on purpose, never headlined |

**How the apex count works**, since it is the number a reader will check. `gold_attempts` holds **92** human-judged rows and they are not all calibration: **85** carry an `agree:task_id=N` tag binding the verdict to one specific attempt, and **7** are curated examples that certify nothing. Only tagged rows are calibration, and only `eval/agreement.py label` writes them.

The 85 split into **three sets that are never pooled**, because they were drawn from different populations by different rules:

| set | drawn how | agreement |
|---|---|---|
| pilot (pre-freeze) | convenience | 11/12 = 92% |
| confirmatory (2026-08-08) | convenience, glob order | 39/39 = 100%, Wilson [91.0, 100.0] |
| **stratified (2026-08-16)** | **by scorer verdict, from the campaign itself** | **read per cell, below** |

**Why a fourth pass was needed even at 39/39.** That figure is a prevalence-weighted aggregate: 34 of its 39 labels are *true completions*, and none of the 39 judges an attempt from the confirmatory campaign. The scorer's **false-completion** verdict — what every headline number here depends on — was validated on **2 attempts**. So 30 more were drawn from the campaign's own primary set, oversampling that cell, with the sampling rule, seed and decision rule registered and the draw sealed behind a hash *before* any card was rendered:

| cell | labelled | agreement | Wilson 95% |
|---|---|---|---|
| **scorer says false completion** | 21 | **95.2%** | **[77.3, 99.2]** |
| ⤷ inventory-delta path (328 of 356 rows) | 17 | **100%** | **[81.6, 100.0]** |
| ⤷ block-scan path | 4 | 75% | [30.1, 95.4] |
| scorer says success | 4 | 100% | [51.0, 100.0] |
| scorer says fail, no claim | 4 | 100% | [51.0, 100.0] |

**Two things this does not claim.** The block-scan scorer (structure criteria, 28 rows) is **engineering-validated against RCON-placed ground truth, not human-calibrated** — a labeller sees an inventory delta and cannot check geometry, which is why the one disagreement landed there. And the reweighted overall agreement carries a conservative bound of 52.9%, because the label budget was deliberately spent on the cell that matters rather than spread evenly. Details and the abstention record: [results.md §2.1](docs/paper/results.md).

This matters beyond the labels: any metric *derived* from a verified success — cost per verified success, the say-do gap itself — inherits the apex dependency. Only raw instrument readings (tokens per run, wall clock) stand outside the pyramid, because the model never self-reports them.

The confirmatory campaign is the pyramid's output: 13 tasks, 7 arms, 4 replicates, built entirely on the calibrated middle tier. Field Trial v1 below is the superseded pilot that motivated it. All three tiers, raw: [`Appendix0/pincercraft-say-do-gap`](https://huggingface.co/datasets/Appendix0/pincercraft-say-do-gap) on Hugging Face.

### Field Trial v1 — harness on vs. harness off (2026-07-19) · **superseded pilot**

> **Superseded by the confirmatory campaign.** Single seed, n=1 per task, fixed arm order, no state reset between attempts. The rows below are accurate as collected and are kept because they are the receipts that motivated the real design — but every claim in this README now rests on the 356-attempt campaign above, not on this. Single-seed results of this shape regress, and this one did: 89pp here against +37.9pp measured properly.

The promised benchmark: the same ten fixed tasks run twice — once with the full harness, once with it ablated (raw state injection, no gates, no reflexes, no verified finishes; player-safety stays on in both arms). Every attempt scorer-labeled from the world-state delta, every row in the ledger under `task_set = bench_on` / `bench_off`.

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

**Scorer-verified success: 9/9 with the harness, 1/9 without.** Both arms *claimed* 9/9. The off-arm failure shape is uniform — declare done within seconds, scorer measures nothing gained. The one honest off-arm pass (ladders) had the materials already on hand. And the platform row is the honor-system exhibit hiding in plain sight: builds have no scorer coverage yet, so both arms "pass" — including the 35-second claim with zero blocks placed. That's why honor labels never make a headline here.

Fine print, because receipts cut both ways: the off arm inherited a stocked inventory from the on arm's runs (an *easier* setup) and still went 1/9 — the gap is conservative. The scorer at the time carried the pilot calibration, **11/12 (92%)**, whose Wilson lower bound was 65%; the current figures are above. Token cost tells the same story — the harness arm spent ~413k input / 6.5k output tokens doing the actual work; the ablated arm spent ~318k / 2k mostly generating claims.

## Structural symmetry with physical-AI safety systems

This is a Minecraft agent, but the architecture it converged on is the one the robotics labs are converging on independently. Google DeepMind's [Gemini Robotics 2 safety report](https://storage.googleapis.com/deepmind-media/gemini-robotics/Gemini-Robotics-2-Safety.pdf) (2026-07-29) describes an embodied-reasoning model supervising a vision-language-action model — a "system 2 / system 1" split where the upper model must refuse unsafe tool calls, shield the lower model from tasks it will fumble, and request human help rather than propagate uncertainty downstream. Every one of those roles has a counterpart here, arrived at for different reasons.

| PincerCraft | Physical-AI counterpart | Where it appears |
|---|---|---|
| Deterministic scorer — verdict from world-state delta, never the agent's word | ER model gating VLA tool calls | ASIMOV-Agentic, safety orchestration |
| Say-do preempt — async interrupt aborts the running task | Safety tool calling — fault message triggers `robot_stop()` | ASIMOV-Agentic §2.3 |
| CoC gates — `canMine` / `hasTool` preconditions refuse the action | Safety constraint following — payload, gripper width, contamination limits | ASIMOV-Agentic §2.1 |
| Craft-preflight gate — bounce a plan the world can't support | VLA feasibility awareness — shield the policy from out-of-distribution subtasks | ASIMOV-Agentic §2.4 |
| Plan-mode entry on ambiguous asks | Instruction ambiguity — pause and query the operator | ASIMOV-Agentic §2.5 |
| Honor-system rows, kept as the counter-exhibit | Self-reported episode success labels in robot datasets | e.g. `next.success` in LeRobot |
| Scorer calibrated against blind human labels, stratified by verdict cell | *no widely adopted counterpart* | — |

The last row is the interesting one. DeepMind's supervising gate is itself a statistical model — an LLM judging an LLM — and their own numbers show it wobbling: on human-proximity monitoring, holding false stops under 5% costs a false-negative rate above 40%. The gate here is deterministic code reading world state, so it cannot hallucinate its own compliance, and it was calibrated against blind human labels before being trusted at scale. Calibrating the judge is ordinary practice in measurement and still rare in agent evaluation.

None of this makes a Minecraft bot a robot. It does mean the *measurement method* transfers, which is the part worth reusing.

## Stock Mindcraft vs PincerCraft

| | Stock | PincerCraft |
|---|---|---|
| Inventory & recipes | LLM eyeballs them | computed in code |
| "Task done?" | validated for its own pre-specified benchmark tasks; the agent's word in open-ended play | measured against world state, always |
| A bad plan | runs, fails, retries | bounced with a fix |
| Agent loop | re-prompts on every line | parks until something changes |
| Bot rules | config file | staple CoC + in-world editable house rules |
| Getting better | you edit the code | it drafts its own patches, you review |

On that second row, precisely: upstream Mindcraft *does* check the world — `src/agent/tasks/tasks.js` counts inventory against a hand-written `requiredQuantities` and returns a real verdict. It works because a human wrote the answer key in advance for a fixed task suite. Open-ended play has no answer key: the task and its success criterion are both generated at runtime, so there is nothing to hand-write a validator against, and self-report becomes the label by default. That is the gap this repo measures — and the honor system it caught was **its own**, not upstream's. No number on this page is a comparison against stock Mindcraft; the ablation compares this bot to itself with the harness removed.

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
