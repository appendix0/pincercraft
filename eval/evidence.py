#!/usr/bin/env python3
"""Blind-labelling evidence cards.

    cards  [--all] [--limit N] [--out FILE]   render cards for human labelling
    status                                    progress toward the n=40 target

The calibration protocol (docs/paper/preregistration.md §5) needs a human to
judge an attempt from ground truth WITHOUT seeing the scorer's verdict. This
renders one card per attempt containing the task, what the bot claimed, and the
inventory before/after — and deliberately omits the scorer's call and the DB's
`success` column.

Showing ground truth to the labeller is intentional and is not circular: the
scorer applies one rule to that state, the human sees everything and can catch
a criterion the rule mis-encodes. Attempt #322 — an LLM-authored `end_factor`
written backwards — was exactly that case, and a protocol that hid the inventory
from the human would have scored it as agreement.

Evidence files are written by `referee.mjs judge`, so only attempts run after
that change have cards. Read the output, then label with:

    python3 eval/agreement.py label <task_id> <0|1> [notes]
"""
import json, os, sqlite3, sys, glob, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'eval'))
from eval_db import DB_PATH as DB  # noqa: E402  single env-aware definition
# Beside the ledger, not beside this file — see the note in taxonomy.py.
EV_DIR = os.path.join(os.path.dirname(os.path.abspath(DB)), 'eval', '.referee')
TARGET = 40
# Pre-registration freeze. Labels before this are pilot data — they developed the
# grammar they test, so §5 keeps them out of the confirmatory set rather than
# pooling them. Counting them toward the target would inflate progress.
FREEZE = '2026-08-07'


def labeled_ids(con, since=None):
    """task_ids already carrying a human call, so cards aren't re-issued.

    `since` restricts to labels recorded on/after a date — used to count the
    confirmatory set without the pilot rows."""
    q = "SELECT notes FROM gold_attempts WHERE notes LIKE '%agree:task_id=%'"
    params = ()
    if since:
        q += " AND timestamp >= ?"
        params = (since,)
    out = set()
    for (notes,) in con.execute(q, params).fetchall():
        m = re.search(r'agree:task_id=(\d+)', notes or '')
        if m:
            out.add(int(m.group(1)))
    return out


def load_evidence():
    recs = []
    for p in glob.glob(os.path.join(EV_DIR, '*.evidence.json')):
        try:
            with open(p) as f:
                recs.append(json.load(f))
        except Exception as e:
            print(f'  (skipping unreadable {os.path.basename(p)}: {e})', file=sys.stderr)
    return sorted(recs, key=lambda r: int(r.get('task_id', 0)))


def diff_inventory(start, end):
    """Every item whose count moved. The strongest single piece of evidence:
    it shows what the attempt actually did, not what it said it did."""
    start, end = start or {}, end or {}
    rows = []
    for item in sorted(set(start) | set(end)):
        a, b = start.get(item, 0), end.get(item, 0)
        if a != b:
            rows.append((item, a, b, b - a))
    return sorted(rows, key=lambda r: -abs(r[3]))


