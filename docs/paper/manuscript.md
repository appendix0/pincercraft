# Do the Subtraction in Code

### Closing the say–do gap with a deterministic harness: a controlled same-model ablation in an open world

**Draft v0.1 — 2026-08-19. Not submitted. Not reviewed.**

> **Status.** This is the first full-manuscript draft. Every number in it was
> regenerated from the receipt database on 2026-08-19 via
> `python3 eval/campaign_report.py`, `eval/agreement.py report` and
> `eval/stock_strip_report.py`; none is transcribed from a prior document.
> Supporting documents: [preregistration.md](preregistration.md) (frozen
> 2026-08-09), [protocol.md](protocol.md), [terminology.md](terminology.md),
> [related_work.md](related_work.md), [results.md](results.md),
> [aborts.md](aborts.md).
>
> **Open before submission:** author list and affiliation, and human verification
> of all six arXiv citations (§11.4). Closed since v0.1: the
> `paper/doc-audit-and-stock-strip` branch that §7 depends on was merged
> 2026-08-19 (`7455717`), and the §5 calibration discrepancy was resolved by
> regenerating `results.md` §2 the same day (`79356fc`) — see §5.3.

**Authors:** *[TO BE COMPLETED]*
**Correspondence:** *[TO BE COMPLETED]*

---

## Abstract

LLM agents report success they have not achieved. The phenomenon is established
and named — *false success* — but every large measurement of it has been taken
where verifying ground truth is cheap: a database row, an API response, a
spreadsheet cell. In those settings verification is a lookup. In an open world
it is the engineering problem, and there the practice of the field is still to
let the agent grade itself.

We report a controlled ablation of a deterministic harness beneath a fixed model
in an open world (Minecraft), scored by an external instrument the agent cannot
see or influence. Seven arms — the full harness, the harness with every layer
removed, and five single-layer ablations — were run over 13 tasks × 4
replicates, 356 attempts in the primary set, one model, one commit per
comparison, under a pre-registration frozen before collection.

With every layer removed, the agent **claimed success on 74.5% of attempts and
achieved 29.4%**. False success fell from **45.1% to 3.8%** with the harness on
(−41.3 pp, 95% CI [−60.8, −23.1], *p* < 0.0001); task success rose from 29.4% to
67.3% (+37.9 pp, 95% CI [+20.2, +56.9], *p* < 0.0001). All 23 discordant
claimed-vs-verified pairs in the unharnessed arm run the same way — the agent
overstating its own success, never the reverse.

The pre-registered per-layer hypothesis **failed**: no single-layer ablation
moved its target failure category by the pre-declared 15 points after multiplicity
correction, and the whole-harness effect is more than three times the largest
single-layer effect. A post-hoc mechanism analysis, followed by a pre-declared
manipulation, explains why. The failures concentrate where the starting kit
already contained the goal item (75% of such attempts) — the agent reads an
absolute inventory quantity as if it were the required net gain. Removing only
that item from the kit drives false success to **0/24 from 18/24** (*p* <
0.0001). Splitting every arm on the same variable shows the failure has one
trigger and five independent guards: removing any single layer leaves it at or
near zero, and only removing all five produces 75%. The harness is redundant on
this failure mode, and that redundancy is precisely what makes no individual
layer detectable.

Per run, the harnessed and unharnessed arms cost the same (89.6k vs 90.4k input
tokens). Per unit of work that actually happened, the harness is **2.3× cheaper**
— which is the paper's own thesis applied to its own cost table.

The intervention is not to give the model more data. Under ablation the agent
already receives its inventory every turn. The intervention is to **do the
subtraction in code, and refuse the claim when the subtraction fails.**

---

## 1. Introduction

An agent that cannot tell whether it succeeded is a different kind of problem
from an agent that fails. A failure is visible and recoverable. A false report
is neither: it terminates the episode, enters whatever memory or skill library
sits downstream, and is consumed by the next decision as fact.

The field has established that this happens and how often. Its term is **false
success** — the agent asserts completion when the environment state says
otherwise — and it has been characterised at scale: 45–78% of failures depending
on setting, across thousands of trajectories and dozens of model families
[1]. A second line of work has separated the two axes that make it possible:
*world completion* (did the target state occur) from *self-termination* (did the
agent recognise it and close the episode accurately), showing agents with nearly
identical world completion differing by up to 19.7 points in benchmark success
[2]. We claim neither of these results. They are prior work, at a scale we
cannot reach, and this paper cites them rather than rediscovering them.

What has not been established is what to *do* about it, under controlled
conditions, in the setting that matters.

**Where the existing measurements were taken.** Every large false-success
measurement above comes from an environment where verifying ground truth is
cheap: tau2-bench checks a database row, AppWorld checks an API result,
SpreadsheetBench checks a cell against an exact match [1,3]. Those settings
establish that the phenomenon exists and is common. They say nothing about the
setting where verification is *itself* the hard part.

An open world differs on every axis that makes verification expensive. The
action space is effectively unbounded rather than enumerable and documented.
Ground truth must be independently read out of the world rather than looked up.
Horizons are long, with tool and material dependency chains. Affordances must be
discovered rather than described by an API reference. And failure is normal
rather than terminal — recovering from it is part of the task.

**And in that class, the field still runs on the honor system.** Voyager's tasks
are self-verified by a critic agent, and critic-approved code enters a permanent
skill library, so a wrong judgment contaminates the library and the error
compounds on every reuse [4]. Luban builds on "autonomous embodied verification"
[5]. MineEvolve distils *successful* executions into reusable skills — success as
judged by the agent's own loop [6]. There is movement toward external scoring —
MineExplorer uses rule-based milestone evaluators [7] — but it scores
exploration, not the claimed-versus-verified gap.

So the two literatures have not met. The papers that measure false success do it
where checking is easy; the papers working where checking is hard still let the
agent grade itself. We found no work measuring the claimed-versus-verified gap
in an open world, and none ablating a harness to see which layer closes it.
(Stated as a search result, not a proof of absence.)

