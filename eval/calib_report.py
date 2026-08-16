#!/usr/bin/env python3
"""The stratified re-calibration, reported per cell (preregistration 2026-08-16).

    python3 eval/calib_report.py

Why this is not `agreement.py report`. That tool prints one agreement figure per
(era, label_source) cell, which is the right shape for a sample drawn without
regard to the scorer's verdict. This set was drawn *by* the scorer's verdict,
oversampling false completions roughly 15x their prevalence, so its aggregate
agreement is not an estimate of anything: it is a number whose value is set by
the allocation table. Read per cell, or reweighted to the primary set's own
composition — both below, neither summed with the earlier 39.

**What sampling on the scorer's verdict can and cannot estimate.** Conditioning
on the scorer and observing the human gives *predictive values* — P(human agrees
| scorer said X). It does NOT directly give sensitivity or specificity, which
condition on the human's label and would need a sample drawn on that instead.
The distinction matters because the paper's claim is a predictive one: when this
scorer writes `false_completion`, is it right? That is exactly cell B's NPV.

Because the stratum sizes in the primary set are known, the per-cell rates can
be reweighted back to the primary set's composition to recover an overall
agreement estimate that is unbiased for THIS campaign — which the 39/39 figure,
drawn in glob order from a different population, never was.
"""
import os, re, sqlite3, sys
from math import sqrt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from eval_db import DB_PATH as DB              # noqa: E402
from campaign_report import wilson             # noqa: E402  one definition
from calib_sample import (                     # noqa: E402  one definition of the draw
    draw_strata, cell, path_of, eligible)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ABSTAIN = os.path.join(ROOT, 'docs', 'paper', 'calibration_abstentions.txt')
CELL_NAME = {
    'A': 'scorer says SUCCESS',
    'B': 'scorer says FAIL, agent CLAIMED done  <- false completion',
    'C': 'scorer says FAIL, agent did not claim',
}
# Pre-declared 2026-08-16: below this, the scorer over-calls its verdict in that
# cell and the measured error rate is applied as a correction to the reported
# rates. Stated before any label existed.
THRESHOLD = 0.90


def load_labels(con):
    """task_id -> human verdict, for the stratified set only."""
    out = {}
    for human, notes in con.execute(
            "SELECT success, notes FROM gold_attempts "
            "WHERE notes LIKE '%agree:task_id=%' AND notes LIKE '%strat=%'"):
        m = re.search(r'agree:task_id=(\d+)', notes or '')
        if m:
            out[int(m.group(1))] = bool(human)
    return out


def load_abstentions():
    out = {}
    if os.path.exists(ABSTAIN):
        for line in open(ABSTAIN):
            line = line.strip()
            if line and not line.startswith('#'):
                parts = line.split('\t')
                out[int(parts[0])] = parts[-1]
    return out