def card(rec, con):
    tid = rec.get('task_id')
    att = con.execute(
        'SELECT difficulty_tier, wall_clock_seconds FROM task_attempts '
        'WHERE task_id=? ORDER BY rowid DESC LIMIT 1', (str(tid),)).fetchone()
    tier, secs = att if att else ('?', None)

    L = []
    L.append(f'### Attempt #{tid}')
    L.append('')
    L.append(f'- **Task:** {rec.get("description", "?")}')
    L.append(f'- **Stated criterion:** `{rec.get("end_factor") or "(none)"}`')
    # The arm is deliberately NOT shown. Hiding only the scorer's verdict is
    # not enough: knowing an attempt came from an ablated arm primes the
    # labeller toward failure, and the labels are the apex that certifies the
    # scorer — a bias channel there propagates into every rate the paper
    # reports. Tier and duration stay; neither identifies the condition.
    L.append(f'- **Tier:** {tier}'
             + (f' · {secs:.0f}s' if isinstance(secs, (int, float)) else ''))
    L.append('')
    claim = rec.get('outcome')
    said = {'done': 'reported the task DONE',
            'cancel': 'CANCELLED the task',
            'timeout': 'TIMED OUT'}.get(claim, f'ended as `{claim}`')
    L.append(f'**The bot {said}.**')
    L.append('')

    if rec.get('inv_end') is None:
        L.append('> Final inventory unavailable (read failed at judge time) — '
                 'label only if the task text and claim are enough, else skip.')
        L.append('')
    else:
        d = diff_inventory(rec.get('inv_start'), rec.get('inv_end'))
        if not d:
            L.append('**Inventory change: none.** Nothing in the bot\'s inventory moved.')
        else:
            L.append('**Inventory change**')
            L.append('')
            L.append('| item | before | after | delta |')
            L.append('|---|---:|---:|---:|')
            for item, a, b, delta in d:
                L.append(f'| {item} | {a} | {b} | {delta:+d} |')
        L.append('')

    if rec.get('baseline') == 'post-add':
        L.append('> Baseline was taken *after* the task was added, so work done in the '
                 'first seconds may not appear above. Weigh this if the delta looks short.')
        L.append('')
    L.append(f'**Your call:** `python3 eval/agreement.py label {tid} 1` if the task was '
             f'genuinely accomplished, `0` if not.')
    L.append('')
    L.append('---')
    L.append('')
    return '\n'.join(L)


def cards(show_all, limit, out_path):
    con = sqlite3.connect(DB)
    done = labeled_ids(con)
    recs = load_evidence()
    if not recs:
        sys.exit(f'no evidence files in {EV_DIR} — these are written by '
                 '`referee.mjs judge`, so run a cycle first')
    pending = [r for r in recs if show_all or int(r.get('task_id', 0)) not in done]
    if not pending:
        sys.exit(f'all {len(recs)} attempts with evidence are already labeled '
                 f'({len(done)} human labels on record)')
    if limit:
        pending = pending[:limit]

    confirm = labeled_ids(con, since=FREEZE)
    body = [
        '# Blind labelling cards',
        '',
        f'{len(pending)} attempt(s) to judge. **{len(confirm)}/{TARGET}** confirmatory '
        f'labels on record.',
        '',
        'For each card: read the task, read what the bot claimed, look at what actually '
        'changed, and decide whether the task was genuinely accomplished. The scorer\'s '
        'verdict is deliberately not shown — that comparison is the measurement.',
        '',
        'Judge the *task as written*, not the criterion. If the criterion is wrong but the '
        'bot did the task, that is a success (and worth a note).',
        '',
        '---',
        '',
    ]
    body += [card(r, con) for r in pending]
    text = '\n'.join(body)

    if out_path:
        with open(out_path, 'w') as f:
            f.write(text)
        print(f'wrote {len(pending)} card(s) to {out_path}')
    else:
        print(text)


def status():
    con = sqlite3.connect(DB)
    done = labeled_ids(con)
    confirm = labeled_ids(con, since=FREEZE)
    recs = load_evidence()
    have = {int(r.get('task_id', 0)) for r in recs}
    print(f'confirmatory labels    : {len(confirm)}/{TARGET}   (on/after {FREEZE})')
    print(f'pilot labels           : {len(done - confirm)}        (pre-freeze, reported '
          f'separately, not pooled)')
    print(f'attempts with evidence : {len(recs)}')
    print(f'awaiting a label       : {len(have - done)}')
    if len(confirm) < TARGET:
        print(f'\nstill need {TARGET - len(confirm)} label(s) for the confirmatory set '
              f'(preregistration.md §5)')


if __name__ == '__main__':
    args = sys.argv[1:]
    if args and args[0] == 'cards':
        limit = None
        out = None
        if '--limit' in args:
            limit = int(args[args.index('--limit') + 1])
        if '--out' in args:
            out = args[args.index('--out') + 1]
        cards('--all' in args, limit, out)
    elif args == ['status']:
        status()
    else:
        sys.exit(__doc__)
