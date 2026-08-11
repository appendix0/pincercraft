# Related work and terminology audit

Run 2026-08-10, before the confirmatory campaign resumed and before any claim
was written up. Purpose: find out what the field already calls our phenomena and
what it has already shown, so the paper claims what is actually left.

**Headline: two of the three things we were treating as our contribution are
already published, at larger scale than we can reach.** The intervention is
what remains, and it is a better paper than the one we were going to write.

---

## 1. The phenomenon is established and already named

**"From Confident Closing to Silent Failure: Characterizing False Success in
LLM Agents"** — [arXiv:2606.09863](https://arxiv.org/abs/2606.09863)

The field's term is **false success**: the agent asserts task completion when
the environment state shows otherwise. Measured over **9,876 tau2-bench
trajectories across 8 model families** and **1,879 AppWorld trajectories across
4 families**. False success accounts for **45–48%** of failures in single-control
domains, **3%** in dual-control telecom, and **75.8%** among self-assessing
coding trajectories. Per-model rates span 13% to 89%.

Their contribution is **detection**: LLM judges do poorly (max AUROC 0.65 on
tau2-bench, 0.54 on AppWorld) while lightweight TF-IDF detectors reach AUROC
0.83–0.95, recovering 4–8× more false successes than the best judge at equal
flag rate and 3,300× lower latency.

**Consequences for us.** We cannot claim to have discovered, named, or first
quantified this. Our 33% in the ablated arm is a small number next to theirs and
is not the paper's news. What they do *not* do: ablate a harness, distinguish
capability failure from reporting failure, or intervene — they characterise and
detect after the fact.

## 2. The two-axis dissociation is also established

