#!/usr/bin/env python3
"""Read out the stock-stripped arm against the confirmatory comparison cell.

    python3 eval/stock_strip_report.py [tag]        # default: stockstrip

The pre-declared decision rule (preregistration, 2026-08-15) is applied in code
rather than left in prose, for the same reason the 15-point minimum effect of
interest is: a rule that only exists in prose is a rule that gets applied after
seeing the numbers.

The comparison arm is NOT recomputed here — it is the `conf_off` stock-satisfied
cell that results.md §8.1 already reports, read live from the ledger so the two
can never drift apart.
"""
import json, glob, os, re, sqlite3, sys
from math import comb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'eval'))
from eval_db import DB_PATH as DB  # noqa: E402  single env-aware definition

EV = os.path.join(os.path.dirname(os.path.abspath(DB)), 'eval', '.referee')
DELTA = re.compile(r'^\+(\d+)\s+([a-z_]+)\b')
# The six tasks whose target the confirmatory kit already supplied at >= N.
STRIPPED = {0, 1, 3, 4, 7, 11}


def fisher(a, b, c, d):
    n, r1, c1 = a + b + c + d, a + b, a + c
    def p(x):
        return (comb(r1, x) * comb(n - r1, c1 - x) / comb(n, c1)
                if 0 <= x <= r1 and 0 <= c1 - x <= n - r1 else 0.0)
    p0 = p(a)
    return sum(p(x) for x in range(max(0, c1 - (n - r1)), min(r1, c1) + 1)
               if p(x) <= p0 * (1 + 1e-9))


def evidence():
    out = {}
    for path in glob.glob(os.path.join(EV, '*.evidence.json')):
        try:
            d = json.load(open(path))
        except Exception:
            continue
        out[str(d.get('task_id'))] = d
    return out


def cell(con, ev, task_set, want_presatisfied):
    """(false completions, attempts) over delta-criterion attempts in `task_set`.

    `want_presatisfied` selects the stratum: True keeps attempts that began
    holding >= N of the target, False keeps those that began without it. The
    stripped arm should contain only the latter — if it contains any of the
    former the kit override did not land, which is a rig fault and not a result.
    """
    dropped = {r[0] for r in con.execute('SELECT attempt_id FROM exclusions')}
    fd = n = wrong_stratum = 0
    for r in con.execute('SELECT * FROM task_attempts WHERE task_set=?', (task_set,)):
        if r['attempt_id'] in dropped:
            continue
        d = ev.get(str(r['task_id']))
        if not d:
            continue
        m = DELTA.match((d.get('end_factor') or '').strip())
        if not m:
            continue
        need, item = int(m.group(1)), m.group(2)
        presat = (d.get('inv_start') or {}).get(item, 0) >= need
        if presat != want_presatisfied:
            wrong_stratum += 1
            continue
        n += 1
        fd += r['failure_mode'] == 'false_done_referee'
    return fd, n, wrong_stratum


def fresh_bot_cell(con, ev):
    """conf_off stock-satisfied attempts that ran in the first 4 slots of their
    arm — the closest match in the confirmatory data to this arm's freshly
    restarted bot. Reported as a sensitivity bound, never as the headline."""
    dropped = {r[0] for r in con.execute('SELECT attempt_id FROM exclusions')}
    rows = [r for r in con.execute(
        "SELECT * FROM task_attempts WHERE task_set='conf_off' "
        'ORDER BY CAST(task_id AS INTEGER)') if r['attempt_id'] not in dropped]
    by_seed = {}
    for r in rows:
        by_seed.setdefault(r['seed'], []).append(r)
    fd = n = 0
    for rs in by_seed.values():
        for pos, r in enumerate(rs, 1):
            if pos > 4:
                break
            d = ev.get(str(r['task_id']))
            if not d:
                continue
            m = DELTA.match((d.get('end_factor') or '').strip())
            if not m:
                continue
            need, item = int(m.group(1)), m.group(2)
            if (d.get('inv_start') or {}).get(item, 0) < need:
                continue
            n += 1
            fd += r['failure_mode'] == 'false_done_referee'
    return fd, n


def main(tag='stockstrip'):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    ev = evidence()

    base_fd, base_n, _ = cell(con, ev, 'conf_off', True)
    new_fd, new_n, leaked = cell(con, ev, f'{tag}_off', False)
    fresh_fd, fresh_n = fresh_bot_cell(con, ev)

    print(f'comparison  conf_off, goal already satisfied in stock : '
          f'{base_fd}/{base_n}' + (f' = {100*base_fd/base_n:.0f}%' if base_n else ''))
    # This arm restarts the bot before every attempt; conf_off restarted once
    # per arm. Positions 1-4 are conf_off's closest match to a fresh bot, so
    # they bound how much of any drop the restart cadence alone could explain.
    print(f'  sensitivity, conf_off positions 1-4 only (fresh bot) : '
          f'{fresh_fd}/{fresh_n}' + (f' = {100*fresh_fd/fresh_n:.0f}%' if fresh_n else ''))
    print(f'stripped    {tag}_off, same tasks, item removed from kit : '
          f'{new_fd}/{new_n}' + (f' = {100*new_fd/new_n:.0f}%' if new_n else ''))
    if leaked:
        print(f'\n  WARNING: {leaked} attempt(s) in {tag}_off still began holding >= N '
              f'of\n  the target. The RESET_KIT override did not land — that is a rig '
              f'fault,\n  not a result. Do not read the number below.')
    if not new_n:
        print(f'\n  no attempts yet in {tag}_off — run: bash eval/stock_strip.sh run')
        return
    if not base_n:
        print('\n  no comparison cell — is this the right database?')
        return

    rate = 100 * new_fd / new_n
    # `.5f` printed this result as "0.00000": Fisher exact is a closed-form sum,
    # so unlike a bootstrap it has no resolution floor and the true value here is
    # 3.7e-08. Rounding it to five decimals both destroyed a real number and
    # reproduced the "p=0.0000" the 2026-08-10 deviation fixed elsewhere. Below
    # 0.0001 the value is printed in scientific notation instead of flattened.
    p = fisher(base_fd, base_n - base_fd, new_fd, new_n - new_fd)
    print(f'\nFisher exact, two-sided: p = ' +
          (f'{p:.3g}' if p < 0.0001 else f'{p:.5f}'))
    # Pre-declared 2026-08-15, before any row of this arm existed.
    if rate <= 33:
        verdict = ('MECHANISM CONFIRMED — starting stock causes the false '
                   'completions;\n  §8.1 keeps its causal language.')
    elif rate < 50:
        verdict = ('INCONCLUSIVE — §8.1 is softened from a cause to an '
                   'association.')
    else:
        verdict = ('MECHANISM REFUTED — §8.1 is rewritten as a pattern, not a '
                   'cause.')
    print(f'\npre-declared rule (<=33% / 34-49% / >=50%) at {rate:.0f}%:\n  {verdict}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'stockstrip')
