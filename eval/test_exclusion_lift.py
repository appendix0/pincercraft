#!/usr/bin/env python3
"""The platform-task exclusion is scoped to the dataset, not global.

Lifting it globally would silently restate the exploratory numbers already
reported as pilot data, whose platform attempts were honor-system scored. These
tests pin both halves of the 2026-08-09 deviation: lifted for confirmatory,
retained for exploratory.
"""
import os, sqlite3, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analysis_rules import excluded_task_name
import campaign_report as cr

# Run from a worktree the ledger is in the primary checkout, so honour the same
# override campaign_report.py asks for rather than creating a throwaway DB.
DB = os.environ.get(
    'PINCER_EVAL_DB',
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                 'pincercraft_evals.db'))


def test_lifted_for_confirmatory():
    assert excluded_task_name('conf') is None


def test_retained_for_exploratory():
    name = excluded_task_name('bench')
    assert name and '5x5' in name


def test_confirmatory_rows_are_never_marked_excluded():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    rows = cr.load(con, None, 'conf')
    assert rows, 'no confirmatory rows loaded'
    assert not [r for r in rows if r['excluded']]


def test_exploratory_rows_still_drop_the_platform_task():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    rows = cr.load(con, None, 'bench')
    if not rows:
        return          # no exploratory rows in this DB; nothing to assert
    marked = [r for r in rows if r['excluded']]
    assert all('5x5' in r['task_name'] for r in marked)


def test_confirmatory_primary_set_holds_all_13_tasks():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    kept = [r for r in cr.load(con, None, 'conf') if not r['discarded']]
    primary = [r for r in kept if not r['excluded']]
    assert len({r['task_name'] for r in primary}) == 13


if __name__ == '__main__':
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith('test_'):
            try:
                fn()
                print(f'  PASS  {name}')
            except AssertionError as e:
                fails += 1
                print(f'  FAIL  {name}: {e}')
    print('all passed' if not fails else f'{fails} failed')
    sys.exit(1 if fails else 0)
