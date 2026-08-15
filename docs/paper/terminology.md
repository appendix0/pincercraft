# Canonical terminology

One name per concept, used consistently in the receipts, the figures and the
manuscript. Code identifiers are *mapped* here, not renamed.

**The standing rule: prose uses the canonical term; code keeps its literal
identifier.** Renaming shipped identifiers would break reproducibility of
already-collected receipts for no scientific gain, so this file is a *mapping*,
not a refactor. Where a code identifier disagrees with the canonical term, the
mapping below is the authority and the identifier is left alone.

**Frozen documents are exempt.** [preregistration.md](preregistration.md) §1–§12
and its append-only deviations log are a historical record: they legitimately
contain terms this file later deprecated ("seed", "verified success" as the
unqualified endpoint name), and rewriting them to match current vocabulary would
destroy the thing that makes a pre-registration worth having. `eval/term_audit.sh`
skips them for this reason. The same applies to
[results.md](results.md), which records the exploratory campaign as it was
reported. Correct the vocabulary going *forward*; never backdate it.

**This file defines terms. It does not report results.** Where a number appears
below it is there to make a distinction concrete, is labelled with the dataset it
came from, and is not a claim — see [results.md](results.md) and the campaign
report for those. A vocabulary file that accumulates live numbers becomes a
second, unversioned results file and drifts out of date silently; this has
already happened once (the reflex-layer figures, corrected 2026-08-15).

---

## 1. The system under test

| canonical term | code identifier | definition |
|---|---|---|
| **harness** | `harness_mode.js`, `layerOn()` | The deterministic layer beneath the LLM. Owns facts and reflexes; the LLM owns plan and judgment. |
| **arm** | `task_set` (`bench_<arm>` exploratory, `conf_<arm>` confirmatory) | One experimental condition: the harness with exactly one layer ablated, all layers on, or all off. |
| **ablation** | `.runtime/harness_off_<layer>` | Switching one layer off and re-running the same tasks. Never "the split". |
| **shuffled backtest** | `seed` | One full pass over the benchmark set in a seed-derived order. Never bare "seed" in prose. |

Do **not** write "scaffolding" and "harness" interchangeably in the manuscript.
Pick **harness** for our system; reserve *scaffolding* for the general class
when discussing other people's work.

### 1.1 Arm names

**The manuscript names every arm by what it is, never by a letter or an index.**

| manuscript | frozen docs | code | what it is |
|---|---|---|---|
| **full harness** | A-ON | `on` | every layer on, as shipped |
| **no harness** | A-OFF | `off` | every layer off |
| **− perception** | B1 | `perception` | perception layer removed |
| **− preconditions** | B2 | `gates` | precondition layer removed |
| **− reflexes** | B3 | `reflexes` | reflex layer removed |
| **− completion check** | B4 | `verify` | grounded completion check removed |
| **− deterministic termination** | B5 | `autofinish` | deterministic termination removed |

`A-ON`/`A-OFF`/`B1`–`B5` are **retired from new prose.** They survive only in
[preregistration.md](preregistration.md) and are read through this table. Three
reasons they fail a reader:

1. **"A" is never expanded.** It is a bare letter; the only gloss anywhere is one
   row of the pre-registration's arm table.
2. **It reads as A/B testing**, which is a different methodology. A reviewer
   scanning a results table misparses it before reaching the legend.
3. **An index carries no information.** `B3` requires a round-trip to the legend
   on every row, and we lost track of it ourselves: the frozen pre-registration
   says `B1–B5` in its design table (§6) and `B1–B4` in its analysis plan (§10),
   a stale count left over from before the verify/autofinish split. Five layer
   arms exist and five comparisons were run.

The minus form matches how ablation tables are read in this literature —
`Full`, `w/o X`, `− X` — so no legend traffic is needed. On first use in the
manuscript, state the mapping once: *"the full harness (A-ON in the
pre-registration)"*.

## 2. The five layers

| canonical term | code identifier | what code takes over |
|---|---|---|
| **perception layer** | `perception` | Tells the model what it can currently craft (CAPABILITIES) and how far along it is (TASK-PROGRESS). |
| **precondition layer** | `gates` | Refuses actions that cannot work: craft preflight, redundant-acquire. |
| **reflex layer** | `reflexes` | Acts without asking: tool-break guard, inventory tidy. |
| **grounded completion check** | `verify` | Blocks a completion claim the world state does not support. Never closes a task. |
| **deterministic termination** | `autofinish` | Closes a task in code once the world state satisfies the criterion. Never blocks anything. |

