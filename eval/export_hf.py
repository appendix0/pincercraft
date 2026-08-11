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
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'eval'))
from eval_db import DB_PATH as DB  # noqa: E402  single env-aware definition
OUT = ROOT / 'eval' / 'hf_export'

CARD = (Path(__file__).resolve().parent / 'hf_card.md').read_text()


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

    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    n_att = dump_table(db, 'task_attempts', OUT / 'data' / 'task_attempts.jsonl')
    n_gold = dump_table(db, 'gold_attempts', OUT / 'data' / 'gold_labels.jsonl')
    dump_table(db, 'code_changes', OUT / 'data' / 'code_changes.jsonl')
    dump_table(db, 'gate_decisions', OUT / 'data' / 'gate_decisions.jsonl')
    shutil.copy(ROOT / 'eval' / 'metrics.jsonl', OUT / 'data' / 'metrics.jsonl')

    n_ep = 0
    flat = open(OUT / 'data' / 'episode_events.jsonl', 'w')
    for ep in sorted((ROOT / 'bots' / 'Daedelus404' / 'episodes').glob('*.jsonl')):
        shutil.copy(ep, OUT / 'episodes' / ep.name)
        for line in ep.read_text().splitlines():
            d = json.loads(line)
            flat.write(json.dumps({
                'episode': ep.stem,
                'type': d.get('type'),
                'ts': d.get('ts'),
                'task_id': str(d.get('task_id', '')),
                'source': d.get('source'),
                'name': d.get('name'),
                'args': json.dumps(d.get('args')) if d.get('args') is not None else None,
                'outcome': d.get('outcome'),
                'ms': d.get('ms'),
                'result': str(d.get('result', ''))[:2000] or None,
            }) + '\n')
        n_ep += 1
    flat.close()

    (OUT / 'README.md').write_text(CARD)
    print(f'wrote {OUT}: {n_att} attempts, {n_gold} gold labels, {n_ep} episodes')


if __name__ == '__main__':
    main()
