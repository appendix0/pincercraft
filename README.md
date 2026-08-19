<h1 align="center">PincerCraft</h1>

<p align="center">
  <img src="banner.webp" alt="PincerCraft — code owns the facts, the LLM owns the plan" width="640">
</p>

<p align="center"><b>Code owns the facts. The LLM owns the plan.</b><br>A Minecraft agent with a deterministic backbone, built for open-world, long-horizon tasks. A Mindcraft fork.</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT">
  <img src="https://img.shields.io/badge/fork%20of-Mindcraft-informational" alt="Fork of Mindcraft">
  <img src="https://img.shields.io/badge/lies%20to%20itself-no-brightgreen" alt="Lies to itself: no">
  <img src="https://img.shields.io/badge/false%20success-3.8%25%20on%20·%2045.1%25%20off-blueviolet" alt="False success: 3.8% with the harness, 45.1% without">
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

The distance between what an agent *says* it did and what the world's ledger *shows* — the **say-do gap** — is the problem this repo exists to close. The confirmatory campaign ran 13 benchmark tasks × 4 replicates across 7 arms — **356 scored attempts**, one model held fixed, under a [pre-registration](docs/paper/preregistration.md) frozen before collection. Every attempt is graded by a deterministic scorer from the world-state delta; the model's own "done!" counts for nothing:

| | claimed "done" | the world agreed | **false success** |
|---|---|---|---|
| **Harness on** | 71.2% | **67.3%** | **3.8%** |
| **Harness off** | 74.5% | **29.4%** | **45.1%** |

**With the harness off, the agent claimed success on 74.5% of attempts and achieved 29.4%.** False success falls 45.1% → 3.8% (−41.3pp, 95% CI [−60.8, −23.1], p < 0.0001); task success rises 29.4% → 67.3% (+37.9pp, 95% CI [+20.2, +56.9], p < 0.0001). All 23 discordant claimed-vs-verified pairs in the off arm run the same way — the agent overstating, never the reverse.

Same model, same prompts, same tasks, same server — the only variable is whether code or the LLM owns the facts. The gap is a loop-design problem, not a model problem, which means a bigger model won't close it and a scorer will. (The scorer itself was calibrated against blind human labels first: 67/68, 98.5%.) Full tables, caveats included, in [Receipts](#receipts).

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
| Apex — calibration | blind human verdicts (`gold_attempts`) | 68 comparable | certifies the scorer (**67/68, 98.5%**, Wilson 95% [92.1, 99.7]) |
| Middle — scale | scorer labels from world-state delta (`task_attempts`) | **356 of 356** | cheap, automated, trustworthy *because* calibrated |
| Base — raw | the model's own honor-system word | 0 in the primary set | the counter-exhibit — **0/5** agreement with blind human labels, across both eras |

**How the apex count works**, since the table above is the number a reader will check. `gold_attempts` holds **92** human-judged rows, but they are not all calibration. **85** carry an `agree:task_id=N` tag binding the verdict to one specific attempt; the other 7 are curated examples that certify nothing. Which set a label belongs to is a property of **when it was recorded**, not of the attempt it judges — pilot labels are pilot because they helped develop the grammar they test, so [the pre-registration](docs/paper/preregistration.md) §5 forbids pooling them. Split accordingly, and reported as a 2×2, never as one total:

| set | scorer-measured | honor-system |
|---|---|---|
| **post-freeze (the anchor)** | **67/68 = 98.5%** | 0/1 |
| pilot (*never pooled*) | 11/12 = 91.7% | 0/4 |

The gate set in advance was ≥ 90% agreement with a Wilson lower bound above 75%. **PASS** at 98.5% / 92.1%. The pilot's lower bound was 64.6% — *"your scorer might only be right two-thirds of the time"* was a live objection at that width; the post-freeze floor is 92.1%. Only tagged rows are calibration, and only `eval/agreement.py label` writes them — `eval/gold_add.py` adds curated rows to the same table and does not touch the agreement math.

**The one disagreement is the honest part.** It is the 5×5 platform — the only structure-scored criterion in the set, where the human called a success and the block-scan scorer called a failure. Every inventory-delta criterion agreed. So the calibration is strong on the criterion class carrying 12 of the 13 tasks and demonstrably weaker on the one that isn't, which is a stated limitation rather than something averaged away. Dropping that task entirely makes both headline effects **larger** (§ Robustness in [results.md](docs/paper/results.md)) — including it is the conservative choice.

**The apex closed the gap it used to have.** An earlier version of this section warned that the middle tier was ~13× the comparable apex and that campaign figures were "reported as uncertified". Two blind-labelling passes have since landed (2026-08-08, n=40; 2026-08-16, n=29), drawn from the confirmatory campaign itself. That warning no longer applies.

This matters beyond the labels: any metric *derived* from a verified success — cost per verified success, the say-do gap itself — inherits the apex dependency. Only raw instrument readings (tokens per run, wall clock) stand outside the pyramid, because the model never self-reports them.

The confirmatory campaign below is the pyramid's output: 13 tasks, 7 arms, built entirely on the calibrated middle tier. All three tiers, raw: [`Appendix0/pincercraft-say-do-gap`](https://huggingface.co/datasets/Appendix0/pincercraft-say-do-gap) on Hugging Face.