**"Done, But Not Sure: Disentangling World Completion from Self-Termination in
Embodied Agents"** (VIGIL) —
[arXiv:2605.08747](https://arxiv.org/abs/2605.08747)

This is the closest paper to our §5.1 and it precedes us. It separates **world
completion (W)** — achieving the target state — from **self-termination** —
recognising completion and closing the episode with an accurate report. Twenty
models, 1,000 frozen episodes, egocentric RGB, deterministic semantic report
checking.

It demonstrates the dissociation directly: **agents with nearly identical W
differ by up to 19.7 points in benchmark success**, some converting achieved
states into correct reports while others drift past the goal without closing.

Their four outcome categories map almost one-to-one onto ours:

| VIGIL | ours (terminology.md §5) |
|---|---|
| verified success | true completion |
| unsupported commitment | **false completion** |
| post-attainment drift | **reached-not-recognized** |
| missed execution | capability failure |

**Consequences for us.** The claim I called "strong and novel — the best
structural point" is neither novel nor ours. terminology.md §5.1 must stop
implying priority, and the paper needs this as a citation, not a finding.

**What is still different:** VIGIL varies the **model** with the scaffold fixed.
We vary the **harness** with the model fixed. Their dissociation is across
agents; ours would be within one agent, produced by a layer we can switch off.
That is a different experiment about a different cause, and it is the one that
tells a builder what to build.

## 3. Scaffold decomposition exists, but not the controlled version

**"Where Does Agent Reliability Come From? A Cross-Benchmark Decomposition of
Verification Loops, Specialist Models, and Scaffolding in a Production
Enterprise Agent"** — [arXiv:2607.17044](https://arxiv.org/abs/2607.17044)

Decomposes reliability across scaffolding, routing, specialists and a
verification loop. On SpreadsheetBench the loop contributes **+1.5 pp** against
scaffolding's +9.5 pp of an +11.0 pp uplift; verifier confusion matrix catch
rate ≈0.20, fix rate ≈0.75, false-alarm ≈0. A specialist-swap ablation shows
**observer identity matters** — replacing the small trained verifier with the
frontier model that generated the artifact eliminates most rescues, which they
attribute to self-assessment bias.

Two things matter here. First, their verification loop is measured on **task
success**, where it looks marginal (+1.5 pp) — the same shape as our own H2, and
a useful corroboration that success is the wrong endpoint for a verification
layer. Second, their **stated limitations name our design**:

- "No controlled same-model scaffold ablation: missing ReAct/CRITIC-style
  baselines at matched compute"
- vendor evaluation — "an evaluation of Leni by Leni's builders"
- single scored runs; preliminary ablations covering two of four specialists
- proprietary weights, corpus and prompts not released

We have the controlled same-model ablation, repeated shuffled backtests, an
independent referee, and open receipts. That is the gap, stated by the closest
prior work itself.

## 4. Supporting context

- **"Why Do Multi-Agent LLM Systems Fail?"** —
  [arXiv:2503.13657](https://arxiv.org/abs/2503.13657). The MAST taxonomy puts
  premature termination at **6.2%** of multi-agent failures. Useful for showing
  the phenomenon is taxonomised across settings, at very different rates.
- **Voyager** — [arXiv:2305.16291](https://arxiv.org/abs/2305.16291). The
  canonical Minecraft agent, and the cleanest illustration of why this matters
  in our arena: tasks are **self-verified by a critic agent**, and code the
  critic declares successful is stored permanently in the skill library. A wrong
  judgment contaminates the library and the error propagates on reuse. This is
  the honor-system failure with a compounding mechanism attached.
- **Aegis** — [arXiv:2508.19504](https://arxiv.org/abs/2508.19504),
  agent-environment failure taxonomy.
- **StressWeb** — [arXiv:2604.16385](https://arxiv.org/abs/2604.16385). Agents
  are miscalibrated between claimed and actual success even in clean
  environments, and perturbations amplify it. Supports our decision to hold the
  start state fixed and to report the arm-position confound.

## 4.5 The environment class is load-bearing, not a convenience

**Why this project runs in an open world, and why that is part of the claim
rather than a detail of the setup.**

Every large false-success measurement above was taken where **verifying ground
truth is cheap**: tau2-bench checks a database row, AppWorld checks an API
result, SpreadsheetBench checks a cell against an exact match. Those settings
establish that the phenomenon exists and is common. They say nothing about the
setting where verification is *itself the hard part* — and that is the setting
that matters for anything acting in the physical world.

An open world differs on every axis that makes verification expensive:

| | API / tool benchmarks | open world |
|---|---|---|
| action space | enumerable, documented | effectively unbounded |
| ground truth | look up a row, run a test | must independently read world state |
| horizon | short, few dependencies | long, with tool and material chains |
| agent's priors | API docs describe the affordances | affordances must be discovered |
| failure | terminal | normal, and recovering from it is part of the task |

**And in this class, the field still runs on the honor system.** Voyager's tasks
are self-verified by a critic agent, and critic-approved code enters the skill
library permanently — a wrong judgment contaminates the library and the error
compounds on every reuse. Luban ([arXiv:2405.15414](https://arxiv.org/abs/2405.15414))
builds on "autonomous embodied verification". MineEvolve
([arXiv:2603.13131](https://arxiv.org/abs/2603.13131)) distils *successful*
executions into reusable skills — success as judged by the agent's own loop.
There is movement toward external scoring — MineExplorer
([arXiv:2605.30931](https://arxiv.org/abs/2605.30931)) uses rule-based milestone
evaluators — but it scores *exploration*, not the claimed-versus-verified gap.

So the two literatures have not met. The papers that measure false success do it
where checking is easy; the papers working where checking is hard still let the
agent grade itself. **We found no work measuring the claimed-versus-verified gap
in an open world, and none ablating a harness to see which layer closes it.**
(Stated as a search result, not a proof of absence — this field is moving fast.)

**Why it generalises past the game.** Physical AI lands in exactly this class:
open, unfamiliar, no API to ask "did I succeed". An agent that cannot tell
whether it succeeded is a different kind of problem once it has a body — the
failure does not stay inside a shell. Minecraft is the arena because it is the
cheapest environment with the real property (unbounded actions, expensive ground
truth, long horizons, recovery-from-failure as part of the task), not because
the target is a better Minecraft bot.

This also answers the case-study objection in §6: one environment, yes — but
deliberately the one where the existing results do not already apply.

## 5. Terminology decisions forced by this audit

The standing rule is one name per concept. Where the field has already fixed a
name, findability beats our coinage — a paper that invents a synonym for
"false success" is a paper nobody searching for false success will find.

| our term | field term | decision |
|---|---|---|
| false completion | **false success** (2606.09863) | **Adopt "false success" as primary** in the manuscript; keep `false_completion` as the code identifier and note the synonym once. The standing rule already separates prose from identifiers. |
| task success (the *do* axis) | **world completion** (VIGIL) | Keep "task success" — it is what our referee measures — but cite VIGIL's W on first use so the mapping is explicit. |
| self-report accuracy (the *say* axis) | **self-termination** (VIGIL) | VIGIL's term is narrower (it is about closing the episode). Keep ours, define it against theirs. |
| reached-not-recognized | **post-attainment drift** (VIGIL) | Adopt theirs on first use, then ours. Ours is more literal; theirs is citable. |
| capability failure | **missed execution** (VIGIL) | Same treatment. |
| harness | scaffold / scaffolding | Unchanged — terminology.md §1 already reserves *scaffolding* for other people's systems, which is now clearly the right call since the scaffold-decomposition literature uses it. |

## 6. What the paper can and cannot claim

| claim | status after the audit |
|---|---|
| Self-reported completion is unreliable at a measurable rate | **Established prior work.** Cite 2606.09863. Not ours. |
| Capability and self-report are separable axes | **Established prior work.** Cite VIGIL. Not ours. |
| A deterministic harness drives false success to ~0 in a fixed model | **Open.** This is the paper. |
| Per-layer ablation localises *which* layer does it | **Open, and nobody has run it** — 2607.17044 lists its absence as a limitation. |
| Verification looks marginal on success and decisive on false success | **Open, and corroborated** by 2607.17044's +1.5 pp on task success. Strong framing: the field measured the right layer on the wrong endpoint. |
| The gap has been measured where ground truth is cheap, not where it is expensive | **Open.** §4.5 — the two literatures have not met, and open-world agent practice still self-verifies. |

**The repositioning.** We are not writing a measurement paper that discovers a
gap. We are writing an **intervention paper**: the gap is known, its detection is
known, and what is missing is a controlled demonstration that a deterministic
layer under a fixed model removes it — with the per-layer ablation saying which
part did the work, on the endpoint each layer actually targets, **in an
environment where establishing ground truth is expensive** (§4.5).

The last clause is not garnish. Drop it and the paper is a small replication in
a game; keep it and the paper is about the setting the existing results do not
cover, which is the setting an embodied system actually operates in.

That is a smaller claim than "we found the say-do gap" and a much more
defensible one. It also survives the reviewer who knows this literature, which
the previous framing would not have.

## 7. Actions

- [ ] Rewrite terminology.md §5.1 to cite VIGIL rather than imply priority.
- [ ] Adopt "false success" as the manuscript's primary term; map it to
      `false_completion` once, in the terminology table.
- [ ] Write the related-work section from this file.
- [ ] Reframe the paper's contribution as an intervention with a per-layer
      ablation, not as the discovery of the phenomenon.
- [ ] Re-check this audit after the confirmatory campaign: this field is moving
      fast and three of the six papers here are from 2026.
