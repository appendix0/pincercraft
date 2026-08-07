# Seed 1 — first pre-registered campaign slice

60 attempts, six arms, 2026-08-07. First data collected under
[preregistration.md](preregistration.md), and the first run on the dedicated
eval world (pincercraft-ts) rather than the owner's live world.

Primary set is 9 tasks per arm; the platform task is excluded by prior
declaration (§4).

## What came out

| arm | verified | 95% CI | claimed | say-do gap |
|---|---|---|---|---|
| on | 88.9% | [56.5, 98.0] | 88.9% | 0.0% |
| off | 77.8% | [45.3, 93.7] | 100.0% | **22.2%** |
| perception | 88.9% | [56.5, 98.0] | 88.9% | 0.0% |
| gates | 100.0% | [70.1, 100.0] | 100.0% | 0.0% |
| reflexes | 88.9% | [56.5, 98.0] | 88.9% | 0.0% |
| measurement | 55.6% | [26.7, 81.1] | 88.9% | **33.3%** |

**Primary endpoint (H2): not supported at this seed.** ON − OFF = 11.1%,
95% CI [−22.2%, +44.4%], bootstrap p = 0.76. The interval spans zero.

This is a large divergence from Field Trial v1's 9/9 vs 1/9, and it is reported
as it came out — §11 pre-committed to exactly this outcome.

## The finding that survives

One layer accounts for the entire effect. Ablating **measurement** — the bot's
own verified finishes — alone produced:

- the largest success drop of any arm (33.3%, CI [11.1, 66.7], p = 0.049,
  Holm-adjusted 0.197)
- a **larger say-do gap (33.3%) than ablating the whole harness (22.2%)**

The other three layers moved nothing. That is not a flag that failed to take:

| arm | failed tasks |
|---|---|
| on | stone pickaxe |
| perception | stone pickaxe |
| reflexes | stone pickaxe |
| measurement | stone pickaxe + **3× `false_done_referee`** |

ON, perception and reflexes fail the *identical* task, which is why their
bootstrap intervals are exactly [0, 0]. And the measurement arm is a **positive
control for the flag plumbing**: it demonstrably reached the agent child
process, so the perception and reflexes ablations took effect and genuinely
changed no outcome on this task set.

So the mechanism that matters is deterministic verification of completion — not
perception, gates, or reflexes. That is a sharper claim than "the harness
helps", and it is the paper's thesis stated at the level of a component.

## Limitations, stated plainly

1. **One seed, n = 9 per arm.** Every interval is wide. After Holm correction
   the measurement effect is not significant (0.197). Exploratory.
2. **The task set is probably too easy on a fresh world.** An unharnessed agent
   scored 77.8%. Fixing the depletion confound (§7) by moving off YOON may have
   introduced an easiness confound: resources sit near spawn on an untouched
   map. A benchmark an ablated agent nearly passes cannot discriminate. This is
   the most likely explanation for the divergence from v1, which ran on a
   lived-in world.
   → **The task set needs harder tiers, not just more seeds.**
3. `gates` scoring 100% — above full-ON — is noise at this n, not evidence that
   gates hurt.
4. The stone pickaxe task failed in every arm including full-ON. Worth checking
   whether it is mis-specified rather than hard.

## What does replicate

The say-do gap itself. OFF claimed 100% and delivered 77.8%; ON claimed exactly
what it delivered. ON's single failure was an honest `cancelled`, while OFF's
were `false_done_referee` — silent false completions caught only because the
referee measured the world instead of reading the transcript.

The raw success-rate claim did not reproduce. The reliability-of-self-report
claim did.