### The confirmatory campaign — 7 arms, 356 attempts (2026-08-15)

The benchmark that supersedes Field Trial v1: **13 fixed tasks × 4 replicates × 7 arms**, one model held fixed (`claude-sonnet-4-6`, planner and coder), one commit per comparison, under a [pre-registration](docs/paper/preregistration.md) frozen 2026-08-09 — hypotheses, endpoints, thresholds, exclusion and stopping rules all written before collection. Arm order and task order are independently shuffled per replicate. Inventory is cleared and a fixed kit re-issued before every attempt. Player-safety — the stop reflex, the death handler, the code of conduct — stays on in every arm and is never ablated.

| arm | n | task success | claimed | **false success** |
|---|---|---|---|---|
| **full harness** | 52 | **67.3%** | 71.2% | **3.8%** |
| **no harness** | 51 | **29.4%** | 74.5% | **45.1%** |
| − perception | 52 | 59.6% | 63.5% | 3.8% |
| − preconditions | 52 | 63.5% | 65.4% | 1.9% |
| − reflexes | 51 | 58.8% | 58.8% | 2.0% |
| − completion check | 46 | 54.3% | 71.7% | 17.4% |
| − deterministic termination | 52 | 65.4% | 67.3% | 5.8% |

**The single most important row is `no harness`: it claimed success on 74.5% of attempts and achieved 29.4%.** McNemar exact on claimed-vs-verified gives p = 2.4 × 10⁻⁷ for that arm and every one of its 23 discordant pairs runs the same way — the agent overstating its own success, never the reverse. A symmetric error would produce pairs in both directions. This one has a sign.

**What the false successes actually are.** They concentrate where the starting kit already held the goal item: **18 of 22 (82%)**, against 36% of true completions (Fisher p = 0.0112). Twenty-one of the 22 produced *literally zero gain* on the target item — `needed +12 stick, had 96, gained 0 → claimed done`. The agent was not deprived of the facts: under ablation it still receives its inventory every turn. It had the number in front of it and read an absolute quantity as if it were the required net gain.

So we removed the cause instead of arguing about it. A **pre-declared** follow-up re-ran the six affected tasks unharnessed with only that task's target item stripped from the kit — every enabler kept, the work required unchanged:

| no harness, same six tasks | false success |
|---|---|
| kit supplies the target item | **18/24 = 75%** |
| target item removed from the kit | **0/24 = 0%** |

**Fisher exact, two-sided: p < 0.0001.** The decision rule (≤33% confirms / 34–49% inconclusive / ≥50% refutes) was written before any attempt ran and is applied in code. Twenty of the 24 succeeded, most overshooting the ask. The four that failed did so *openly* — three timeouts and a cancel — and **not one of them claimed completion**. With an empty bag the agent either did the work or failed without reporting success.

**Why no single layer gets the credit.** Our pre-registered per-layer hypothesis **failed**, and that is reported as it came out: no single-layer ablation moved its target failure category by the pre-declared 15 points after multiplicity correction. Splitting every arm on the same variable shows why — removing any *one* layer leaves the failure at or near zero, and only removing *all five* produces 75%. The harness is **redundant** on this failure mode: one trigger, five independent guards, any one of which suffices. That redundancy is exactly what makes each layer individually undetectable. Defence in depth and per-component attribution are in tension, and a builder should want the former.

**Cost tells the same story.** Per run the two whole-harness arms are indistinguishable — 89.6k vs 90.4k input tokens. Per unit of work that actually happened, the harness is **2.3× cheaper** (133k vs 307k input tokens per verified success), because the ablated arm spends tokens on attempts that produce nothing and then declares victory. Tokens-per-run and tokens-per-verified-success rank the arms differently, and only one of them measures something you would pay for — which is this repo's own thesis applied to its own cost table.

**Fine print, because receipts cut both ways.** A **15.0% infrastructure fault rate**: every fault is a run the rig lost rather than a result, all logged at the time with cause in [aborts.md](docs/paper/aborts.md), and the rate is reported rather than absorbed. The **position reset never fired** — a defect in the RCON client means a teleport the server refuses is indistinguishable from one that worked, so position carried across attempts and randomized arm order is what actually controls it; restricting to replicates where every arm ran in the same region leaves the effect undiminished (12/12 vs 0/12), and it is disclosed as a protocol deviation. Eight attempts recorded **zero steps** and are counted as failures anyway; excluding them makes both effects *larger*, so they stay in. Three arms hold fewer than 52 attempts. And the 45.1% absolute rate is **conditional on a kit that makes stock/flow confusion available** — both arms got the identical kit so the comparison is sound, but what transfers to another setting is the failure mode, not the number. **One model, one world, one task family**; nothing here separates the harness effect from properties of either.

Full tables, statistics and limitations: [results.md](docs/paper/results.md). Regenerate every number yourself with `python3 eval/campaign_report.py`.

> **Field Trial v1 (2026-07-19, 9/9 vs 1/9 over ten tasks) is superseded** by the campaign above and is no longer quoted here. It was a two-arm pilot on an uncalibrated apex, with the platform row scored on the honor system. Its receipts are untouched in `docs/receipts/` and in git history — superseded, not deleted.

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
| Scorer calibrated against blind human labels (67/68) | *no widely adopted counterpart* | — |

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