**`autofinish` is DETERMINISTIC TERMINATION. Do not rename it.** The term is
load-bearing against the cited prior work: VIGIL's *say* axis is
**self-termination** — the agent failing to close an episode it has in fact
completed ([related_work.md](related_work.md) §2). Our layer is the exact
contrast, and the pairing is the paper's mechanism in two words: **the model's
self-termination fails, so the harness supplies deterministic termination.** A
synonym coined by us forfeits that alignment and makes the contrast invisible to
anyone who knows the VIGIL result.

"Deterministic" is also the paper's own thesis word — it is what the whole
harness is — so the layer's name states what makes it work.

A 2026-08-15 rename to "completion recognition" was proposed on the grounds that
"termination" collides with the 480-second watchdog. **Rejected and reverted the
same day**: the watchdog path is called *timeout* and `budget_exhaustion`
everywhere in this repo and is never called termination, so the collision was
hypothetical, and it was not worth breaking a mapping onto published work.

**`gates` is a PRECONDITION layer. Never call it a safety layer.** Player-facing
safety — the stop reflex, the death handler, the Code of Conduct — is a separate
concern that is *never ablated in any arm*, and conflating the two implies we
ablated safety. This error has already reached a draft once.

### Deprecated: `measurement`

`measurement` was a compound arm (`verify` + `autofinish`) used in shuffled
backtests 1–2. **Retired as a term.** It named the *bot's self-assessment* while
the referee performs the actual measurement, and that collision caused real
confusion. The flag is retained in `harness_mode.js` so those backtests stay
reproducible from current code; in prose, write "the compound verify+autofinish
arm (backtests 1–2)".

## 3. Evaluation — kept strictly outside the harness

| canonical term | code identifier | definition |
|---|---|---|
| **referee** | `eval/referee.mjs`, `label_source='referee'` | The independent evaluator. Takes its own world-state snapshots and scores every arm from outside the bot. **Not a harness layer and never ablated** — ablating the scorer removes the measurement instead of varying a condition. |
| **honor system** | `label_source='honor_system'` | Fallback labelling when the criterion is not machine-checkable: the bot's own claim is taken as the label. Reported separately; it is the counter-exhibit, not a result. |
| **completion criterion** | `end_factor` | The task's machine-checkable success condition, e.g. `+16 cobblestone in inventory (net gain this run)`. |
| **task success** | `success` | The referee's verdict: did the world change as the criterion requires. |
| **claimed success** | `claimed()` in `analysis_rules.py`, derived from `outcome` | The agent's own terminal report — what an honor-system pipeline would have recorded. Never a result on its own; it exists to be differenced against task success. |

**"task success" is the concept; "verified success" is the metric under
contrast.** Write **task success** by default — it names the *do* axis (§5.1) and
is what `success` holds. Use the qualifier **verified success rate** only where
the sentence also carries a *claimed* success rate and the reader needs the two
told apart. Do not use "verified success" as a free-floating synonym; one concept
with two interchangeable names is the drift this file exists to stop.
[preregistration.md](preregistration.md) §4 names the primary endpoint "verified
success rate" and is frozen — that wording stands as written, and this rule
governs everything downstream of it.

## 4. The three signals — never collapsed

Every attempt carries three independent outcomes. Collapsing any two is the
exact error the campaign exists to measure.

| signal | question | code identifier |
|---|---|---|
| **agent claim** | Did the model declare the task complete? | `outcome` in `eval/.referee/<id>.evidence.json` (`done` / `cancel` / `timeout`) |
| **harness decision** | Did the harness block or trigger termination? | `harness_verify` (`blocked`/`passed`/`off`), `harness_autofinish` (`fired`/`not_fired`/`off`) |
| **referee verdict** | Was the task actually accomplished? | `task_attempts.success` |

## 5. Outcome taxonomy

Derived in `eval/taxonomy.py`, never stored — the raw receipt stays immutable so
the rule remains revisable.