**Why the environment class is the claim, not the setting.** Minecraft is not
the target. It is the cheapest arena that has the real property — unbounded
action space, expensive ground truth, long horizons, recovery-from-failure as
part of the task. Anything acting in the physical world lands in exactly this
class: open, unfamiliar, with no API to ask *did I succeed*. Drop the
environment-class clause and this paper is a small replication in a game; keep it
and it is about the regime the existing results do not cover.

### 1.1 Contributions

1. **A controlled same-model harness ablation.** Prior work varies the model with
   the scaffold fixed [2]; we vary the harness with the model fixed. The closest
   scaffold-decomposition paper names "no controlled same-model scaffold
   ablation" among its own stated limitations [3]. This is that experiment.
2. **The endpoint argument.** A verification layer measured on task success looks
   marginal — [3] reports +1.5 pp for its verification loop, and our own
   per-layer analysis reproduces the shape. Measured on false success, the same
   class of layer is decisive. The field has been measuring the right component
   on the wrong endpoint.
3. **A causal mechanism, pre-declared and manipulated.** We identify what the
   false successes are made of (§7.1), then remove the cause by manipulation
   rather than by argument (§7.2), under a decision rule written before the
   attempts ran.
4. **A negative result, explained rather than buried.** Our pre-registered
   per-layer hypothesis failed. §7.3 shows why: the harness is redundant on this
   failure mode, so no single layer is individually detectable — a property of
   the system, not an absence of effect.
5. **An instrument, calibrated against blind human judgement, with the
   counter-exhibit attached.** The scorer agrees with blind human labels at 98.5%
   (§5). On the same task set, labels taken from the agent's own claim agree with
   blind human judgement **0 times out of 5**.

---

## 2. Related work

**The phenomenon is established and already named.** "False success" is the
field's term for an agent asserting completion the environment contradicts,
measured over 9,876 tau2-bench trajectories across 8 model families and 1,879
AppWorld trajectories across 4 [1]. It accounts for 45–48% of failures in
single-control domains, 3% in dual-control telecom, and 75.8% among
self-assessing coding trajectories, with per-model rates from 13% to 89%. That
paper's contribution is **detection**: LLM judges do poorly (max AUROC 0.65 on
tau2-bench, 0.54 on AppWorld) while lightweight TF-IDF detectors reach AUROC
0.83–0.95 at 3,300× lower latency. We do not claim to have discovered, named, or
first quantified this. Our unharnessed 45.1% is not the news. What [1] does not
do is ablate a harness, separate capability failure from reporting failure, or
intervene — it characterises and detects after the fact.

**The two-axis dissociation is also established.** VIGIL separates world
completion from self-termination over 20 models and 1,000 frozen episodes with
deterministic semantic report checking [2], and its four outcome categories map
almost one-to-one onto our taxonomy (§4.4): *verified success* → true
completion, *unsupported commitment* → false success, *post-attainment drift* →
reached-not-recognized, *missed execution* → capability failure. We adopt the
mapping and cite it as a finding of theirs. What differs is the manipulated
variable: VIGIL's dissociation is **across agents**, produced by varying the
model; ours is **within one agent**, produced by a layer we can switch off. That
is a different experiment about a different cause, and it is the one that tells a
builder what to build.

**Scaffold decomposition exists, but not the controlled version.** [3] decomposes
production-agent reliability across scaffolding, routing, specialists and a
verification loop, reporting +1.5 pp for the loop against scaffolding's +9.5 pp
of an +11.0 pp uplift, with verifier catch rate ≈0.20 and false-alarm ≈0. A
specialist-swap ablation shows observer identity matters — replacing the small
trained verifier with the frontier model that generated the artifact eliminates
most rescues, attributed to self-assessment bias. Two things matter here. Their
verification loop is measured on **task success**, where it looks marginal — the
same shape as our own H2 discussion in §6.4 — and their stated limitations name
our design: no controlled same-model scaffold ablation, vendor evaluation, single
scored runs, closed weights and prompts.

**Supporting context.** The MAST taxonomy places premature termination at 6.2% of
multi-agent failures [8], showing the phenomenon is taxonomised across settings
at very different rates. StressWeb finds agents miscalibrated between claimed and
actual success even in clean environments, with perturbations amplifying it [9] —
which is part of why we hold the start state fixed and report our
position-reset deviation (§9.3) rather than assuming it away.

**Terminology.** Where the field has fixed a name, findability beats our coinage.
This manuscript says **false success**; the repository and code keep
`false_completion` as the identifier, and the two are the same concept.
Similarly: *post-attainment drift* on first use for our reached-not-recognized,
*missed execution* for capability failure. We reserve *scaffolding* for other
people's systems and use **harness** for ours throughout.

---

## 3. The system under test

The harness is the deterministic layer beneath the LLM. Its design rule is one
sentence: **code owns facts, the model owns plan and judgment.** It is not a
planner, not a policy, and not a safety wrapper. It is five independent layers,
each of which can be switched off individually:

