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
  real inventory counts — and ground on until the 480 s watchdog. Mean wall
  clock 259 s/run against 38 s for ON.
- **ON fails honestly**, with a `cancelled`.

So the layers do different jobs, and they interact:

> Perception without measurement produces **honest failure**.
> Neither produces **confident fabrication**.

Ground-truth *awareness* is what suppresses false claims; deterministic
verification is what converts awareness into completed work. Remove awareness
too and the agent stops noticing it has failed at all.

## Limitations

1. **`measurement` bundles two functions.** The flag removes both (a) the finish
   gate that blocks unearned completion claims and (b) deterministic
   auto-finish, which closes a task once its criterion is met. The 61.1% drop
   conflates them, and the timeout-dominated failure profile suggests (b) drives
   much of it. **Fix before seed 3: split into `verify` and `autofinish`.**
2. **Two seeds, n = 18 per arm.** Intervals are wide; the per-layer analysis is
   exploratory as pre-declared.
3. **The task set may be too easy on a fresh world.** A fully-ablated agent
   still scored 66.7%. Fixing the depletion confound (§7) by moving off YOON
   likely introduced an easiness confound: resources sit near spawn on an
   untouched map. This is the most plausible explanation for the divergence from
   Field Trial v1's 9/9 vs 1/9. The task set needs harder tiers.
4. `gates` at 100% — above full-ON — is noise at this n, not evidence that gates
   hurt.
5. The stone pickaxe task failed in nearly every arm including full-ON. Check
   whether it is mis-specified rather than merely hard.

## What replicates, and what does not

**Does not:** the v1 headline of 9/9 vs 1/9. The ON/OFF success difference is
22.2% and its interval still spans zero.

**Does:** the say-do gap, and more sharply than before. OFF claimed 100% and
delivered 66.7% — six silent false completions, caught only because the referee
measured the world rather than reading the transcript. ON's claims matched its
deliveries exactly, twice over.

The capability claim weakened. The measurement claim — that self-reported agent
success is unreliable and the size of that unreliability is measurable — held.
