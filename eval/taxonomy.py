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
    scorer  what was actually true   task_attempts.success
"""
import argparse, glob, json, os, sqlite3, sys
from collections import Counter, defaultdict

# Imported rather than reimplemented: two copies of the primary-set rule, the
# claim rule or the categories would drift, and all three decide what the
# paper's rates are computed over.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analysis_rules import (  # noqa: E402
    CATEGORIES, claimed, classify, excluded_task_name)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
from eval_db import DB_PATH as DB  # noqa: E402  single env-aware definition
# Derived from the ledger's location, not this file's. The evidence files are
# part of the same ledger and are gitignored, so they exist only beside the DB
# — resolving them relative to the checkout finds an empty directory in a
# worktree and silently reports every claim as inferred.
EV_DIR = os.path.join(os.path.dirname(os.path.abspath(DB)), 'eval', '.referee')

def load_claims():
    """task_id -> what the AGENT said. Kept apart from the scorer verdict on
    purpose: collapsing them is exactly the error the campaign measures.

    `task_id` is unique per attempt (verified over all 287 bench+conf rows), so
    this is a per-attempt lookup, not a per-task one."""
    out = {}
    for p in glob.glob(os.path.join(EV_DIR, '*.evidence.json')):
        try:
            d = json.load(open(p))
            out[str(d.get('task_id'))] = d.get('outcome')
        except Exception:
            continue
    return out


def resolve_claim(row, claims):
    """(claimed, inferred) — did the agent declare the task complete?

    The evidence file is the authoritative agent-claim signal (terminology §4).
    When one is missing the claim is INFERRED from `failure_mode` using the same
    rule as campaign_report, rather than defaulted to "did not claim": a missing
    measurement is not a signal value, and treating it as one invented ten
    phantom reached-not-recognized outcomes in the full harness the first time this ran.

    The fallback is validated, not assumed — the two derivations agree on
    256/256 attempts that carry both."""
    outcome = claims.get(str(row['task_id']))
    if outcome is not None:
        return outcome == 'done', False
    return bool(claimed(row['success'], row['failure_mode'])), True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seeds', help='comma-separated replicate numbers')
    ap.add_argument('--arms', help='comma-separated arm names')
    ap.add_argument('--task-set-prefix', default='bench')
    ap.add_argument('--include-pilot', action='store_true',
                    help='include seed 0 (the July field trial, pre-campaign)')
    ap.add_argument('--include-excluded', action='store_true',
                    help='include the task excluded from the primary set (§4)')
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
    excl_name = excluded_task_name(a.task_set_prefix)

    per_arm = defaultdict(Counter)
    n_pilot = n_excluded = n_inferred = 0
    for r in rows:
        # Default to the campaign proper. Seed 0 is the July field trial, run
        # before the protocol was frozen and under a different rig; pooling it
        # with campaign replicates silently mixes two regimes, and it carries no
        # evidence files at all.
        if not a.include_pilot and (r['seed'] or 0) == 0:
            n_pilot += 1
            continue
        if seeds is not None and r['seed'] not in seeds:
            continue
        if not a.include_excluded and r['task_name'] == excl_name:
            n_excluded += 1
            continue
        arm = (r['task_set'] or '').split('_', 1)[1] if '_' in (r['task_set'] or '') else '?'
        if arms is not None and arm not in arms:
            continue
        claim, inferred = resolve_claim(r, claims)
        n_inferred += inferred
        per_arm[arm][classify(r, claim, discarded)] += 1

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
    if n_pilot:
        print(f'skipped {n_pilot} pre-campaign attempt(s) at seed 0 '
              f'(--include-pilot to keep)')
    if n_excluded:
        print(f'skipped {n_excluded} attempt(s) at the task excluded from the '
              f'primary set (--include-excluded to keep)')
    if n_inferred:
        print(f'{n_inferred} attempt(s) had no evidence file; agent claim '
              f'inferred from failure_mode')


if __name__ == '__main__':
    main()
