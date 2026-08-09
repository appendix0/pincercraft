#!/usr/bin/env python3
"""Outcome taxonomy — DERIVED, never stored.

    python3 eval/taxonomy.py [--seeds 1,2,3] [--arms on,off]

Raw receipts stay immutable; every classification here is recomputed from them
on demand. Storing the label would make the taxonomy un-revisable: when the
rule changes, historical rows would carry the old one and no longer agree with
the code that produced them.

The point of the split is that "the agent failed" hides two different things.
An agent that cannot do the task and an agent that did it but never said so are
both `success=0`, and only the second is a termination problem. Each harness
layer targets one of these, which is why overall success rate is a blunt
endpoint for a per-layer ablation and these categories are sharp ones:

    verify     -> false_completion
    autofinish -> reached_not_recognized

Three independent signals, deliberately never collapsed (preregistration §3):
    agent    what the model claimed   evidence.outcome
    harness  what the harness did     harness_verify / harness_autofinish
    referee  what was actually true   task_attempts.success
"""
import argparse, glob, json, os, sqlite3, sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, 'pincercraft_evals.db')
EV_DIR = os.path.join(ROOT, 'eval', '.referee')

CATEGORIES = [
    'true_completion',          # claimed done, and it was
    'false_completion',         # claimed done, world says otherwise
    'reached_not_recognized',   # goal met, agent never claimed it
    'capability_failure',       # tried, gave up, goal genuinely unmet
    'budget_exhaustion',        # ran out of time with the goal unmet
    'infrastructure',           # the rig, not the agent
]


def load_claims():
    """task_id -> what the AGENT said. Kept apart from the referee verdict on
    purpose: collapsing them is exactly the error the campaign measures."""
    out = {}
    for p in glob.glob(os.path.join(EV_DIR, '*.evidence.json')):
        try:
            d = json.load(open(p))
            out[str(d.get('task_id'))] = d.get('outcome')
        except Exception:
            continue
    return out


def classify(row, claim, discarded=frozenset()):
    """One attempt -> one category. `row` is a task_attempts record.

    `discarded` holds attempt_ids recorded in the `exclusions` table."""
    # Infrastructure first: a bot that could not act never produced a result to
    # classify, and scoring it as a capability failure is how a credit outage
    # once read as a 61pp layer effect (docs/paper/aborts.md).
    if row['attempt_id'] in discarded:
        return 'infrastructure'
    if (row['steps'] or 0) == 0 and (row['failure_mode'] or '') == 'timeout':
        return 'infrastructure'

    success = bool(row['success'])
    claimed = claim == 'done'

    if success:
        return 'true_completion' if claimed else 'reached_not_recognized'
    if claimed:
        return 'false_completion'
    if (row['failure_mode'] or '') == 'timeout':
        return 'budget_exhaustion'
    return 'capability_failure'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seeds', help='comma-separated backtest numbers')
    ap.add_argument('--arms', help='comma-separated arm names')
    ap.add_argument('--task-set-prefix', default='bench')
    a = ap.parse_args()

    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    claims = load_claims()
    con.execute("CREATE TABLE IF NOT EXISTS exclusions (attempt_id TEXT PRIMARY KEY, "
                "task_id TEXT, rule TEXT, reason TEXT, excluded_at TEXT, source TEXT)")
    discarded = {r[0] for r in con.execute('SELECT attempt_id FROM exclusions')}
    rows = con.execute(
        "SELECT * FROM task_attempts WHERE task_set LIKE ? ESCAPE '\\'",
        (a.task_set_prefix.replace('_', r'\_') + r'\_%',)).fetchall()

    seeds = {int(s) for s in a.seeds.split(',')} if a.seeds else None
    arms = set(a.arms.split(',')) if a.arms else None

    per_arm = defaultdict(Counter)
    for r in rows:
        if seeds is not None and r['seed'] not in seeds:
            continue
        arm = (r['task_set'] or '').split('_', 1)[1] if '_' in (r['task_set'] or '') else '?'
        if arms is not None and arm not in arms:
            continue
        per_arm[arm][classify(r, claims.get(str(r['task_id'])), discarded)] += 1

    if not per_arm:
        sys.exit('no rows matched')

    width = max(len(a_) for a_ in per_arm) + 2
    print('OUTCOME TAXONOMY (derived; raw receipts unchanged)\n')
    print(' ' * width + ''.join(f'{c[:13]:>15}' for c in CATEGORIES))
    for arm in sorted(per_arm):
        counts = per_arm[arm]
        print(f'{arm:<{width}}' + ''.join(f'{counts.get(c, 0):>15}' for c in CATEGORIES))
    print('\nverify targets false_completion; autofinish targets '
          'reached_not_recognized.')


if __name__ == '__main__':
    main()
