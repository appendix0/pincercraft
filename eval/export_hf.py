#!/usr/bin/env python3
"""Package the eval ledger + episode traces as a Hugging Face dataset.

Writes eval/hf_export/ (gitignored):
    README.md               dataset card
    data/task_attempts.jsonl   full attempt ledger (referee + honor labels)
    data/gold_labels.jsonl     human gold labels (calibration set)
    episodes/<task_id>.jsonl   per-task action traces

Upload (needs an HF account; the repo name is a suggestion):
    huggingface-cli upload <user>/pincercraft-say-do-gap eval/hf_export . --repo-type dataset
"""
import json
import shutil
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'eval' / 'hf_export'

CARD = '''---
license: mit
pretty_name: "PincerCraft: the say-do gap in an LLM Minecraft agent"
tags:
  - agents
  - minecraft
  - evaluation
  - llm
  - embodied
task_categories:
  - other
---

# PincerCraft: the say-do gap, measured

Task-attempt ledger, human gold labels, and per-task action traces from
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
  across gain (+N), loss (-N), and cancel criteria (`gold_labels.jsonl`).
- Caveat: the off arm inherited a stocked inventory (an easier setup) and
  still went 1/9 — the gap is conservative. `bench_on_aborted_r*` sets are
  quarantined rows from aborted runs (runner bugs, fixed); keep or drop.

## Files

- `data/task_attempts.jsonl` — one row per task attempt. Key fields:
  `task_id`, `task_name`, `task_set`, `success` (0/1), `label_source`
  (`referee` = measured from world-state delta; `honor_system` =
  unmeasurable criterion, model self-report — do not trust these, that is
  the point of the dataset), `failure_mode` (`false_done_referee` = claimed
  done, world disagreed), `end_factor` (the success criterion),
  `wall_clock_seconds`, `input_tokens`/`output_tokens`, `commit_hash`.
- `data/gold_labels.jsonl` — human labels recorded blind before/alongside
  referee verdicts (`notes` carries the task_id mapping).
- `episodes/<task_id>.jsonl` — action-level trace per task: tool calls with
  outcomes, timings, and episode start/end markers.

## Provenance

Produced by the closed eval loop in the repo (`eval/`): an LLM task-giver
issues tasks, the bot runs them on a private test server, `eval/referee.mjs`
grades from inventory deltas, everything lands in a SQLite ledger. Worked
before/after receipts with primary sources:
[search-miss](https://github.com/appendix0/pincercraft/blob/develop/docs/receipts/2026-07-12-search-miss-before-after.md),
[referee-catches-false-done](https://github.com/appendix0/pincercraft/blob/develop/docs/receipts/2026-07-19-referee-catches-false-done.md).
Models: Claude Sonnet 4.6 (planner + coder). The bot answers to Daedelus404;
player names appearing in traces are the project's own accounts.
'''


def dump_table(db, table, path):
    rows = [dict(r) for r in db.execute(f'SELECT * FROM {table}')]
    with open(path, 'w') as f:
        for r in rows:
            f.write(json.dumps(r) + '\n')
    return len(rows)


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / 'data').mkdir(parents=True)
    (OUT / 'episodes').mkdir()

    db = sqlite3.connect(ROOT / 'pincercraft_evals.db')
    db.row_factory = sqlite3.Row
    n_att = dump_table(db, 'task_attempts', OUT / 'data' / 'task_attempts.jsonl')
    n_gold = dump_table(db, 'gold_attempts', OUT / 'data' / 'gold_labels.jsonl')

    n_ep = 0
    for ep in sorted((ROOT / 'bots' / 'Daedelus404' / 'episodes').glob('*.jsonl')):
        shutil.copy(ep, OUT / 'episodes' / ep.name)
        n_ep += 1

    (OUT / 'README.md').write_text(CARD)
    print(f'wrote {OUT}: {n_att} attempts, {n_gold} gold labels, {n_ep} episodes')


if __name__ == '__main__':
    main()
