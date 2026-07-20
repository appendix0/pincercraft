---
license: mit
pretty_name: "PincerCraft: the say-do gap in an LLM Minecraft agent"
language:
  - en
tags:
  - agents
  - minecraft
  - evaluation
  - llm
  - embodied
task_categories:
  - other
size_categories:
  - n<1K
configs:
  - config_name: task_attempts
    data_files: data/task_attempts.jsonl
  - config_name: gold_labels
    data_files: data/gold_labels.jsonl
  - config_name: metrics
    data_files: data/metrics.jsonl
  - config_name: code_changes
    data_files: data/code_changes.jsonl
  - config_name: gate_decisions
    data_files: data/gate_decisions.jsonl
  - config_name: episodes
    data_files: episodes/*.jsonl
---

# PincerCraft: the say-do gap, measured

Task-attempt ledger, human gold labels, per-task action traces, token/cache
metrics, and the self-improvement loop's change+gate ledger from
[PincerCraft](https://github.com/appendix0/pincercraft), a Minecraft agent
(Mindcraft fork) whose design rule is **"code owns the facts, the LLM owns
the plan."** Every task attempt snapshots inventory before, re-measures
after, and a deterministic referee labels success from the world-state
delta — the model's own "done!" counts for nothing.

## Headline numbers (all traceable to rows below)

- **Field Trial v1** (2026-07-19, `task_set = bench_on` / `bench_off`): the
  same 10 benchmark tasks with the harness on vs. ablated. Referee-verified
  success: **9/9 with the harness, 1/9 without.** Both arms *claimed* 9/9.
  The off-arm failure mode is uniformly `false_done_referee`: done declared
  within 0–16 seconds, referee measuring +0.
- **Referee calibration**: 11/12 (92%) agreement with blind human labels
  across gain (+N), loss (-N), and cancel criteria (`gold_labels`).

## How to load

```python
from datasets import load_dataset

attempts = load_dataset("Appendix0/pincercraft-say-do-gap", "task_attempts")
gap = attempts["train"].filter(
    lambda r: r["task_set"] == "bench_off" and r["failure_mode"] == "false_done_referee")
print(len(gap["task_name"]))  # 8 false-done claims in the ablated arm
```

Configs: `task_attempts`, `gold_labels`, `metrics`, `code_changes`,
`gate_decisions`, `episodes` (one JSONL per task, action-level).

## Dataset structure — and which design claim each config evidences

The agent's five pillars (see the
[README](https://github.com/appendix0/pincercraft#the-five-features-that-matter)):
1. deterministic layer (perception / gates / reflexes / referee),
2. event-driven orchestrator, 3. loop guards + caching, 4. in-world rulebook,
5. a self-improvement loop held behind a human gate.

### `task_attempts` — 72 rows · evidences the referee (pillar 1-4) and the say-do gap

| field | type | meaning |
|---|---|---|
| `task_id`, `task_name` | str | the task as issued |
| `task_set` | str | `bench_on` / `bench_off` = Field Trial arms; `bench_on_aborted_r*` = quarantined aborted runs (runner bugs, fixed — keep or drop); `play`/`explore`/`live` = earlier eval regimes |
| `success` | int 0/1 | the label |
| `label_source` | str | `referee` = measured from world-state delta; `honor_system` = unmeasurable criterion, model self-report — **do not trust these; that is the point of the dataset** |
| `failure_mode` | str | `false_done_referee` = claimed done, world disagreed |
| `end_factor` | str | the success criterion (e.g. `+16 cobblestone in inventory (net gain this run)`) |
| `wall_clock_seconds`, `input_tokens`, `output_tokens`, `steps`, `retry_count` | num | cost of the attempt |
| `commit_hash`, `timestamp`, `task_source`, `rag_version` | str | provenance |

### `gold_labels` — 23 rows · evidences the referee calibration (11/12)

Human labels recorded blind before/alongside referee verdicts. `notes`
carries the `task_id` mapping; `success` is the human call; `source` =
`gold`.

### `metrics` — 49 rows · evidences the orchestrator + cache-first layout (pillars 2-3)

Per-task token accounting: `cache_hit_ratio` (mean 0.79 across 43 measured
tasks — ~79% of prompt tokens read from cache instead of re-billed),
`billable_tokens`, `tokens_per_turn`, `est_cost_usd`, nested `by_kind`
split (convo vs. coding turns), and `work` counters.

### `code_changes` (20 rows) + `gate_decisions` (7 rows) · evidence the self-improvement loop (pillar 5)

What the eval loop changed, in which files, and why — and the human
approve/reject gate its patches must pass, with reasons. Nothing merges
itself.

### `episodes` — 87 files · the reflexes (pillar 1-3), visible in the raw

One JSONL per task: tool calls with `name`, `args`, `outcome`, `ms`,
`result`, plus `episode_start`/`episode_end` markers. Compare
`episodes/299.jsonl` (before the search-miss reflex: ~24 LLM rounds hunting
spiders on a peaceful world) with `episodes/302.jsonl` (after: two searches,
then park the task and ask the player). Worked narrative:
[the search-miss receipt](https://github.com/appendix0/pincercraft/blob/develop/docs/receipts/2026-07-12-search-miss-before-after.md).

Not evidenced by rows here, by nature: the in-world rulebook (pillar 4 — a
design feature; its receipt is the
[Groot story](https://github.com/appendix0/pincercraft#4-players-write-house-rules-inside-minecraft))
and per-turn perception injection (pillar 1-1 — it is in every prompt, not a
data artifact).

## Provenance

Produced by the closed eval loop in the repo (`eval/`): an LLM task-giver
issues tasks, the bot runs them on a private test server, `eval/referee.mjs`
grades from inventory deltas, everything lands in a SQLite ledger. This
package is generated by
[`eval/export_hf.py`](https://github.com/appendix0/pincercraft/blob/develop/eval/export_hf.py)
and is reproducible from the repo. Worked before/after receipts with primary
sources:
[search-miss](https://github.com/appendix0/pincercraft/blob/develop/docs/receipts/2026-07-12-search-miss-before-after.md),
[referee-catches-false-done](https://github.com/appendix0/pincercraft/blob/develop/docs/receipts/2026-07-19-referee-catches-false-done.md).
Models: Claude Sonnet 4.6 (planner + coder).

## Limitations

- **N is small** (72 attempts, 18 in the trial arms) — the methodology and
  export are public precisely so the N can grow.
- Single model (Claude Sonnet 4.6), single environment (Minecraft via
  Mineflayer), one bot. The referee pattern is model- and world-agnostic;
  these numbers are not.
- The referee covers inventory-delta criteria (gather/craft/give), not
  build quality — build tasks carry `label_source = honor_system` and
  should not be trusted (deliberately included as the counter-exhibit).
- The harness-off arm inherited a stocked inventory (an *easier* setup) and
  still went 1/9 — the measured gap is conservative.
- Row counts are as of 2026-07-20; the ledger grows with every eval run.

## Personal and sensitive information

None. The world is a private test server; player names appearing in traces
(`Daedelus404`, the owner's account) are the project's own.

## Citation

```bibtex
@misc{pincercraft2026saydo,
  title   = {PincerCraft: the say-do gap in an LLM Minecraft agent},
  author  = {appendix0},
  year    = {2026},
  url     = {https://huggingface.co/datasets/Appendix0/pincercraft-say-do-gap},
  note    = {Task-attempt ledger, referee verdicts, human gold labels, and
             action traces from a deterministically-harnessed Minecraft agent}
}
```