def main():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    picked, elig, _ = draw_strata(con)
    labels = load_labels(con)
    abstained = load_abstentions()

    # Scorer verdict per drawn attempt, and the primary-set stratum sizes that
    # supply the reweighting denominators.
    by_tid = {r['task_id']: r for r in elig}
    pop = {}
    for r in elig:
        pop[(cell(r), path_of(r))] = pop.get((cell(r), path_of(r)), 0) + 1
    N = len(elig)

    print('=' * 78)
    print('STRATIFIED RE-CALIBRATION'.center(78))
    print('=' * 78)
    print('\nDrawn from the %d-row confirmatory primary set (eligible), by the rule'
          '\nregistered 2026-08-16. Cells are never summed.\n' % N)

    print('%-4s %-10s %6s %8s %9s  %-22s' %
          ('cell', 'path', 'drawn', 'labelled', 'agree', 'agreement (Wilson 95%)'))
    rows = []
    for key in sorted(picked):
        c, p = key
        ids = picked[key]
        ok = n = 0
        abst = 0
        for t in ids:
            if t in abstained:
                abst += 1
                continue
            if t not in labels:
                continue
            scorer_success = bool(by_tid[t]['success'])
            n += 1
            ok += (labels[t] == scorer_success)
        rate = ok / n if n else float('nan')
        lo, hi = wilson(ok, n) if n else (float('nan'), float('nan'))
        rows.append((c, p, ok, n, rate, pop[key]))
        extra = ('  (%d abstained)' % abst) if abst else ''
        print('%-4s %-10s %6d %8d %9s  [%5.1f, %5.1f]%s' %
              (c, p, len(ids), n, '%d/%d' % (ok, n), 100 * lo, 100 * hi, extra))

    print('\n' + '-' * 78)
    print('PER CELL, POOLED ACROSS SCORER PATH')
    print('-' * 78)
    agg = {}
    for c, p, ok, n, _, npop in rows:
        a = agg.setdefault(c, [0, 0, 0])
        a[0] += ok; a[1] += n; a[2] += npop
    for c in ('A', 'B', 'C'):
        if c not in agg:
            continue
        ok, n, npop = agg[c]
        lo, hi = wilson(ok, n) if n else (0.0, 0.0)
        print('  %s  %-52s %s = %5.1f%%  [%5.1f, %5.1f]'
              % (c, CELL_NAME[c], '%d/%d' % (ok, n), 100 * ok / n if n else 0,
                 100 * lo, 100 * hi))
        print('     %d of %d primary-set attempts fall in this cell (%.1f%%)'
              % (npop, N, 100 * npop / N))

    # Reweight to the primary set. Unbiased for this campaign because the
    # stratum sizes are known exactly and each stratum was sampled at random
    # within itself.
    print('\n' + '-' * 78)
    print('REWEIGHTED TO THE PRIMARY SET (what the 39/39 figure tried to be)')
    print('-' * 78)
    est = lb = coverage = 0.0
    uncovered = []
    for c, p, ok, n, rate, npop in rows:
        w = npop / N
        if not n:
            uncovered.append(('%s/%s' % (c, p), npop, w))
            continue
        coverage += w
        est += w * rate
        # A conservative bound, NOT a Wald interval. Three of these strata came
        # back at 100%, where the Wald variance p(1-p)/n is exactly zero — so a
        # normal-approx CI over them collapses to a point and reports a
        # precision the four labels underneath it never bought. That is the same
        # degenerate-interval failure the 2026-08-10 deviation caught when a
        # [0,0] bootstrap interval certified a bounded null on 0/11. Weighting
        # each stratum's Wilson LOWER bound instead gives a bound that is
        # honest at p=1 by construction.
        lo, _ = wilson(ok, n)
        lb += w * lo
    est /= coverage
    lb /= coverage
    print('  overall agreement, prevalence-weighted : %.1f%%' % (100 * est))
    print('  conservative lower bound               : %.1f%%' % (100 * lb))
    print('  strata coverage                        : %.1f%% of the primary set'
          % (100 * coverage))
    for name, npop, w in uncovered:
        print('    UNCERTIFIED: %s — %d attempts (%.1f%%) carry no label'
              % (name, npop, 100 * w))
    print('  NOTE: a weighted mean of per-cell rates, not a raw count, and')
    print('        renormalised over the covered strata — so it assumes the')
    print('        uncertified stratum behaves like the rest, which is exactly')
    print('        what it has no evidence for. NOT comparable to 39/39, an')
    print('        unweighted count over a different population.')
    print('  The lower bound is a weighted Wilson LB, not a symmetric interval:')
    print('        at 100% agreement a Wald interval has zero width and lies.')

    # The pre-declared decision rule.
    print('\n' + '-' * 78)
    print('PRE-DECLARED DECISION RULE (registered 2026-08-16, before any label)')
    print('-' * 78)
    fail = False
    for c in ('A', 'B', 'C'):
        if c not in agg:
            continue
        ok, n, _ = agg[c]
        rate = ok / n if n else 0
        verdict = 'PASS' if rate >= THRESHOLD else 'CORRECTION REQUIRED'
        if rate < THRESHOLD:
            fail = True
        print('  cell %s: %5.1f%% vs %.0f%% threshold -> %s'
              % (c, 100 * rate, 100 * THRESHOLD, verdict))
    if fail:
        print('\n  At least one cell is below threshold. The measured error rate is')
        print('  applied as a correction to every rate that depends on that cell,')
        print('  and the corrected figures become the paper\'s numbers.')
    else:
        print('\n  All cells at or above threshold. The scorer is certified on the')
        print('  cell the paper depends on, and the reported rates stand as measured.')

    miss = [t for ids in picked.values() for t in ids
            if t not in labels and t not in abstained]
    if miss:
        print('\n  WARNING: %d drawn attempt(s) neither labelled nor recorded as an'
              ' abstention: %s' % (len(miss), miss))
        print('  A drawn card with no disposition silently shrinks the denominator.')


if __name__ == '__main__':
    main()
