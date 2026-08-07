# Pre-registration — the say-do gap benchmark campaign

**Status:** frozen 2026-08-07, before any campaign run.
**Scope:** every number intended for the paper and the v2 HF dataset.
**Rule:** this file is written *before* the runs and is not edited to match results.
Anything that changes after the first campaign run goes in the Deviations log at the
bottom, with a date and a reason — never by rewriting the section above.

---

## 1. The claim

Self-reported task success by an LLM agent is unreliable, and the size of that
unreliability is measurable. A deterministic harness that reads world state
instead of trusting the agent's account both *measures* the gap and *closes* it.

This is a measurement paper, not a capability paper. We are not claiming the
agent is good at Minecraft. We are claiming the instrument is trustworthy and
that what it reveals is large.

## 2. Hypotheses

Stated with direction, before data collection.

| | Hypothesis | Fails if |
|---|---|---|
| **H0** | *(gating)* The referee agrees with blind human judgement at ≥ 90%, with the Wilson 95% lower bound above 75%. | Lower bound ≤ 75% — instrument not trustworthy, H1–H3 become uninterpretable and the paper reports the calibration failure instead. |
| **H1** | Honor-system labelling overstates success: on identical attempts, self-reported success exceeds referee-verified success. | Gap ≤ 0, or its CI spans 0. |
| **H2** | Verified success is higher with the harness on than off. | ON ≤ OFF, or CI spans 0. |
| **H3** | The say-do gap is *smaller* with the harness on than off. | Gap(ON) ≥ Gap(OFF). |
| **H4** | At least one individual harness layer produces a detectable drop in verified success when removed alone. | No single-layer ablation differs from full-ON beyond noise. |

**H0 gates the rest.** If the instrument does not calibrate, we report that and
stop; we do not proceed to report H1–H4 as if measured.

## 3. Definitions

- **Attempt** — one benchmark task issued to the bot, run to a terminal state
  (finish, cancel, or timeout).
- **Verified success** — the deterministic referee's verdict, computed from an
  inventory delta against the task's `end_factor` (`eval/referee.mjs`,
  `evaluateCriterion`). Never from bot text.
- **Claimed success** — the agent's own terminal report, i.e. what an
  honor-system pipeline would have recorded (`label_source = honor_system`).
- **Say-do gap** — `P(claimed success) − P(verified success)`, over the same
  attempts. Positive means the agent overstates.
- **Task** — one of the 10 rows of `eval/benchmarks.json`, tiers 1–3.
- **Seed** — one full pass over the task set. Seeds are independent runs, not
  RNG seeds; world state is reset between them (§7).

## 4. Design

Fixed before data collection. **Three seeds per condition**, matching Voyager's
floor.

| Code | Condition | Tasks × seeds | Attempts |
|---|---|---|---|
| **A-ON** | Full harness (as shipped) | 10 × 3 | 30 |
| **A-OFF** | `harness_off` — all layers ablated | 10 × 3 | 30 |
| **B1–B4** | One layer removed at a time: perception, gates, reflexes, measurement | 4 × 10 × 3 | 120 |
| **C-BASE** | Stock upstream Mindcraft, same model, same tasks | 10 × 3 | 30 |
| | | **total** | **210** |

**Four ablatable layers, not five.** An earlier draft listed *referee* as a
fifth. That was an error: the referee is the measuring instrument, not a
component under test. Removing it would delete the measurement rather than vary
a condition. `LAYERS` in `src/agent/harness_mode.js` excludes it and
`test/harness_layers_offline.mjs` asserts it stays excluded. Note the resulting
split: the `measurement` layer — the bot's *own* finish verification — is
ablated, while the external referee that scores the arm is not.

**The referee labels every arm, including the baseline and including A-OFF.**
The instrument is external to the system under test. In A-OFF and B4 the harness's
*own* finish-verification is disabled, but the referee still computes the verdict
out-of-band for scoring. This distinction is load-bearing and must survive into
the code: ablating the harness must not ablate the scorer.

**Primary endpoint:** verified success rate, A-ON vs A-OFF.
**Co-primary:** say-do gap, A-ON vs A-OFF.
**Secondary:** per-layer ablation (B1–B5); failure-mode distribution; token and
wall-clock cost per verified success.

### Excluded from the primary analysis, by prior commitment

Task 10 (5×5 cobblestone platform) is deliberately not inventory-shaped and
falls back to `honor_system` — there is no block-scan referee yet. It is
**excluded from every referee-labeled aggregate** and reported separately as a
worked example of what an unverifiable criterion looks like. Primary analysis is
therefore **9 tasks × 3 seeds = 27 attempts per arm**. This exclusion is declared
now, not chosen after seeing results.

## 5. The instrument, and how it is calibrated

The referee is deterministic code: snapshot inventory, run the task, diff, compare
the delta against a `+N <item>` criterion. It has no model in the loop and cannot
report on its own compliance.

**Calibration protocol (H0):**

- Target **n = 40** blind human labels, drawn across all arms and all three tiers.
- The labeler sees an evidence card: the task text, the bot's chat transcript, and
  the ground-truth inventory before and after.
- The labeler **does not see the referee's verdict.** This is what makes the
  exercise calibration rather than confirmation.
