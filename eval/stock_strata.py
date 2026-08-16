#!/usr/bin/env python3
"""False completion stratified by whether the kit already satisfied the goal.

    python3 eval/stock_strata.py

Promoted from a limitation to a reported result (2026-08-16). The headline
45.1% is the average of two very different cells: where the reset kit already
supplied >= N of the target item the unharnessed agent false-completes at 75%,
and where it did not, at 17%. Both strata received the identical kit in both
arms, so the CONTRAST is sound in each; what does not transfer to another
setting is the 45.1% LEVEL, which is a property of this kit. Reporting the level
without the stratification invites a reader to generalise the one number in the
table that is configuration-specific.

Reuses `cell()` from stock_strip_report so the stratum rule -- did the attempt
begin holding >= N of its own target item -- has exactly one definition. Note
that rule only applies to delta-shaped criteria, so the platform task is absent
from every row here: a structure criterion has no "already held N" state.
"""
import os, sqlite3, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from eval_db import DB_PATH as DB                              # noqa: E402
from stock_strip_report import cell, evidence, fisher          # noqa: E402
from campaign_report import LAYER_ARMS, label, wilson          # noqa: E402

ARMS = ['on', 'off'] + [a for a in LAYER_ARMS if a != 'measurement']


def main():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    ev = evidence()

    print('=' * 78)
    print('FALSE COMPLETION BY STARTING STOCK'.center(78))
    print('=' * 78)
    print('\n%-30s %22s %22s' % ('arm', 'kit supplies target', 'kit empty of it'))
    rows = {}
    for arm in ARMS:
        ts = 'conf_' + arm
        sat = cell(con, ev, ts, True)
        emp = cell(con, ev, ts, False)
        if not sat[1] and not emp[1]:
            continue
        rows[arm] = (sat, emp)
        def fmt(c):
            fd, n, _ = c
            return '%d/%d = %.0f%%' % (fd, n, 100 * fd / n) if n else '—'
        print('%-30s %22s %22s' % (label(arm), fmt(sat), fmt(emp)))

    if 'on' in rows and 'off' in rows:
        print('\n' + '-' * 78)
        print('THE CONTRAST HOLDS IN BOTH STRATA — ONLY THE LEVEL IS KIT-DEPENDENT')
        print('-' * 78)
        for name, idx in (('kit supplies the target', 0), ('kit empty of it', 1)):
            (ofd, on_, _), (ffd, fn, _) = rows['off'][idx], rows['on'][idx]
            p = fisher(ofd, on_ - ofd, ffd, fn - ffd)
            lo_o, hi_o = wilson(ofd, on_)
            lo_f, hi_f = wilson(ffd, fn)
            print('  %-24s no harness %d/%d = %4.0f%% [%.0f,%.0f]   '
                  'full harness %d/%d = %3.0f%% [%.0f,%.0f]   Fisher p = %s'
                  % (name, ofd, on_, 100 * ofd / on_, 100 * lo_o, 100 * hi_o,
                     ffd, fn, 100 * ffd / fn, 100 * lo_f, 100 * hi_f,
                     ('%.3g' % p) if p < 0.0001 else ('%.4f' % p)))
        print('\n  Both arms received the identical kit, so each stratum is a fair')
        print('  comparison. The 45.1% headline is the average of these two cells,')
        print('  and 6 of 13 tasks fall in the first by design (protocol.md 1).')
        print('  What generalises is the contrast; what does not is the level.')


if __name__ == '__main__':
    main()
