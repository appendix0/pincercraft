# Abort log

Every discarded run or attempt, written **at the time of the abort**.
Governed by §8 of [preregistration.md](preregistration.md): a run may be discarded
only for a declared infrastructure fault (rules 1–4), never because the result
looked wrong.

The discard rate computed from this file is reported in the paper.

| Date (UTC) | Run tag | Rule | Cause | Attempts lost |
|---|---|---|---|---|
| 2026-08-07 | `bench_measurement` seed 2 | 3 | **Anthropic API credit exhausted mid-campaign.** Every LLM call returned `400 ... "Your credit balance is too low to access the Anthropic API"`. The bot stayed connected and received drive nudges, but took 0 turns; all 10 attempts ran to the full 480 s timeout with inventory unchanged. Attempts #490–#499. Detected 2026-08-08 while investigating the layer's 61.1 pp drop. | 10 |
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
