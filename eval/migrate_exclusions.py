#!/usr/bin/env python3
"""One-shot migration: turn the '*_aborted_*' task_set retags into exclusions.

    python3 eval/migrate_exclusions.py [--dry-run]

Two aborts (docs/paper/aborts.md) were originally recorded by REWRITING
`task_set` on the affected rows. That mutates raw receipts: after the rewrite
the row no longer says which arm it actually ran under, so the analysis can no
longer be re-derived from the evidence. This moves each discard into the
`exclusions` table, keyed on attempt_id, and restores the original arm name.

Idempotent, and safe to re-run: rows already migrated no longer match.
"""
import argparse, os, re, sqlite3, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eval_db  # noqa: E402

# suffix -> (§8 rule, reason). Both are rule 3: a fault in the rig, not the agent.
CAUSES = {
    's2credit': (3, 'Anthropic API credit exhausted mid-campaign; every LLM call '
                    'returned 400, attempts ran to the full timeout at 0 turns'),
    's3wedge': (3, 'agent wedged holding the action-execution lock; subsequent '
                   'attempts cancelled at 0 steps until the arm ended'),
}
PATTERN = re.compile(r'^(bench_[a-z]+)_aborted_([a-z0-9]+)$')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    con = sqlite3.connect(eval_db.DB_PATH)
    con.row_factory = sqlite3.Row
    eval_db.connect(eval_db.DB_PATH).close()  # ensure the exclusions table exists

    # Campaign rows only (seed > 0). Field Trial v1's `bench_on_aborted_r2..r6`
    # are seed-0 pilot rows, documented in aborts.md as pre-freeze and already
    # outside every analysis selector. Rewriting them would edit pilot history
    # to no benefit.
    rows = con.execute(
        "SELECT attempt_id, task_id, task_set FROM task_attempts "
        "WHERE task_set LIKE '%\\_aborted\\_%' ESCAPE '\\' AND seed > 0").fetchall()
    if not rows:
        print('nothing to migrate — no *_aborted_* task_set values remain')
        return

    plan = []
    for r in rows:
        m = PATTERN.match(r['task_set'])
        if not m:
            sys.exit(f"unrecognised aborted tag {r['task_set']!r} — refusing to guess "
                     "the original arm name")
        original, suffix = m.group(1), m.group(2)
        if suffix not in CAUSES:
            sys.exit(f'no declared cause for suffix {suffix!r}; add it to CAUSES first')
        rule, reason = CAUSES[suffix]
        plan.append((r['attempt_id'], r['task_id'], r['task_set'], original, rule, reason))

    by_tag = {}
    for _, _, tag, original, _, _ in plan:
        by_tag.setdefault((tag, original), 0)
        by_tag[(tag, original)] += 1
    for (tag, original), n in sorted(by_tag.items()):
        print(f'  {n:>3} attempts  {tag}  ->  task_set={original} + exclusions row')

    if a.dry_run:
        print(f'\ndry run — {len(plan)} attempt(s) would be migrated')
        return

    # Both writes go through THIS connection: opening a second one while this
    # transaction is live deadlocks on sqlite's writer lock, and the exclusion
    # and the arm-name restore must land atomically anyway — a half-applied
    # migration would leave attempts excluded under a rewritten arm name.
    now = eval_db._now()
    for attempt_id, task_id, _, original, rule, reason in plan:
        con.execute(
            'INSERT OR REPLACE INTO exclusions '
            '(attempt_id,task_id,rule,reason,excluded_at,source) VALUES (?,?,?,?,?,?)',
            (attempt_id, str(task_id), str(rule), reason, now, 'migrate_exclusions'))
        con.execute('UPDATE task_attempts SET task_set=? WHERE attempt_id=?',
                    (original, attempt_id))
    con.commit()
    print(f'\nmigrated {len(plan)} attempt(s); arm names restored, discards now '
          'recorded by reference')


if __name__ == '__main__':
    main()
