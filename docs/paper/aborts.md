# Abort log

Every discarded run or attempt, written **at the time of the abort**.
Governed by §8 of [preregistration.md](preregistration.md): a run may be discarded
only for a declared infrastructure fault (rules 1–4), never because the result
looked wrong.

The discard rate computed from this file is reported in the paper.

| Date (UTC) | Run tag | Rule | Cause | Attempts lost |
|---|---|---|---|---|
| — | — | — | — | — |

---

### Pre-freeze aborts, for the record

Field Trial v1 (2026-07-19) aborted runs 2–6 before a clean run 7. These predate
this protocol and are reported as pilot-phase pipeline debugging, not as
protocol-governed aborts. Rows survive in `pincercraft_evals.db` under
`task_set = bench_on_aborted_r2 … r6` (11 attempts total).

Known causes from that phase, reconstructed from the improvement log: tidy-reflex
re-trigger (fixed `8c7ac32`), the run-4 pre-spawn wedge (fixed by `wait_spawn`),
and inventory inheritance between arms.