| layer | what code takes over |
|---|---|
| **perception** | Tells the model what it can currently craft (`CAPABILITIES`) and how far along it is (`TASK-PROGRESS`, the delta from the task's own start snapshot). |
| **precondition** | Refuses actions that cannot work: craft preflight, redundant-acquire. |
| **reflex** | Acts without asking: tool-break guard, inventory tidy. |
| **grounded completion check** | Blocks a completion claim the world state does not support. Never closes a task. |
| **deterministic termination** | Closes a task in code once the world state satisfies the criterion. Never blocks anything. |

Two naming points are load-bearing. **Deterministic termination** is named
against [2]: VIGIL's *say* axis is self-termination — the agent failing to close
an episode it has in fact completed — and this layer is its exact contrast. The
mechanism is the pairing: *the model's self-termination fails, so the harness
supplies deterministic termination.* And the **precondition layer is never called
a safety layer.** Player-facing safety — the stop reflex, the death handler, the
code of conduct — is a separate concern that is **never ablated in any arm**.
Nothing in this paper removes a safety property.

**What ablation does not remove.** Under full ablation the agent still receives
`SELF / INVENTORY / NEARBY` every turn, at parity with the upstream system this
fork derives from. What the perception layer adds on top is `TASK-PROGRESS` and
`CAPABILITIES`. This matters for interpreting §7: the unharnessed agent is not
deprived of its inventory count. It has the number and misreads what the number
means.

---

## 4. Method

### 4.1 Design

Seven arms, 13 tasks, 4 replicates, one model, one commit per comparison.

| arm | condition | design n |
|---|---|---|
| **full harness** | every layer on, as shipped | 52 |
| **no harness** | every layer off | 52 |
| **− perception** | perception layer removed | 52 |
| **− preconditions** | precondition layer removed | 52 |
| **− reflexes** | reflex layer removed | 52 |
| **− completion check** | grounded completion check removed | 52 |
| **− deterministic termination** | deterministic termination removed | 52 |

`no harness` is the control, not stock upstream. An earlier design included a
stock-upstream baseline and it was dropped deliberately: this fork has diverged
far enough — orchestrator, prompts, task queue, skill layer — that any
full-harness-minus-upstream difference would be unattributable to the harness,
which is the only variable this study is about. `no harness` holds the model,
prompts, task queue and tasks fixed and removes exactly the thing under test.
The cost of that choice is stated in §11.2.

### 4.2 Environment, tasks and starting state

Runs target a dedicated evaluation world, never a live one, with no human player
present during a batch. The benchmark is 13 tasks across four difficulty tiers,
from *mine 16 cobblestone* through *craft an iron pickaxe* — the longest
prerequisite chain in the set (wood → planks → sticks → stone pickaxe → iron ore
→ furnace + fuel → ingots → pickaxe). Twelve criteria are inventory-shaped; one,
a 5×5 cobblestone platform, is deliberately not, and is scored by a block-scan
scorer over RCON.

**Every criterion is a net gain measured from a per-attempt snapshot.** "+16
cobblestone" requires mining 16 with whatever is already in the bag. Before every
attempt the runner clears inventory, issues a fixed kit, and — by design, though
see §9.3 — returns the bot to a pinned position. The kit is:

> 96 cobblestone, 16 oak_log, 96 stick, 48 oak_planks, 8 coal, 1 stone_pickaxe,
> 1 stone_axe, 1 crafting_table

composed as *one of each enabler, the observed campaign median of each
consumable*. Enablers are not set to their observed medians: the median agent
held six stone pickaxes, an artifact of the carry-over defect this reset exists
to remove, and reproducing it would bake the bug into the control.

The kit is identical for every arm and every attempt, and **nothing in it can
satisfy a criterion**. This property is deliberate, was written into the runner
before collection began, and turns out to be where the mechanism lives (§7).

The environment is genuinely open rather than a box: 321 distinct start positions
across 496 attempts, in 8 biomes actually stood in, with 15 attempts roaming more
than 50 blocks (max 964).

### 4.3 The instrument

The scorer is deterministic code that takes its own world-state snapshots and
scores every arm **from outside the agent**. It is not a harness layer and is
**never ablated** — ablating the scorer would remove the measurement rather than
vary a condition. In the `no harness` and `− completion check` arms the agent's
*own* finish verification is disabled while the external scorer still computes
the verdict out of band. That distinction is the whole design.

Where a criterion is not machine-checkable the pipeline falls back to the
**honor system**: the agent's own claim becomes the label. Honor-system rows are
never pooled with scored rows. They are the counter-exhibit (§5.2).

Every attempt carries three independent signals, never collapsed: the **agent
claim** (did the model declare completion), the **harness decision** (did a layer
block or fire), and the **scorer verdict** (did the world change as required).

### 4.4 Outcome taxonomy

Derived downstream from immutable receipts, never stored, so the rule stays
revisable:

| outcome | agent claim | scorer | meaning |
|---|---|---|---|
| **true completion** | done | success | Worked, and said so. |
| **false success** | done | fail | Claimed success it did not achieve. *The phenomenon.* |
| **reached-not-recognized** | not done | success | Achieved the goal and never noticed. |
| **capability failure** | not done | fail | Tried, gave up, genuinely unmet. |
| **budget exhaustion** | not done | fail | Ran out of time with the goal unmet. |
| **infrastructure** | — | — | The rig failed, not the agent. Excluded, and reported as a rate. |

This is a 2×2 of (claim × verdict) with one cell split by cause, not six
independent outcomes.

Two derived quantities are reported side by side and must not be confused. The
**say–do gap** is (b − c)/n, where b = claimed but not verified and c = verified
but never claimed; it is an aggregate, and the two cancel. **False success** is
b/n; it is the endpoint, and it does not cancel. They are equal only when c = 0.

### 4.5 Pre-registration and protocol

Hypotheses, endpoints, thresholds, exclusion rules and stopping rules were frozen
before collection.

| | hypothesis | fails if |
|---|---|---|
| **H0** *(gating)* | The scorer agrees with blind human judgement at ≥ 90%, Wilson 95% lower bound > 75%. | Lower bound ≤ 75% — the instrument is untrustworthy, H1–H4 are uninterpretable, and the paper reports the calibration failure instead. |
| **H1** | Self-reported success exceeds scorer-verified success on identical attempts. | Gap ≤ 0, or its CI spans 0. |
| **H2** | Task success is higher with the harness on than off. | ON ≤ OFF, or CI spans 0. |
| **H3** | The say–do gap is smaller with the harness on than off. | Gap(ON) ≥ Gap(OFF). |
| **H4** | At least one individual layer produces a detectable drop when removed alone. | No single-layer ablation differs from full-ON beyond noise. |

Fixed configuration: `claude-sonnet-4-6` as both planner and coder model,
`max_tokens` 2000, 5-minute code timeout, 480 s per-attempt budget, 13 tasks,
scorer never ablated. Arm order and task order are independently shuffled per
replicate, with `arm_position` recorded on every attempt; the replicate is the
outer loop so multi-day drift hits all arms roughly equally.

**Per-layer arms are scored on the failure category each layer targets, not on
overall success.** The grounded completion check is scored on false success;
deterministic termination on reached-not-recognized; perception, precondition and
reflex on task success. This is not a convenience. Overall success dilutes a
layer across every run where its failure mode never arises: separating the
completion check from deterministic termination *on success* needs n ≈ 372 per
arm at 80% power, against 16 for the whole-harness false-success comparison. A
comparison whose required n is not affordable is re-specified onto a sharper
endpoint or reported as a bounded null — never run underpowered and read as a
ranking.

Minimum effect of interest for the per-layer arms: **15 percentage points**,
pre-declared, with Holm–Bonferroni correction across the five comparisons.

Statistics: cluster bootstrap with **task as the resampling unit**, 10,000
resamples; Wilson intervals for proportions; McNemar exact for claimed-vs-verified
within the same attempts; Fisher exact for 2×2 contingencies. Zero-event arms are
reported with a one-sided upper bound rather than as "eliminated".

Every attempt is one atomic append-only receipt plus an evidence file. Raw
receipts are immutable; discards are recorded in a separate exclusions table
keyed on attempt id, never by editing an attempt. Every label, derived metric and
statistic is recomputed downstream from raw receipts.

### 4.6 What was collected

| | |
|---|---|
| attempts logged | 496 |
| **primary set** | **356** |
| discarded — infrastructure faults | 63 → **15.0%** |
| superseded by a declared re-run | 77 (not a fault, not in the discard rate) |
| task-level exclusions | none |

The design calls for 364. Eight rows are missing — a bot death, a retry-budget
exhaustion, and three task-queue dedup collisions, all logged at the time — and
they are **not** replaced, because re-running them individually would stamp a
false arm position on rows whose real position is fixed by the replicate's
shuffle.

The 77 superseded rows are replicate 2, re-run whole after credit exhaustion
truncated it. They are valid data replaced by a declared re-run, not rig
failures; pooling them into the discard rate would report 28.2% and invent a
reliability problem we did not have. The 15.0% fault rate is high, and is
discussed in §11.5.

---

## 5. H0 — the instrument, which gates everything else

The pre-registration is explicit: if the scorer does not calibrate against blind
human judgement, H1–H4 are uninterpretable and this paper reports the calibration
failure instead of the results.

A human labeller was shown evidence cards — task description, completion
criterion, inventory, timestamp — and recorded a success call **blind to the arm
and blind to the scorer's verdict**. Cards were printed into a terminal session
one batch at a time. An early version of the card printed the arm name, which
primes a labeller toward failure on ablated arms; that was found and removed
*before* the post-freeze set was collected. Evidence files carry no position
field, which is why some earlier attempts cannot be re-checked in-game
retroactively.

### 5.1 Result

| set | agreement | Wilson 95% |
|---|---|---|
| **post-freeze, scorer-measured** | **67/68 = 98.5%** | **[92.1, 99.7]** |
| pilot, scorer-measured (*not pooled*) | 11/12 = 91.7% | [64.6, 98.5] |
| post-freeze, honor-system | 0/1 | [0.0, 79.3] |
| pilot, honor-system | 0/4 | [0.0, 49.0] |

Cohen's κ on the anchor cell is **0.970**.

**The gate requires ≥ 90% agreement with a Wilson lower bound above 75%. PASS**,
at 98.5% and 92.1%.

Which set a label belongs to is a property of **when it was recorded**, not of
the attempt it judges: the pilot labels are pilot because they developed the
grammar they test, and they are reported beside the anchor and never added to it.
The pilot's lower bound was 64.6% — "your scorer might only be right two-thirds
of the time" is a live reviewer objection at that width. The post-freeze floor is
92.1%.

**The disagreements are informative, because there are only two and they are the
same task.** The one scorer-measured miss is attempt #1043 and the one
honor-system miss is #384 — both the 5×5 platform, the only structure-scored
criterion in the set and the one the block-scan scorer handles. On #1043 the
human, with the evidence in front of them, called it a success and the block-scan
scorer called it a failure. **Every inventory-delta criterion agreed, in both
labelling rounds.**

The calibration is therefore tight on the criterion class that carries 12 of the
13 tasks and demonstrably weaker on the one that does not. That is not a caveat
we assert about the instrument from outside; it is visible inside the calibration
data, it is stated as a limitation in §11.3 rather than averaged away, and §9.1
reports the campaign with that task dropped — which makes both headline effects
larger.

### 5.2 The counter-exhibit

Across both eras, honor-system rows agree with blind human judgement **0 times
out of 5**. Where the label came from the agent's own claim, blind human
judgement disagreed every time.

That is the phenomenon, measured on the instrument that is supposed to be the
alternative to it. It is a small n and it is reported as one — but it is the
cleanest statement in this paper of why an external scorer is not a nicety.

### 5.3 Provenance of this number

The anchor was collected in two blind rounds, and it is worth recording how it
moved, because the paper's claim to trustworthy receipts is exactly the kind of
claim that should be checkable on the paper's own numbers.

The first round (2026-08-08, n = 40) gave **39/39 = 100%**, Wilson [91.0, 100.0],
and that figure stood in `results.md` and in public copy for eleven days. The
second round (2026-08-16, n = 29) drew its attempts from the confirmatory
campaign itself and contained the platform-task disagreement, taking the anchor
to 67/68 = 98.5%. `results.md` §2 was not regenerated at the time and was found
stale on 2026-08-19; it was regenerated the same day, and the superseded figure
is retained there as a dated note rather than swapped out silently.

**The gate passes under every reading of the split** — 67/68 pooled post-freeze,
28/29 restricted to confirmatory-campaign attempts alone (96.6%, Wilson
[82.8, 99.4]), or 39/39 on the first round. No conclusion in this paper turns on
which is chosen. What the episode does illustrate is that a number regenerated
from receipts on demand is recoverable, and a number transcribed into prose is
not: the stale figure survived in a document whose own header promised every
number came from the script.

---

## 6. Results

### 6.1 The headline

| arm | n | task success | 95% CI | claimed | b | c | say–do gap | false success |
|---|---|---|---|---|---|---|---|---|
| **full harness** | 52 | **67.3%** | [53.8, 78.5] | 71.2% | 2 | 0 | 3.8% | **3.8%** |
| **no harness** | 51 | **29.4%** | [18.7, 43.0] | 74.5% | 23 | 0 | 45.1% | **45.1%** |
| − perception | 52 | 59.6% | [46.1, 71.8] | 63.5% | 2 | 0 | 3.8% | 3.8% |
| − preconditions | 52 | 63.5% | [49.9, 75.2] | 65.4% | 1 | 0 | 1.9% | 1.9% |
| − reflexes | 51 | 58.8% | [45.2, 71.2] | 58.8% | 1 | 1 | **0.0%** | **2.0%** |
| − completion check | 46 | 54.3% | [40.2, 67.8] | 71.7% | 8 | 0 | 17.4% | 17.4% |
| − deterministic termination | 52 | 65.4% | [51.8, 76.8] | 67.3% | 3 | 2 | **1.9%** | **5.8%** |

The single most important row is `no harness`: **it claimed success on 74.5% of
attempts and achieved 29.4%.**

The two bolded pairs are the argument for reporting both quantities.
`− reflexes` shows a 0.0% say–do gap while holding one false success and one
unrecognized success — two errors cancelling, not an honest arm. `−
deterministic termination` shows 1.9% against 5.8% for the same reason, and there
the netting hides that layer's *own* target category.

### 6.2 H1 — false success (co-primary)

| arm | false success | 95% CI |
|---|---|---|
| full harness | 2/52 = 3.8% | [1.1, 13.0] |
| no harness | 23/51 = 45.1% | [32.3, 58.6] |

**Difference −41.3 pp, 95% CI [−60.8, −23.1], *p* < 0.0001. H1 supported.**

Note that the full harness's 3.8% is partly by construction: the grounded
completion check blocks unearned finishes by design. The load-bearing number is
the size of the gap in the *ablated* arm, not the smallness of the number in the
harnessed one.

### 6.3 H2 — task success (primary)

**Full harness 67.3% vs no harness 29.4% → +37.9 pp, 95% CI [+20.2, +56.9],
*p* < 0.0001. H2 supported.**

This **reversed** an earlier exploratory null, in the direction predicted in
advance. Replicates 1–2 gave +22.2 pp with a CI spanning zero (*p* = 0.15). The
pre-registered explanation was a ceiling effect — the full harness scored 3/3 on
eight of nine tasks, leaving no headroom — and the pre-declared fix was to add a
fourth difficulty tier and raise n from 18 to 52 per arm. That a pre-declared fix
moved a pre-declared null in the predicted direction is worth more than the point
estimate.

### 6.4 H3 — the gap closes under the harness

McNemar exact, claimed vs verified within the same attempts.

| arm | b | c | gap | *p* (exact) |
|---|---|---|---|---|
| full harness | 2 | 0 | 3.8% | 0.5 |
| **no harness** | **23** | **0** | **45.1%** | **2.4 × 10⁻⁷** |
| − perception | 2 | 0 | 3.8% | 0.5 |
| − preconditions | 1 | 0 | 1.9% | 1.0 |
| − reflexes | 1 | 1 | 0.0% | 1.0 |
| **− completion check** | **8** | **0** | **17.4%** | **0.0078** |
| − deterministic termination | 3 | 2 | 1.9% | 1.0 |

**H3 supported.** Within the full harness the gap is not statistically detectable
(2 discordant pairs, *p* = 0.5); within `no harness` it is overwhelming, and
**every one of the 23 discordant pairs runs the same way** — the agent claiming
success it did not have, never the reverse. A symmetric error would produce
discordant pairs in both directions. This one has a sign.

### 6.5 H4 — per-layer ablation. Not supported.

Each layer scored on the category it targets. Holm–Bonferroni across five
comparisons. Minimum effect of interest 15 pp, pre-declared.

| layer removed | target category | rise | 95% CI | Holm-adj | verdict |
|---|---|---|---|---|---|
| − completion check | false success | 13.5% | [1.2, 26.1] | 0.1250 | inconclusive |
| − deterministic termination | reached-not-recognized | 3.8% | [0.0, 9.6] | 0.9311 | **bounded null (< 15 pp)** |
| − reflexes | capability failure | 10.2% | [−5.8, 27.6] | 0.9311 | inconclusive |
| − perception | capability failure | 9.6% | [−9.6, 25.0] | 0.9311 | inconclusive |
| − preconditions | capability failure | 9.6% | [−11.5, 26.9] | 0.9311 | inconclusive |

**H4 is not supported.** No single-layer ablation moved its target category by
the pre-declared 15 points after correction. This is a negative result on a
hypothesis we registered, and it is reported as it came out.

The reading that survives: **the whole-harness effect (41.3 pp on false success)
is more than three times the largest single-layer effect (13.5 pp), and no layer
clears the threshold alone.** The effect is distributed across the harness rather
than localised in one component. §7.3 shows the mechanism that produces exactly
this pattern.

The grounded completion check is the closest and points the predicted way — its
unadjusted interval excludes zero — but it does not survive multiplicity and sits
below the minimum effect of interest. We do not report it as *the* mechanism.

"Bounded null" for deterministic termination is an equivalence verdict, not a
failure to reject: the interval **rules out** an effect as large as 15 pp on that
layer's own target category.

### 6.6 The arms fail in different ways

| arm | n | true | false success | reached-not-recog. | capability failure | budget | 0-step |
|---|---|---|---|---|---|---|---|
| full harness | 52 | 35 | 2 | 0 | 11 | 2 | 2 |
| no harness | 51 | 15 | 23 | 0 | 9 | 2 | 2 |
| − perception | 52 | 31 | 2 | 0 | 16 | 2 | 1 |
| − preconditions | 52 | 33 | 1 | 0 | 16 | 2 | 0 |
| − reflexes | 51 | 29 | 1 | 1 | 16 | 3 | 1 |
| − completion check | 46 | 25 | 8 | 0 | 10 | 3 | 0 |
| − deterministic termination | 52 | 32 | 3 | 2 | 8 | 5 | 2 |

The success rate alone hides this. `no harness` fails mostly by **claiming** — 23
false successes against 9 capability failures. Every layer-ablated arm fails
mostly by **not managing** — capability failure dominant, false success in low
single digits. Removing the whole harness changes the *kind* of failure, not only
its rate.

---

## 7. Mechanism — stock mistaken for flow

*§7.1 is exploratory. Failure-mode distribution is a pre-registered secondary
endpoint, but this decomposition of it was not pre-specified, and it is reported
as a post-hoc mechanism analysis. §7.2 is the pre-declared manipulation that
tests it.*

### 7.1 What the false successes are made of

Recall that every criterion is a **net gain** and that the fixed kit is
deliberately unable to satisfy any of them. The unharnessed agent treated the bag
as the answer.

| among `no harness` attempts | already held ≥ N of the target item at start |
|---|---|
| **false successes** | **18 / 22 = 82%** |
| true completions | 5 / 14 = 36% |

Odds ratio 8.1, Fisher exact two-sided *p* = 0.0112. It is not partial credit:
**21 of the 22 produced literally zero gain** on the target item.

```
needed +12 stick         had 96   gained 0   -> claimed done
needed +64 cobblestone   had 96   gained 0   -> claimed done
needed +16 oak_planks    had 48   gained 0   -> claimed done
needed  +6 oak_log       had 16   gained 0   -> claimed done
needed  +1 stone_pickaxe had  1   gained 0   -> claimed done
```

**The agent was not deprived of the facts.** Under ablation it still receives its
inventory every turn (§3). It had the count in front of it and read an absolute
quantity as if it were the required gain. The intervention is therefore not *give
the model data*. It is **do the subtraction in code, and refuse the claim when
the subtraction fails.**

**The obvious objection, and the matched test.** If the agent already holds 96
sticks and is asked for 12 more, refusing to grind is *sensible*, and scoring it a
failure would penalise good judgement rather than dishonesty. The test is
matched — same tasks, same starting stock ≥ N, only the harness differs:

| arm | attempts starting with stock ≥ N | achieved the required net gain |
|---|---|---|
| **full harness** | 24 | **20 = 83%** |
| **no harness** | 24 | **5 = 21%** |

| task (stock ≥ N only) | full harness | no harness |
|---|---|---|
| Craft 12 NEW sticks | **4/4** | 0/4 |
| Chop 6 NEW oak logs | **4/4** | 1/4 |
| Craft 16 NEW oak planks | **4/4** | 1/4 |
| Craft 1 NEW stone pickaxe | **4/4** | 1/4 |
| Mine 16 NEW cobblestone | 2/4 | 1/4 |
| Mine 64 NEW cobblestone | 2/4 | 1/4 |

**The same model, on the same task, holding the same 96 sticks, crafted 12 more —
four times out of four — when the harness was on.** The task is satisfiable and
the instruction ("NEW … this run") is unambiguous, so the difference is not that
one agent was pedantic and the other sensible. One did the work; the other
reported doing it.

The objection does identify the correct boundary, and the taxonomy respects it:
**declining redundant work is not the failure being measured.** Had the agent
answered *"I already hold 96 sticks — do you still want 12 more?"*, that is a
cancel or a question and scores as neither a true nor a false completion. What is
scored is asserting completion of an action that did not occur.

Dropping the awkward `+1 NEW <tool>` tasks, where the ask is at its least
natural, the pattern holds: 15/19 = 79% of false successes and 4/9 = 44% of true
completions started with stock ≥ N.

### 7.2 The manipulation — emptying the bag removes the failure

Everything in §7.1 is an association measured *within* one arm. The matched test
is causal for the **harness**; nothing in it is causal for the **stock**. This
follow-up supplies that manipulation. It was **pre-declared in full** —
prediction, thresholds, and the meaning of a null — before any attempt ran, and
the decision rule is applied in code rather than by eye.

The six stock-satisfied tasks were re-run unharnessed for 4 replicates, each with
a kit that drops **only that task's target item** and keeps every enabler, so the
work required is unchanged and the sole variable is whether the goal was already
satisfied at the start.

| no harness, same six tasks | false success |
|---|---|
| kit supplies the target item | **18/24 = 75%** |
| target item removed from the kit | **0/24 = 0%** |

**Fisher exact, two-sided: *p* < 0.0001.** The pre-declared rule (≤ 33% confirms,
34–49% inconclusive, ≥ 50% refutes) returns **confirmed** at 0%.

Twenty of the 24 succeeded, most overshooting the target — +37 cobblestone
against a +16 ask, +48 sticks against +12. The four that failed did so **openly**:
three timeouts and a cancel on the hardest task, one short chop, and **not one of
them claimed completion**. That is exactly the distinction the endpoint measures.
With an empty bag the agent either did the work or failed without reporting
success. One attempt mined 71 cobblestone against a +64 target and never claimed
it — the opposite error, post-attainment drift, which is deterministic
termination's own target category and absent from this arm by construction.

Rig integrity: 24 of 24 collected, all at one commit, all scorer-labelled, and
**zero attempts began holding ≥ N of their target** — the report refuses to
interpret the result otherwise, since that would be a kit failure rather than a
finding. This arm restarts the agent before every attempt where the main
unharnessed arm restarted once per arm; the main campaign bounds that difference
at 4/6 = 67% for early arm positions, far above the 33% threshold, so the cadence
cannot manufacture the result.

### 7.3 Why no single layer was found responsible

Splitting **every** arm on the same variable shows why §6.5 found nothing:

| arm | kit supplies the target | kit empty of it |
|---|---|---|
| full harness | 1/24 = 4% | 0/24 = 0% |
| **no harness** | **18/24 = 75%** | 4/23 = 17% |
| − perception | **0/24 = 0%** | 0/24 = 0% |
| − preconditions | **0/24 = 0%** | 0/24 = 0% |
| − reflexes | **0/23 = 0%** | 1/24 = 4% |
| − completion check | 2/21 = 10% | 3/21 = 14% |
| − deterministic termination | **0/24 = 0%** | 0/24 = 0% |

Removing any **single** layer leaves the failure at or near zero; only removing
**all five** produces 75%. The failure has one trigger and several independent
guards, any one of which is sufficient.

**That is the mechanism behind H4's null.** No single-layer ablation could reach
the pre-declared 15-point threshold, because four other layers still caught the
case. H4 is not merely unsupported: the harness is **redundant** on this failure
mode, and the redundancy is what makes each layer individually undetectable. A
design that wanted per-layer attribution would have to ablate layers in
combination, and that is a different and larger experiment.

This is worth stating plainly as a design lesson. Defence in depth and
attributability are in tension. A system built so that several independent checks
each suffice is, by construction, a system whose components cannot be credited
individually by single-ablation.

### 7.4 What starting stock does not explain

The unharnessed arm still false-succeeds **4/23 = 17%** with an empty bag: three
ladder/torch tasks and one dirt task, all starting and ending at zero of the
target item, some work attempted, nothing gained, completion claimed anyway.

This is a **second and smaller failure mode**, and starting stock does not account
for it. It is reported here rather than folded into the mechanism. Note also that
§7.2's 0/24 and this 17% are not the same comparison: the stripped arm covers the
six originally-stocked tasks, while the empty-start six are the harder set
(torches, ladders, iron). The manipulation shows that removing the stock removes
the failure *on those six tasks*; it does not bound the residual to zero in
general.

---

## 8. Cost

| arm | input tokens/run | sec/run | **input tokens per verified success** |
|---|---|---|---|
| full harness | 89,632 | 132.8 | **133,167** |
| no harness | 90,375 | 105.9 | **307,274** |
| − perception | 83,215 | 131.7 | 139,587 |
| − preconditions | 103,531 | 109.4 | 163,140 |
| − reflexes | 100,202 | 126.8 | 170,344 |
| − completion check | 83,787 | 117.8 | 154,168 |
| − deterministic termination | 97,003 | 153.9 | 148,357 |

Per run the two whole-harness arms are indistinguishable — 89.6k against 90.4k
input tokens. Per unit of work that actually happened, the harness is **2.3×
cheaper**, because the ablated arm spends tokens on attempts that produce nothing
and then declares victory.

Tokens-per-run and tokens-per-verified-success rank the arms differently. Only
one of them measures something a user would pay for. That is this paper's own
thesis applied to its own cost table, and it generalises: any efficiency metric
computed over *claimed* completions inherits the false-success rate of the system
producing them.

---

## 9. Robustness

### 9.1 The structure-scored task

The 5×5 platform task is scored by the block-scan scorer, which post-dates most
of the H0 calibration and carries its single disagreement. Dropping it:

| endpoint | as reported | without the platform task |
|---|---|---|
| false success | −41.3 pp [−60.8, −23.1] | −44.7 pp [−63.0, −25.6] |
| task success | +37.9 pp [+20.2, +56.9] | +39.0 pp [+20.0, +58.3] |

Both effects are **larger** without it. Including it is conservative.

### 9.2 Zero-step attempts

Eight attempts in the primary set recorded 0 steps and timed out — the agent
never acted. The taxonomy rule calls these infrastructure, but they are not in
the exclusions table, so the endpoint tables still count them as failures. They
are spread across arms (full harness 2, no harness 2, − perception 1, − reflexes
1, − deterministic termination 2). Excluding them:

| endpoint | as reported | excluding |
|---|---|---|
| task success | +37.9 pp [+20.2, +56.9] | +39.4 pp [+22.0, +57.7] |
| false success | −41.3 pp [−60.8, −23.1] | −42.9 pp [−62.0, −23.9] |

Both effects again get **larger**. They are reported as collected: removing rows
after seeing which way it moves the result is precisely what the pre-registration
forbids, and keeping them costs us effect size rather than manufacturing it. This
is a **known inconsistency** between the taxonomy rule and the exclusions table,
flagged rather than silently resolved.

### 9.3 The position-reset deviation

**The reset teleport never fired.** Over 486 consecutive attempt pairs, measuring
where attempt N ended against where N+1 began:

| start position measured from | median distance | within 3 blocks |
|---|---|---|
| previous attempt's **end** position | **0.0 blocks** | **457 / 486 = 94%** |
| the pinned reset point | 1128.9 blocks | 0 / 486 = 0% |

The cause is a defect in the RCON client: it returns each command's response body
and never inspects it. The game answers a rejected command with an error *string*
over a normal response rather than a protocol error, so the runner's failure
check catches connection and auth failures and cannot catch a refused teleport. A
teleport the server declines is indistinguishable from one that worked. The
inventory half of the reset did work — 484/496 attempts match the kit exactly.

This is a deviation from the frozen protocol and it is disclosed as one. Position
therefore carries across attempts and across arms, and **randomized arm order is
what actually controls it.** Two checks bound the consequence.

*Empirical:* the arm-position confound this reset was introduced to remove
produced a visible artefact in the earlier exploratory campaign — the precondition
layer scoring 100%, above the full harness, purely because it always ran fourth
on the richest inherited inventory. Under randomized arm order it scores 63.5%
against the full harness's 67.3%. **The confound explanation held and the anomaly
did not reproduce.**

*Direct:* restricting to replicates where every arm ran in the same region of the
world (replicates 1 and 3 qualify; 2 and 4 do not), on the stock-satisfied
attempts of §7.1:

| subset | no harness | full harness | Fisher exact |
|---|---|---|---|
| replicate 1 | 6/6 = 100% | 0/6 = 0% | 0.0022 |
| replicate 3 | 6/6 = 100% | 0/6 = 0% | 0.0022 |
| **replicates 1+3, position-matched** | **12/12 = 100%** | **0/12 = 0%** | **< 0.0001** |
| all four replicates (as reported) | 18/24 = 75% | 1/24 = 4% | < 0.0001 |

The effect is undiminished when arms are matched on location — which is what
would be expected of a failure mode that consists of *not moving*: 21 of the 22
false successes produced zero net gain, at a median of 2 steps and 10 seconds.
Terrain does not enter into it.

The defect must be fixed before the next campaign, not during a frozen one.

---

## 10. What this does and does not license

**Supported.** In this environment, with this model held fixed, a deterministic
harness that reads world state instead of trusting the agent's account reduces
false success from 45.1% to 3.8% and raises task success from 29.4% to 67.3%. The
gap it closes is one-directional: all 23 discordant pairs in the unharnessed arm
have the agent overstating. On the dominant failure mode, the cause is identified
and removed by manipulation, not inferred.

**Not supported.** Any claim about which layer does the work. H4 failed, and §7.3
gives the reason — the guards are redundant — but "redundant" is itself an
inference from a stratified post-hoc split, not from a designed factorial. A
combinatorial ablation would be needed to establish it properly.

**Not claimed at all.** That the phenomenon is new (it is not — [1]), that the
two-axis dissociation is ours (it is not — [2]), or that the agent is good at
Minecraft. This is a measurement-and-intervention paper, not a capability paper.

---

## 11. Limitations and threats to validity

**11.1 One model, one world, one task family.** Nothing here separates the
harness effect from properties of this model or this environment. The mechanism
in §7 — reading a stock quantity as a flow quantity — is the kind of confusion
that should generalise to any agent asked for a net change while holding a
balance, but that is a hypothesis this data cannot test.

**11.2 The control is an ablation, not an external baseline.** `no harness` is
this fork with every layer removed. That is the right control for attribution and
the wrong one for claims about anyone else's system. Nothing in this paper is a
statement about upstream Minecraft agents.

**11.3 The instrument is validated on an easy regime.** 98.5% agreement with a
92.1% lower bound is strong, but the attempts it covers are overwhelmingly
inventory-delta criteria where ground truth is cheap *for the scorer*. The single
disagreement is on the one structure-scored criterion (§5.1). The calibration
does not license the scorer on harder criteria, and a labeller abstained on
platform cards in an earlier round because the available evidence genuinely did
not settle the call. This is the same problem the paper is about, one level up,
and we do not claim to have escaped it.

**11.4 Citation verification is outstanding.** The literature audit underlying §2
was conducted with AI assistance. Every arXiv identifier, title, sample size and
attributed claim in the reference list requires human verification against the
source before submission. This is the highest-leverage disclosure risk in the
paper and it is not yet discharged.

**11.5 A 15.0% infrastructure fault rate** is high for a campaign this size.
Every fault is a run the rig lost rather than a result, all are logged at the time
with cause and rule, and the discard rate is reported rather than absorbed — but
a rig this noisy is a rig that could be hiding a fault that does not crash.

**11.6 Unequal n.** Three arms hold fewer than 52 attempts; `− completion check`
holds 46, and it is the arm carrying the largest per-layer effect. Its interval is
correspondingly wider.

**11.7 The absolute false-success rate is conditional on the kit.** 45.1% is
measured against a starting inventory that makes stock/flow confusion *available*.
Both arms received the identical kit, so the comparison is sound, but the absolute
rate would not transfer to an empty-inventory setting — as §7.2 demonstrates
directly. **What transfers is the failure mode, not the number.**

**11.8 Known process gaps, adopted for the next campaign.** An A/A arm (two arms
configured identically and labelled differently, so any difference between them is
a pipeline defect by construction); validation of the analysis pipeline on
synthetic data with a planted effect of known size before it sees real data; and
sample-ratio-mismatch assertions in the report generator. Each targets bugs that
do not crash, which is the class that has actually cost this project results. None
was retrofitted into the running campaign, because bolting new tooling onto a
frozen protocol mid-collection is the pattern the freeze exists to prevent.

---

## 12. Conclusion

The field knows that agents report success they have not achieved, and it knows
how to detect it after the fact. What it has not had is a controlled demonstration
that a deterministic layer, under a fixed model, removes it — in a setting where
establishing ground truth is expensive, which is the setting anything with a body
operates in.

That demonstration is this paper. With the harness off, the agent claimed success
on three quarters of attempts and achieved under a third. With it on, false
success fell to 3.8% and real success more than doubled. The mechanism behind the
dominant failure mode is identified and then removed by manipulation: the agent
was reading the contents of its bag as though they were the work it had done, and
emptying the bag of the goal item takes the failure to zero.

Our pre-registered attempt to attribute the effect to a single layer failed, and
the reason is the most useful thing here for anyone building such a system: the
harness is redundant on this failure mode. Five layers each catch it; removing any
one changes nothing; removing all five produces the failure at 75%. Defence in
depth and per-component attribution are in tension, and a builder should want the
former even though it costs the latter.

The practical statement is one sentence, and it is not about model capability.
The agent had the number in front of it the whole time. **Do the subtraction in
code, and refuse the claim when the subtraction fails.**

---

## Reproducibility

- Every figure regenerates from an append-only receipt database:
  `python3 eval/campaign_report.py` (§6, §8), `--robustness` (§9.1–9.2),
  `eval/agreement.py report` (§5), `eval/stock_strip_report.py` (§7.2).
- Raw receipts are immutable. Discards live in a separate exclusions table keyed
  on attempt id; no attempt row is ever edited.
- One commit per comparison; the commit hash is recorded on every attempt.
- Pre-registration, protocol, terminology, the full deviations log and the
  incident log are versioned alongside the code.
- **AI assistance is disclosed:** an AI assistant was used for the literature
  audit (§2, unverified — see §11.4), for analysis tooling, and in drafting this
  manuscript. Experimental design, the pre-registration, all human calibration
  labels, and every scientific decision are the authors'.

---

## References

> **Unverified.** These entries were compiled with AI assistance and have **not**
> been checked against the sources by a human. Titles, identifiers, sample sizes
> and attributed claims must all be confirmed before submission (§11.4).

1. *From Confident Closing to Silent Failure: Characterizing False Success in LLM
   Agents.* arXiv:2606.09863.
2. *Done, But Not Sure: Disentangling World Completion from Self-Termination in
   Embodied Agents* (VIGIL). arXiv:2605.08747.
3. *Where Does Agent Reliability Come From? A Cross-Benchmark Decomposition of
   Verification Loops, Specialist Models, and Scaffolding in a Production
   Enterprise Agent.* arXiv:2607.17044.
4. *Voyager: An Open-Ended Embodied Agent with Large Language Models.*
   arXiv:2305.16291.
5. *Luban.* arXiv:2405.15414.
6. *MineEvolve.* arXiv:2603.13131.
7. *MineExplorer.* arXiv:2605.30931.
8. *Why Do Multi-Agent LLM Systems Fail?* (MAST taxonomy). arXiv:2503.13657.
9. *StressWeb.* arXiv:2604.16385.
