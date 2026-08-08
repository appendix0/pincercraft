# Campaign results — seeds 1–2

120 attempts, six arms, two seeds, 2026-08-07. Collected under
[preregistration.md](preregistration.md), on the dedicated eval world
(pincercraft-ts) rather than the owner's live world.

Primary set is 9 tasks × 2 seeds = 18 per arm; the platform task is excluded by
prior declaration (§4). Seed 3 not yet run — the API credit ran out.

## Headline table

| arm | verified | 95% CI | claimed | say-do gap |
|---|---|---|---|---|
| on | 88.9% | [67.2, 96.9] | 88.9% | 0.0% |
| off | 66.7% | [43.7, 83.7] | 100.0% | **33.3%** |
| perception | 83.3% | [60.8, 94.2] | 83.3% | 0.0% |
| gates | 100.0% | [82.4, 100.0] | 100.0% | 0.0% |
| reflexes | 72.2% | [49.1, 87.5] | 72.2% | 0.0% |
| measurement | 27.8% | [12.5, 50.9] | 44.4% | 16.7% |

**Primary endpoint (H2): still not supported.** ON − OFF = 22.2%, 95% CI
[−5.6%, +50.0%], p = 0.15. The gap widened from seed 1 (11.1%) and now nearly
excludes zero, but it does not. Reported as it came out, per §11.

**Per-layer ablation vs ON:**

| layer removed | drop | 95% CI | p | Holm-adj |
|---|---|---|---|---|
| **measurement** | **61.1%** | [38.9, 83.3] | 0.0000 | **0.0000** |
| reflexes | 16.7% | [0.0, 33.3] | 0.053 | 0.158 |
| perception | 5.6% | [0.0, 16.7] | 0.697 | 1.000 |
| gates | −11.1% | [−33.3, 0.0] | 0.710 | 1.000 |

The measurement effect survives Holm correction with room to spare. It is the
only one that does.

## The result: removing one layer is worse than removing all of them

Ablating `measurement` alone (27.8%) is **far more damaging than ablating the
entire harness** (66.7%). That looks paradoxical until the failure modes are
read, and they differ qualitatively by arm:

| arm | failures | composition |
|---|---|---|
| on | 2 | both honest `cancelled` |
| off | 6 | **all 6 `false_done_referee`** — zero timeouts |
| measurement | 13 | **9 `timeout`**, 3 false-done, 1 cancelled |
| reflexes | 5 | 3 timeout, 2 cancelled |
| perception | 3 | all `cancelled` |

The arms fail in different *ways*:

- **Full OFF fails by lying.** It claimed 100% and delivered 66.7%; every single
  failure was a false completion claim. It never times out, because it always
  believes it is finished.
- **Measurement-only fails by never finishing.** It claimed just 44.4% — it
  *knew* it had not finished, because the perception layer was still showing it
  real inventory counts — and ran out the 480 s watchdog. Mean wall clock 259 s
  against 38 s for ON.

  It did not do so by *working*. The arm averaged **2.0 steps and 29 k input
  tokens per run, against 4.3 steps and 71 k for ON** — fewer model calls and
  under half the tokens of any other arm. So it was not grinding; it was
  **stalled**: the task never closed, and the agent sat parked waiting on a
  completion signal that only `autofinish` emits. That the worst arm in the
  campaign was also the *cheapest* per run is the clearest evidence available
  that the loop guard holds under the condition most likely to produce runaway.
- **ON fails honestly**, with a `cancelled`.

So the layers do different jobs, and they interact:

> Perception without measurement produces **honest failure**.
> Neither produces **confident fabrication**.

Ground-truth *awareness* is what suppresses false claims; deterministic
verification is what converts awareness into completed work. Remove awareness
too and the agent stops noticing it has failed at all.

## Cost: honesty is roughly free

Same primary set, same runs — the harness is not free per run, and is close to
free per unit of work that actually happened.

| arm | input tokens/run | sec/run | **input tokens per verified success** |
|---|---|---|---|
| on | 71,074 | 37.8 | **79,958** |
| off | 53,254 | 26.4 | **79,881** |
| gates | 57,908 | 39.2 | 57,908 |
| perception | 55,553 | 55.1 | 66,664 |
| reflexes | 54,998 | 108.6 | 76,151 |
| measurement | 29,123 | 259.4 | 104,842 |

Per run, A-ON costs **33% more** than A-OFF. Per verified success the two are
indistinguishable — 79,958 against 79,881, a difference far below what n = 18
per arm can resolve, and the near-equality is coincidence, not precision.

The reason A-OFF looks cheap per run is that **fabricating a completion is
cheap**: it declares done at 26 s and stops paying. The overhead only cancels
out once you divide by work that was actually done.

Stated as a claim: at this task difficulty, the harness buys the elimination of
a 33-point say-do gap at **no measurable cost per completed task**. It does not
buy a cost *saving*, and an earlier reading of these runs that suggested one was
computed on a wider row set than the primary set and does not survive.

This is also the paper's own thesis turned on the paper: tokens-per-run and
tokens-per-verified-success rank the arms differently, and only one of them is
measuring anything a user cares about.

## Limitations

1. **`measurement` bundled two functions.** The flag removed both (a) the finish
   gate that blocks unearned completion claims and (b) deterministic
   auto-finish, which closes a task once its criterion is met. The 61.1% drop
   conflates them, and the stall profile — 2.0 steps/run, no token burn —
   points at (b). **Resolved in code after this campaign: the layer is now
   `verify` and `autofinish`, ablatable separately.** Every number on this page
   predates the split and describes the compound; `harness_off_measurement` is
   retained as a compound flag so these runs stay reproducible.
2. **Two seeds, n = 18 per arm.** Intervals are wide; the per-layer analysis is
   exploratory as pre-declared.
3. **The task set is too easy on a fresh world — measured, not suspected.**
   A-ON scored **3/3 on eight of the nine primary tasks**; only the stone
   pickaxe (1/3) sat below ceiling. An endpoint with no headroom cannot show
   the harness improving anything, which is the most likely reason H2 came back
   flat. A fully-ablated agent still scored 66.7%. Fixing the depletion
   confound (§7) by moving off YOON appears to have introduced an easiness
   confound: resources sit near spawn on an untouched map. **Addressed after
   this campaign: tier 4 adds iron pickaxe, 64 cobblestone, and 5 iron ingots
   — a deep prerequisite chain, a duration/tool-break task, and a
   three-precondition task.**
4. `gates` at 100% — above full-ON — is noise at this n, not evidence that gates
   hurt.
5. **The stone pickaxe task needs checking before it is reported again.** It was
   the only sub-ceiling task, and A-ON went 1/3 on it while the `gates`-ablated
   arm went 2/2. That ordering is backwards, and while n = 2 makes it nothing
   on its own, the natural hypothesis — craft preflight false-positively
   blocking a legitimate stone-pickaxe craft — is a bug in the gates layer, not
   a property of the world. Untested.

## What replicates, and what does not

**Does not:** the v1 headline of 9/9 vs 1/9. The ON/OFF success difference is
22.2% and its interval still spans zero.

**Does:** the say-do gap, and more sharply than before. OFF claimed 100% and
delivered 66.7% — six silent false completions, caught only because the referee
measured the world rather than reading the transcript. ON's claims matched its
deliveries exactly, twice over.

The capability claim weakened. The measurement claim — that self-reported agent
success is unreliable and the size of that unreliability is measurable — held.
