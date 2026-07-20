#!/usr/bin/env python3
"""Package the eval ledger + episode traces as a Hugging Face dataset.

Writes eval/hf_export/ (gitignored):
    README.md               dataset card
    data/task_attempts.jsonl   full attempt ledger (referee + honor labels)
    data/gold_labels.jsonl     human gold labels (calibration set)
    data/metrics.jsonl         per-task token/cache/cost metrics
    data/code_changes.jsonl    self-improvement loop: what it changed and why
    data/gate_decisions.jsonl  human approve/reject gate on proposed patches
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
  across gain (+N), loss (-N), and cancel criteria (`gold_labels.jsonl`).
- Caveat: the off arm inherited a stocked inventory (an easier setup) and
  still went 1/9 — the gap is conservative. `bench_on_aborted_r*` sets are
  quarantined rows from aborted runs (runner bugs, fixed); keep or drop.

## Files — and which design claim each one evidences

The agent's five pillars (see the
[README](https://github.com/appendix0/pincercraft#the-five-features-that-matter)):
1. deterministic layer (perception / gates / reflexes / referee),
2. event-driven orchestrator, 3. loop guards + caching, 4. in-world rulebook,
5. a self-improvement loop held behind a human gate.

- `data/task_attempts.jsonl` — one row per task attempt; **evidences the
  referee (pillar 1-4) and the say-do gap.** Key fields: `task_id`,
  `task_name`, `task_set`, `success` (0/1), `label_source` (`referee` =
  measured from world-state delta; `honor_system` = unmeasurable criterion,
  model self-report — do not trust these, that is the point of the dataset),
  `failure_mode` (`false_done_referee` = claimed done, world disagreed),
  `end_factor` (the success criterion), `wall_clock_seconds`,
  `input_tokens`/`output_tokens`, `commit_hash`.
- `data/gold_labels.jsonl` — human labels recorded blind before/alongside
  referee verdicts (`notes` carries the task_id mapping); **evidences the
  referee calibration** (11/12).
- `data/metrics.jsonl` — per-task token accounting; **evidences the
  orchestrator + cache-first prompt layout (pillars 2-3)**: `cache_hit_ratio`
  (mean 0.79 across 43 measured tasks — ~79% of prompt tokens read from
  cache instead of re-billed), `billable_tokens`, `tokens_per_turn`,
  `est_cost_usd`, cost split by convo vs. coding turns.
- `data/code_changes.jsonl` + `data/gate_decisions.jsonl` — **evidence the
  self-improvement loop (pillar 5)**: what the loop changed, in which files,
  and why (20 rows) — and the human approve/reject gate its patches must
  pass, with reasons (7 rows). Nothing merges itself.
- `episodes/<task_id>.jsonl` — action-level trace per task: tool calls with
  outcomes, timings, and episode start/end markers. **The reflexes (pillar
  1-3) are visible here in the raw**: compare `episodes/299.jsonl` (before
  the search-miss reflex: ~24 LLM rounds hunting spiders on a peaceful
  world) with `episodes/302.jsonl` (after: two searches, then park the task
  and ask the player). Worked narrative:
  [the search-miss receipt](https://github.com/appendix0/pincercraft/blob/develop/docs/receipts/2026-07-12-search-miss-before-after.md).

Not evidenced by rows here, by nature: the in-world rulebook (pillar 4 — a
design feature; its receipt is the
[Groot story](https://github.com/appendix0/pincercraft#4-players-write-house-rules-inside-minecraft))
and per-turn perception injection (pillar 1-1 — it is in every prompt, not a
data artifact).

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
    dump_table(db, 'code_changes', OUT / 'data' / 'code_changes.jsonl')
    dump_table(db, 'gate_decisions', OUT / 'data' / 'gate_decisions.jsonl')
    shutil.copy(ROOT / 'eval' / 'metrics.jsonl', OUT / 'data' / 'metrics.jsonl')

    n_ep = 0
    for ep in sorted((ROOT / 'bots' / 'Daedelus404' / 'episodes').glob('*.jsonl')):
        shutil.copy(ep, OUT / 'episodes' / ep.name)
        n_ep += 1

    (OUT / 'README.md').write_text(CARD)
    print(f'wrote {OUT}: {n_att} attempts, {n_gold} gold labels, {n_ep} episodes')


if __name__ == '__main__':
    main()
