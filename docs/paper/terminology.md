# Canonical terminology

One name per concept, used consistently in the code, the receipts, the figures
and the manuscript.

**The standing rule: prose uses the canonical term; code keeps its literal
identifier.** Renaming shipped identifiers would break reproducibility of
already-collected receipts for no scientific gain, so this file is a *mapping*,
not a refactor. Where a code identifier disagrees with the canonical term, the
mapping below is the authority and the identifier is left alone.

---

## 1. The system under test

| canonical term | code identifier | definition |
|---|---|---|
| **harness** | `harness_mode.js`, `layerOn()` | The deterministic layer beneath the LLM. Owns facts and reflexes; the LLM owns plan and judgment. |
| **arm** | `task_set` (`bench_<arm>`) | One experimental condition: the harness with exactly one layer ablated, all layers on (A-ON), or all off (A-OFF). |
| **ablation** | `.runtime/harness_off_<layer>` | Switching one layer off and re-running the same tasks. Never "the split". |
| **shuffled backtest** | `seed` | One full pass over the benchmark set in a seed-derived order. Never bare "seed" in prose. |

Do **not** write "scaffolding" and "harness" interchangeably in the manuscript.
Pick **harness** for our system; reserve *scaffolding* for the general class
when discussing other people's work.

## 2. The five layers

| canonical term | code identifier | what code takes over |
|---|---|---|
| **perception layer** | `perception` | Tells the model what it can currently craft (CAPABILITIES) and how far along it is (TASK-PROGRESS). |
| **precondition layer** | `gates` | Refuses actions that cannot work: craft preflight, redundant-acquire. |
| **reflex layer** | `reflexes` | Acts without asking: tool-break guard, inventory tidy. |
| **grounded completion check** | `verify` | Blocks a completion claim the world state does not support. Never closes a task. |
| **deterministic termination** | `autofinish` | Closes a task in code once the world state satisfies the criterion. Never blocks anything. |

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
| **task success** | `success` | The referee's verdict. The only quantity called "success" without a qualifier. |

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
| **budget exhaustion** | — | fail | Ran out of time with the goal unmet. |
| **infrastructure** | — | — | The rig failed, not the agent. Excluded per §8 and reported as a discard rate. |

**The manuscript's primary term is "false success"** — the name the field
already uses ([arXiv:2606.09863](https://arxiv.org/abs/2606.09863)), adopted so
the paper is findable by anyone searching for the phenomenon. **"False
completion" remains the canonical term in this repository and in the code**
(`false_completion`, `false_done_referee`), per the standing prose/identifier
split; state the synonym once, on first use. Do not introduce further variants.

Each layer targets one category, which is why these — not overall success — are
the primary endpoints for a per-layer ablation:

```
grounded completion check (verify)     ->  false completion
deterministic termination (autofinish) ->  reached-not-recognized
```

### 5.1 The two axes

The taxonomy above is a 2×2 whose two dimensions move independently. **This is
established prior work, not our finding** — VIGIL ([arXiv:2605.08747](https://arxiv.org/abs/2605.08747))
separates *world completion* from *self-termination* over 20 models and 1,000
episodes, and its four outcome categories map one-to-one onto ours (see
[related_work.md](related_work.md) §2). Cite it on first use; do not present the
separation as ours. What is ours is the *cause* studied: VIGIL varies the model
with the scaffold fixed, we vary the harness with the model fixed.

The axes are named after the project's own **say-do gap**:

| axis | canonical term | metric | its failure |
|---|---|---|---|
| **do** — did the world change as required? | **task success** (§3) | verified success rate | capability failure |
| **say** — did the claim match the world? | **self-report accuracy** | false-completion rate | **false completion** |

**Never call the *do* axis "capability".** `capability failure` is already one
cell of the taxonomy; using the same word for the whole axis implies that cell
is the axis's only outcome. Reserve *capability* for the taxonomy category.

The **say-do gap** is the aggregate discrepancy on a set of attempts (claimed
rate minus verified rate). **False completion** is its per-attempt form. Use the
per-attempt form for endpoints and intervals; the gap is a summary statistic.

Why the distinction earns its place: two arms can be statistically
indistinguishable on task success and 33 points apart on false completion
(A-OFF 60.0% / 33.3% vs the reflex-ablated arm 67.9% / 0.0%; task success
p=0.59, false completion p=0.0008, exploratory). A claim that one axis is a
symptom of the other is contradicted by our own data.

The demonstrated direction is **task success degrading without self-report
accuracy degrading**: ablating the reflex layer costs ~19 points of task
success and leaves false completion at 0/28. The converse — moving self-report
accuracy while holding task success fixed — is **not yet cleanly shown**;
ablating the grounded completion check alone moves both, at n=12. Do not write
"the layers specialise" as an established result until the confirmatory
campaign settles it.

## 6. Experimental structure

| canonical term | code identifier | definition |
|---|---|---|
| **attempt** | one `task_attempts` row | One agent run at one task under one arm. The atomic unit of evidence. |
| **arm position** | `arm_position` | Where the arm ran in its backtest's randomized order, 1-based. Recorded because it was a confound before it was randomized. |
| **tier** | `difficulty_tier` | Task complexity band, 1–4. |
| **primary set** | `exclude_from_primary` | Benchmark tasks in the primary analysis. **Scoped by dataset, because the exclusion is a property of how the data was scored, not of the task** (`excluded_task_name(dataset)`). Confirmatory: all 13 tasks — the 5×5 platform task's exclusion was lifted 2026-08-14 once the block-scan referee could label it. Exploratory (`bench_*`): 12 tasks — the exclusion stands, because those platform attempts were honor-system scored and re-scoring them would mix two instruments in one dataset. |
| **discard** | `exclusions` | An attempt removed for a declared infrastructure fault (§8). Never removed because the result looked wrong. |

## 7. Words to avoid

| avoid | use instead | why |
|---|---|---|
| "safety layer" for `gates` | precondition layer | Implies we ablated safety. We never do. |
| "measurement layer" | verify / autofinish, named individually | Collides with the referee's actual measurement. |
| "the split" | ablation | Owner directive; "split" is ambiguous with the verify/autofinish split. |
| bare "seed" in prose | shuffled backtest | Owner directive. |
| "the harness improves success" as the headline | "a stock agent overstates its own success by N points" | A-ON's zero false-completion rate is partly by construction — `verify` blocks unearned finishes by design. Lead with the size of the gap in the ablated arm. |
| presenting the say-do gap or the two axes as our discovery | cite 2606.09863 and VIGIL, then state the intervention | Both are published, at larger scale than we can reach. Our contribution is the controlled same-model harness ablation ([related_work.md](related_work.md)). |
| "eliminated" for a zero count | "no events observed in N, bounding the rate below X%" | Zero events needs a bound. 0/30 → one-sided 95% upper bound 9.5%. |
| "capability" as an axis name | task success (§5.1) | `capability failure` is one taxonomy cell; reusing the word for the axis implies the axis has one outcome. |
| "the reflex layer reduces false completion" | it moves task success only | Ablating it leaves false completion at 0/28. The zero is held by the grounded completion check, which stays on in that arm. |

See [preregistration.md](preregistration.md) for the protocol and
[protocol.md](protocol.md) for the frozen confirmatory procedure.
