# Abort log

Every discarded run or attempt, written **at the time of the abort**.
Governed by §8 of [preregistration.md](preregistration.md): a run may be discarded
only for a declared infrastructure fault (rules 1–4), never because the result
looked wrong.

The discard rate computed from this file is reported in the paper.

| Date (UTC) | Run tag | Rule | Cause | Attempts lost |
|---|---|---|---|---|
| 2026-08-07 | `bench_measurement` seed 2 | 3 | **Anthropic API credit exhausted mid-campaign.** Every LLM call returned `400 ... "Your credit balance is too low to access the Anthropic API"`. The bot stayed connected and received drive nudges, but took 0 turns; all 10 attempts ran to the full 480 s timeout with inventory unchanged. Attempts #490–#499. Detected 2026-08-08 while investigating the layer's 61.1 pp drop. | 10 |
| 2026-08-09 | `conf_*` backtest 1 | — | **Campaign interrupted by Anthropic API credit exhaustion, no attempts lost.** Stopped after 33 of 364 runs, partway through the 3rd of 7 arms. The credit error appears in `bot.log` only from line 122714, inside attempt #710 which was in flight and never logged; the campaign window (119400–122713) contains **zero** credit errors, and all 33 collected attempts have non-zero step counts. Nothing is discarded. `conf_on` holds 7 of 13 tasks and must be re-run from scratch on resume, since arms are never mixed across partial task sets. **Superseded 2026-08-12 — see the row below; the whole segment was discarded and backtest 1 re-run.** | 0 |
| 2026-08-12 | `conf_gates` / `conf_off` / `conf_on` backtest 1 | 3 (run-level) | **Whole interrupted segment discarded on resume; backtest 1 re-run from scratch.** Rule 3 covers the *run*: the runner terminated mid-backtest on credit exhaustion. The 33 individual attempts were clean, so this is a run-level discard of a segment that could not be completed without corrupting a covariate — not an attempt-level fault, and explicitly not because any result looked wrong (`gates` 12/13, `off` 5/13, `on` 5/7 at the time of the decision; the direction of all three is unchanged by discarding them). The 2026-08-09 row above planned to keep `conf_gates` (13) and `conf_off` (13) and re-run only `conf_on`. That plan was reversed before any resume run, on two grounds that are independent of the results. (1) **Arm position would have been recorded falsely.** `field_trial.sh` numbers `ARM_POSITION` from 1 within each invocation, but the 5 outstanding arms truly occupy positions 3–7 of backtest 1's randomized order (`gates off on reflexes perception verify autofinish`). Recording them as 1–5 corrupts a covariate the campaign exists to control; the alternatives were editing the frozen runner mid-campaign or hand-patching receipt rows, both worse. (2) **It would have given `gates` and `off` a unique 13/52 share of pre-pause data** across a 3-day gap, while the other five arms sat entirely post-pause. `gates` is the arm carrying the unresolved 100%-success anomaly, so a confound touching only that arm is the one least affordable. Cost of discarding: 26 valid attempts, ≈1.4 h of a ≈15.6 h campaign. Attempts are retained in the database and marked in `exclusions`; nothing is deleted. | 33 |
| 2026-08-08 | `bench_on` seed 3 | 3 | **Agent wedged holding the action-execution lock.** After #516 the log repeats `waiting for code to finish executing...` indefinitely with `executing=true` and no active task; every subsequent task was cancelled in 0–30 s at 0 steps. Attempts #517–#526. The runner restarts the bot only between arms, so one wedge poisoned the rest of the arm. | 10 |

---

### Pre-freeze aborts, for the record

Field Trial v1 (2026-07-19) aborted runs 2–6 before a clean run 7. These predate
this protocol and are reported as pilot-phase pipeline debugging, not as
protocol-governed aborts. Rows survive in `pincercraft_evals.db` under
`task_set = bench_on_aborted_r2 … r6` (11 attempts total).

Known causes from that phase, reconstructed from the improvement log: tidy-reflex
re-trigger (fixed `8c7ac32`), the run-4 pre-spawn wedge (fixed by `wait_spawn`),
and inventory inheritance between arms.