| canonical term | agent claim | referee | meaning |
|---|---|---|---|
| **true completion** | done | success | Worked, and said so. |
| **false completion** | done | fail | Claimed success it did not achieve. *The phenomenon the paper is about.* |
| **reached-not-recognized** | not done | success | Achieved the goal and never noticed. *The termination failure mode.* |
| **capability failure** | not done | fail | Tried, gave up, genuinely unmet. |
| **budget exhaustion** | not done | fail | Ran out of time with the goal unmet. |
| **infrastructure** | — | — | The rig failed, not the agent. Excluded per §8 and reported as a discard rate (§6). |

**The shape of this table is a 2×2 with one cell split, not six independent
outcomes.** The grid is (agent claim × referee verdict). Its *not-done/fail* cell
is subdivided **by cause** into capability failure (the agent stopped) and budget
exhaustion (the watchdog stopped it) — same cell, different reason, which is why
both read "not done / fail". Infrastructure sits **outside the grid entirely**:
`classify()` returns it before either signal is consulted, because an attempt the
rig broke never produced a claim or a verdict to cross-tabulate. Counting six
cells implies six outcomes and inflates the taxonomy's resolution.

**The manuscript's primary term is "false success"** — the name the field
already uses ([arXiv:2606.09863](https://arxiv.org/abs/2606.09863)), adopted so
the paper is findable by anyone searching for the phenomenon. **"False
completion" remains the canonical term in this repository and in the code**
(`false_completion`, `false_done_referee`), per the standing prose/identifier
split; state the synonym once, on first use. Do not introduce further variants.

Each layer targets one category, which is why these — not overall success — are
the endpoints for a per-layer ablation. The authority is `LAYER_ENDPOINT` in
`eval/analysis_rules.py`; all five must appear here or the doc and the code drift:

```
grounded completion check (verify)      ->  false completion
deterministic termination (autofinish)  ->  reached-not-recognized
perception layer   (perception)         ->  capability failure
precondition layer (gates)              ->  capability failure
reflex layer       (reflexes)           ->  capability failure
```

The two termination layers have separately declared target categories; the other
three do not, and their endpoint is the one they can move. **Do not call those
three "the capability layers"** — §7 reserves *capability* for the taxonomy cell,
and the grouping name would imply that cell is the only outcome they touch.

### 5.1 The two axes

The grid described above has two dimensions, and they move independently. **This
is established prior work, not our finding** — VIGIL ([arXiv:2605.08747](https://arxiv.org/abs/2605.08747))
separates *world completion* from *self-termination* over 20 models and 1,000
episodes, and its four outcome categories map one-to-one onto ours (see
[related_work.md](related_work.md) §2). Cite it on first use; do not present the
separation as ours. What is ours is the *cause* studied: VIGIL varies the model
with the scaffold fixed, we vary the harness with the model fixed.

The two axes are *say* and *do*; the **say-do gap** (§6) is a statistic derived
from them, not their source (defined below). Name them in this order and no other:

| axis | canonical term | metric | direction |
|---|---|---|---|
| **do** — did the world change as required? | **task success** (§3) | verified success rate | **up = better** |
| **say** — did the claim match the world? | **self-report accuracy** | false-completion rate | **up = WORSE** |

| axis | its failure |
|---|---|
| **do** | capability failure (with budget exhaustion as its watchdog-stopped case) |
| **say** | **false completion** |

**The two axes are measured in opposite directions, and the figure must correct
for it.** The *do* axis is named for a success and reported as a success rate;
the *say* axis is named for an accuracy but reported as an **error** rate,
because false completion is the phenomenon the paper is about and inverting it to
"96.2% accurate" would bury exactly what we are trying to show. On the 2×2 figure
the *say* axis is therefore **plotted inverted**, so that up-and-right is good on
both, and the caption must say so. Never place a raw false-completion rate on an
axis labelled "accuracy" without that inversion — the quadrants read backwards.

**Never call the *do* axis "capability".** `capability failure` is already one
cell of the taxonomy; using the same word for the whole axis implies that cell
is the axis's only outcome. Reserve *capability* for the taxonomy category.

### 5.2 Say-do gap vs false completion — not interchangeable

| term | form | definition |
|---|---|---|
| **say-do gap** | aggregate | claimed success rate − task success rate, over the same attempts. A summary statistic. |
| **false completion** | per-attempt | the agent claimed done *on this attempt* and the referee disagreed. The endpoint. |

**Use the per-attempt form for endpoints, intervals and tests. The gap is for
summary sentences only.** Writing them as synonyms is a real error, not a style
preference. In terms of the discordant cells — *b* = claimed/not-verified, *c* =
verified/not-claimed, over *n* attempts:

```
say-do gap       = (b - c) / n      <- errors in opposite directions CANCEL
false completion =  b      / n      <- they do not
```

They are equal **iff c = 0**, and the gap is silent exactly where *c* lives.
Confirmatory data: the two coincide in the full harness and the no-harness arm
(both have c = 0, which is why they look like one metric), and diverge where it
matters most —

| arm | b | c | say-do gap | false completion |
|---|---|---|---|---|
| no harness | 23 | 0 | 45.1% | 45.1% |
| − reflexes | 1 | 1 | **0.0%** | **2.0%** |
| − deterministic termination | 3 | 2 | **1.9%** | **5.8%** |

The −reflexes arm's 0.0% gap does not mean it never lied; it means one false
completion cancelled against one unrecognized success. And **reached-not-recognized
is deterministic termination's own target endpoint** — reporting that layer's *gap*
nets away the very effect the ablation is testing for. This is why §5's endpoint
list is written in per-attempt categories.

### 5.3 The axes move independently — and which direction is shown

Two arms can be statistically indistinguishable on task success and far apart on
false completion. Confirmatory, the −reflexes arm against the
−completion check arm:

| endpoint | − reflexes | − completion check | difference | p |
|---|---|---|---|---|
| task success | 58.8% | 54.3% | +4.5pp, CI [−20.8, +28.9] | 0.71 |
| false completion | 2.0% | 17.4% | −15.4pp, CI [−29.3, −4.5] | **0.0036** |

Same two arms, indistinguishable on one axis and clearly separated on the other.
A claim that one axis is a symptom of the other is contradicted by our own data.

**What is *not* established: that individual layers specialise.** The
confirmatory campaign tested exactly this (H4) and it was **not supported** — no
single-layer ablation moved its target category by the pre-declared 15pp after
Holm correction. The earlier exploratory reading, that ablating the reflex layer
"costs ~19 points of task success and leaves false completion at 0/28", **did not
replicate**: confirmatory gives −8.5pp with a CI spanning zero (p = 0.30) and
1/51 false completions. Do not write that layers specialise, and do not attribute
the whole-harness effect to any one layer.

## 6. Experimental structure

| canonical term | code identifier | definition |
|---|---|---|
| **attempt** | one `task_attempts` row | One agent run at one task under one arm. The atomic unit of evidence. |
| **arm position** | `arm_position` | Where the arm ran in its backtest's randomized order, 1-based. Recorded because it was a confound before it was randomized. |
| **tier** | `difficulty_tier` | Task complexity band, 1–4. |
| **primary set** | `exclude_from_primary` | Benchmark tasks in the primary analysis. **Scoped by dataset, because the exclusion is a property of how the data was scored, not of the task** (`excluded_task_name(dataset)`). Confirmatory: all 13 tasks — the 5×5 platform task's exclusion was lifted 2026-08-14 once the block-scan referee could label it. Exploratory (`bench_*`): 12 tasks — the exclusion stands, because those platform attempts were honor-system scored and re-scoring them would mix two instruments in one dataset. |
| **discard** | `exclusions`, `source` not matching `%superseded%` | An attempt removed for a declared **infrastructure fault** (§8) — the rig failed, so the attempt never produced a result. Never removed because the result looked wrong. |
| **supersession** | `exclusions`, `source LIKE '%superseded%'` | **Valid** data replaced wholesale by a declared re-run of the same arm under a corrected protocol. Not a fault, not a discard, and not removed for looking wrong. |
| **discard rate** | computed in `eval/campaign_report.py` | discards ÷ (primary set + discards). **Counts faults only.** Supersessions are reported as a separate line and never folded in. |
| **minimum effect of interest (MEI)** | `MEI` in `eval/analysis_rules.py` | The smallest per-layer effect worth claiming, pre-declared at 15pp. A layer moving its target category by less is reported as a **bounded null**, not chased with more n. |

**`discard` and `supersession` are different dispositions and must never share a
number.** Both live in the `exclusions` table for receipt-immutability reasons —
the raw row is never mutated or deleted — but they mean opposite things about the
data. A discard says *this attempt is not evidence*; a supersession says *this
attempt was evidence, and better evidence replaced it*. The confirmatory campaign
made the distinction unavoidable: of 140 excluded rows, **77 are the
backtest-2 supersession** (a whole-arm re-run after credit exhaustion truncated
the original) and only **63 are faults**. Reporting all 140 as discards states an
infrastructure fault rate of 28.2% when the true figure is **15.0%** — inventing
a rig-reliability problem we did not have, in our own paper. Deviation recorded
2026-08-15.

## 7. Words to avoid

| avoid | use instead | why |
|---|---|---|
| "safety layer" for `gates` | precondition layer | Implies we ablated safety. We never do. |
| "measurement layer" | verify / autofinish, named individually | Collides with the referee's actual measurement. |
| "the split" | ablation | Owner directive; "split" is ambiguous with the verify/autofinish split. |
| bare "seed" in prose | shuffled backtest | Owner directive. |
| "the harness improves success" as the headline | "a stock agent overstates its own success by N points", N = the **false-completion rate** of the ablated arm (confirmatory: 45.1%) | The full harness's near-zero false-completion rate is partly by construction — `verify` blocks unearned finishes by design. Lead with the size of the failure in the ablated arm. Take N from the per-attempt form (§5.2), not the gap. |
| presenting the say-do gap or the two axes as our discovery | cite 2606.09863 and VIGIL, then state the intervention | Both are published, at larger scale than we can reach. Our contribution is the controlled same-model harness ablation ([related_work.md](related_work.md)). |
| "eliminated" for a zero count | "no events observed in N, bounding the rate below X%" | Zero events needs a bound. 0/30 → one-sided 95% upper bound 9.5%. |
| "capability" as an axis name | task success (§5.1) | `capability failure` is one taxonomy cell; reusing the word for the axis implies the axis has one outcome. |
| "the reflex layer reduces false completion" | it does not move false completion measurably | Confirmatory: ablating it gives 1/51 against the full harness's 2/52 (+1.9pp, CI spans zero). The floor is held by the grounded completion check, which stays on in that arm. |
| "agent overstatement" / "overstatement rate" as a metric | **say-do gap** (aggregate) or **false completion** (per-attempt), §5.2 | There is no third metric. "Overstates" is the *verb* §3 attaches to a positive gap; promoting it to a noun creates a name with no definition behind it. |
| say-do gap and false completion used as synonyms | pick one per §5.2 | They are equal only when c = 0. Treating them as one metric hides the reached-not-recognized cell — which is `autofinish`'s own endpoint. |
| "verified success" as a free-standing synonym for task success | **task success**; qualify to "verified success rate" only opposite *claimed* success rate | §3. One concept with two interchangeable names is the drift this file exists to stop. |
| counting supersessions in the discard rate | report faults and supersessions on separate lines | §6. Folding them together turned a 15.0% fault rate into a reported 28.2%. |
| "the layers specialise" | the whole-harness effect is not attributable to a single layer at this n | H4 was **not supported**: no single-layer ablation cleared the 15pp MEI after Holm. |
| `A-ON` / `A-OFF` in new prose | **full harness** / **no harness** (§1.1) | "A" is never expanded, and the label reads as A/B testing — a different methodology. Frozen docs keep it; read them through §1.1. |
| `B1`–`B5` for layer arms | **− perception**, **− preconditions**, **− reflexes**, **− completion check**, **− deterministic termination** (§1.1) | An index carries no information and costs a legend lookup per row. The frozen pre-registration already contradicts itself on the count (B1–B5 in §6, B1–B4 in §10). |
| any synonym for `autofinish` other than **deterministic termination** | deterministic termination (§2) | It is the deliberate contrast to VIGIL's **self-termination**. A coined synonym forfeits the mapping onto published work. |

See [preregistration.md](preregistration.md) for the protocol and
[protocol.md](protocol.md) for the frozen confirmatory procedure.