- Showing ground truth to the human is intentional and is *not* circular: the
  referee applies one specific rule to that state, while the human sees the whole
  picture and can catch cases the rule mis-encodes. The single historical
  disagreement (#322) was exactly that — an LLM-authored criterion written
  backwards — and a protocol that hid ground truth from the human would have
  missed it.
- Labels are recorded with `eval/agreement.py label`, which refuses duplicates.
- Reported as raw agreement, Cohen's κ, and a Wilson 95% interval.

**Pilot, already banked (n = 12, 11/12 = 92%):** these rows were collected before
this pre-registration under a less formal protocol and were used to *develop* the
grammar they test. They are reported as a pilot and are **not pooled** with the
n = 40 confirmatory set.

## 6. Randomization and ordering

- Task order within a seed is **randomized**, seeded by run index, and the order
  is recorded. Fixed ordering would confound tier with world depletion.
- Arms are interleaved by seed (seed 1 of every arm, then seed 2, …) so that any
  drift in server or model behaviour hits all arms roughly equally rather than
  landing entirely on whichever arm ran last.

## 7. Environment control

Field Trial v1 ran against YOON (`settings.js` port 25565), the owner's live
world, despite `field_trial.sh` claiming otherwise in its header. For a 240-run
campaign this is a confound: felled trees and mined stone near spawn make later
runs face a measurably poorer world.

**Commitments:**
- The campaign runs against `pincercraft-ts`, a dedicated eval world, via an
  explicit target override. Casual play on YOON is unaffected.
- The bot is returned to a known position and its inventory cleared between
  attempts; each seed starts from a recorded world state.
- No human player is on the eval server during a batch.

## 8. Abort and exclusion rules

Field Trial v1 aborted five runs (`bench_on_aborted_r2` … `r6`) before a clean
run 7. That is legitimate debugging of a pipeline, but as a practice it can
silently select for good outcomes. Constrained from here:

**An attempt or run may be discarded only for a declared infrastructure fault:**

1. Bot never spawned, or MCP unreachable within the timeout.
2. Minecraft server crash, restart, or network loss mid-run.
3. Harness/runner crash, or a code change landing mid-run.
4. A human player joining the eval server mid-run.

**Never grounds for discarding:** the agent failed the task; the result looked
wrong; the arm underperformed; the run contradicted the pilot.

Every abort is appended to `docs/paper/aborts.md` with timestamp, run tag, cause,
and which of rules 1–4 it fell under — written **at the time of the abort**, not
reconstructed later. Aborted attempts keep their `task_set` tag (`*_aborted_*`)
and are excluded from analysis but reported as a count, so the discard rate is
visible in the paper.

If a bug is found mid-campaign, the fix is applied and **every affected arm is
re-run from scratch.** Arms are not mixed across code versions; the commit hash
is recorded per attempt.

## 9. Stopping rules

- Data collection stops at the pre-declared 240 attempts. No peeking-and-extending
  to reach significance.
- If H0 fails at n = 40, collection stops and the paper reports the calibration
  failure.
- If an arm cannot complete after three infrastructure-fault re-runs, it is
  reported as incomplete with the reason, not silently dropped.

## 10. Analysis plan

Written before the data exists.

- **Proportions** reported with Wilson 95% intervals throughout.
- **A-ON vs A-OFF**: paired by task across arms; cluster bootstrap over tasks
  (10,000 resamples, task as the resampling unit) for the difference in verified
  success. Task is the unit because the 3 seeds within a task are not independent.
- **Say-do gap**: McNemar's exact test on claimed-vs-verified within the same
  attempts, per arm.
- **Per-layer ablation**: each of B1–B4 against A-ON, same cluster bootstrap,
  **Holm–Bonferroni correction across the four comparisons.** Reported as
  exploratory regardless — 4 arms × 3 seeds is underpowered for small effects,
  and we say so rather than reading noise as structure.
- **Calibration**: raw agreement, Cohen's κ, Wilson interval.
- No result is described as "significant" without the interval printed next to it.

## 11. Known risk, stated in advance

The pilot result is **9/9 vs 1/9** at a single seed. Single-seed results of that
shape regress. A confirmatory outcome of, say, 7/9 vs 3/9 would be a weaker but
still substantial effect, and **it will be reported as the headline** if that is
what comes out. Pre-committing to this is the point of the document; the pilot
number is not a target to reproduce.

Equally: if A-OFF turns out to perform comparably, that is a publishable negative
result about the harness and will be written as one.

## 12. What is already banked

For transparency, existing rows in `pincercraft_evals.db` at freeze time:

| task_set | label_source | n | successes |
|---|---|---|---|
| bench_on | referee | 9 | 9 |
| bench_off | referee | 9 | 1 |
| bench_on/off | honor_system | 2 | 2 |
| bench | referee / honor | 4 / 2 | 4 / 1 |
| bench_on_aborted_r2…r6 | referee / honor | 10 / 1 | 5 / 0 |
| play, explore, live | mixed | 35 | 23 |

These are **pilot data**. They motivated the hypotheses and are reported as such.
The confirmatory claims rest only on the 240 attempts collected after this freeze.

---

## Deviations log

*Append-only. Date, what changed, why. Empty at freeze.*

| Date | Deviation | Reason |
|---|---|---|
| 2026-08-07 | §4: ablation arms cut from five (B1–B5) to four (B1–B4); total runs 240 → 210. The dropped arm was *referee*. | Error in the original draft. The referee is the measuring instrument, not a component under test — ablating it removes the measurement instead of varying a condition, contradicting §4's own rule that ablating the harness must not ablate the scorer. Found while implementing the flag split (`92a37f8`). **Pre-data:** no campaign run had happened, so no result influenced this. |
