#!/usr/bin/env python3
"""Campaign analysis — the numbers that go in the paper.

    python3 eval/campaign_report.py [--seeds N] [--tag conf|bench]

Implements the analysis plan pre-registered in docs/paper/preregistration.md §10,
written before the data existed:

  - verified success per arm, Wilson 95% interval
  - the say-do gap per arm (claimed vs verified on the SAME attempts)
  - A-ON vs every other arm, cluster bootstrap with task as the resampling unit
    (the 3 seeds within a task are not independent, so task is the cluster)
  - Holm-Bonferroni across the per-layer comparisons

Nothing here is described as significant without its interval printed beside it.

The platform task is excluded from referee aggregates by task identity, declared
in advance (§4) — never by whether a given row happened to fall back to
honor_system, which would condition the exclusion on the outcome.
"""
import json, os, random, sqlite3, sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, 'pincercraft_evals.db')
BENCH = os.path.join(ROOT, 'eval', 'benchmarks.json')
BOOTSTRAP_N = 10000
# 'measurement' is the seeds-1-2 compound arm, superseded by the verify /
# autofinish split. It stays in ARMS so the historical rows still print, but it
# is deliberately NOT in LAYER_ARMS: Holm corrects over a family of hypotheses,
# and measurement is not independent of verify/autofinish — it is exactly their
# conjunction. Including all three would correct across a redundant comparison
# and silently inflate every adjusted p-value in the family.
ARMS = ['on', 'off', 'perception', 'gates', 'reflexes', 'verify', 'autofinish', 'measurement']
LAYER_ARMS = ['perception', 'gates', 'reflexes', 'verify', 'autofinish']


def wilson(k, n, z=1.96):
    """Wilson score interval. Used everywhere instead of the normal
    approximation, which misbehaves badly at the 0/n and n/n that small arms
    routinely produce."""
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5)
    # Clamped: floating point puts the bound a hair outside [0,1] at k=0 or
    # k=n, and a proportion reported as "-0.0%" invites a reader to wonder what
    # else in the pipeline is unchecked.
    return (max(0.0, (c - m) / d), min(1.0, (c + m) / d))


def excluded_task_name():
    """The pre-declared exclusion: the one benchmark whose criterion is not
    inventory-shaped, so no referee verdict is possible until a block-scan
    referee exists.

    Keyed on an explicit `exclude_from_primary` flag, not on the presence of a
    `note`: notes are documentation and several tasks carry one, so matching on
    `note` picked whichever such row happened to sit first in the file. That
    resolved correctly only by file ordering, and a reorder would have quietly
    swapped the exclusion — dropping a referee-labeled task from the primary
    endpoint and admitting the one task that can only be honor-system labeled.
    Exactly one row must be marked; anything else is a benchmark-file error and
    is worth stopping the report over, because every downstream rate is
    computed against this set."""
    with open(BENCH) as f:
        rows = json.load(f)
    marked = [r['description'] for r in rows if r.get('exclude_from_primary')]
    if len(marked) != 1:
        raise SystemExit(
            f'{BENCH}: expected exactly 1 task with "exclude_from_primary": true, '
            f'found {len(marked)}')
    return marked[0]


def claimed(success, failure_mode):
    """What an honor-system pipeline would have recorded for this attempt.

    The referee's verdict is `success`; the bot's own claim is recoverable
    because the referee flags exactly where the two diverge."""
    if failure_mode == 'false_done_referee':
        return 1          # bot said done, world disagreed
    if failure_mode == 'queue_never_finished':
        return 0          # world says done, bot never claimed it
    return success


def load(con, seeds=None, tag='conf'):
    excl = excluded_task_name()
    # Discards are looked up by attempt_id in `exclusions`, not inferred from a
    # rewritten arm name — raw receipts are append-only, so `task_set` keeps
    # saying which arm the attempt actually ran under even after it is excluded.
    dropped = {r[0] for r in con.execute("SELECT attempt_id FROM exclusions")}
    rows = con.execute(
        "SELECT attempt_id, task_set, task_name, seed, success, failure_mode, label_source, "
        "input_tokens, output_tokens, wall_clock_seconds "
        # `_` is a single-character wildcard in LIKE, so an unescaped 'bench_%'
        # also matches e.g. 'benchmark_x'. Escaped, the prefix is literal.
        r"FROM task_attempts WHERE task_set LIKE ? ESCAPE '\' "
        "AND seed > 0", (tag.replace('_', r'\_') + r'\_%',)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        if seeds and d['seed'] not in seeds:
            continue
        d['arm'] = d['task_set'][len(tag) + 1:]
        # Two independent reasons a row leaves the primary analysis, kept apart:
        #   discarded — §8 infrastructure fault, this attempt is not evidence
        #   excluded  — §4 prior commitment, this TASK has no referee coverage
        d['discarded'] = d['attempt_id'] in dropped
        d['excluded'] = (d['task_name'] == excl)
        d['claimed'] = claimed(d['success'], d['failure_mode'])
        out.append(d)
    return out


def by_arm(rows):
    g = defaultdict(list)
    for r in rows:
        g[r['arm']].append(r)
    return g


def arm_table(groups, arms, restrict=None):
    """Verified rate and say-do gap per arm.

    `restrict` limits every arm to the same task names. Without it the rates
    are each computed over whatever tasks that arm happens to hold, which is
    only meaningful when the arms ran the same set — hence the `tasks` column,
    so an unequal design is visible in the table rather than implied by it."""
    print(f'{"arm":<13} {"n":>4} {"tasks":>6}  {"verified":>8}  {"95% CI":>16}'
          f'   {"claimed":>8}  {"say-do gap":>10}')
    for arm in arms:
        rs = groups.get(arm, [])
        if restrict is not None:
            rs = [r for r in rs if r['task_name'] in restrict]
        if not rs:
            continue
        n = len(rs)
        v = sum(r['success'] for r in rs)
        c = sum(r['claimed'] for r in rs)
        lo, hi = wilson(v, n)
        t = len({r['task_name'] for r in rs})
        print(f'{arm:<13} {n:>4} {t:>6}  {pct(v/n)}  [{pct(lo)},{pct(hi)}]'
              f'   {pct(c/n)}  {pct(c/n - v/n)}')


def false_completion(r):
    """1 when the agent claimed done and the referee's world read disagreed.

    The paper's central quantity. Kept as a function of the row rather than a
    stored column so it stays derived (see eval/taxonomy.py)."""
    return 1 if r['failure_mode'] == 'false_done_referee' else 0


def cluster_bootstrap(a_rows, b_rows, n=BOOTSTRAP_N, seed=12345,
                      value=lambda r: r['success']):
    """Difference in a per-attempt rate, resampling TASKS with replacement.

    Resampling individual attempts would treat the 3 seeds of one task as 3
    independent observations and produce intervals that are too narrow.

    `value` selects the outcome. It defaults to verified success, but the
    headline comparison is false completion — that number had no interval at
    all until 2026-08-09, which made the single most important quantity in the
    campaign the one not carrying uncertainty."""
    rng = random.Random(seed)
    a_by, b_by = defaultdict(list), defaultdict(list)
    for r in a_rows:
        a_by[r['task_name']].append(value(r))
    for r in b_rows:
        b_by[r['task_name']].append(value(r))
    tasks = sorted(set(a_by) & set(b_by))
    if not tasks:
        return None
    diffs = []
    for _ in range(n):
        pick = [tasks[rng.randrange(len(tasks))] for _ in tasks]
        av = [v for t in pick for v in a_by[t]]
        bv = [v for t in pick for v in b_by[t]]
        if av and bv:
            diffs.append(sum(av) / len(av) - sum(bv) / len(bv))
    if not diffs:
        return None
    diffs.sort()
    obs_a = [v for t in tasks for v in a_by[t]]
    obs_b = [v for t in tasks for v in b_by[t]]
    return {
        'diff': sum(obs_a) / len(obs_a) - sum(obs_b) / len(obs_b),
        'lo': diffs[int(0.025 * len(diffs))],
        'hi': diffs[int(0.975 * len(diffs))],
        # Fraction of resamples on the wrong side of zero: a bootstrap p-value
        # for the one-sided direction the hypothesis predicts.
        'p': min(1.0, 2 * min(sum(d <= 0 for d in diffs), sum(d >= 0 for d in diffs)) / len(diffs)),
        'tasks': len(tasks),
    }


def holm(pairs):
    """Holm-Bonferroni. pairs = [(label, p)] -> [(label, p, adjusted)]."""
    ordered = sorted(pairs, key=lambda x: x[1])
    m = len(ordered)
    out, prev = [], 0.0
    for i, (label, p) in enumerate(ordered):
        adj = max(prev, min(1.0, (m - i) * p))
        prev = adj
        out.append((label, p, adj))
    return out


def pct(x):
    return f'{100 * x:5.1f}%'


def main(seeds=None, tag='conf'):
    if not os.path.exists(DB):
        sys.exit(f'no database at {DB}')
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    rows = load(con, seeds, tag)
    if not rows:
        sys.exit(f'no rows for task_set {tag}_*, seed > 0.\n'
                 f'The default namespace is the CONFIRMATORY set; the exploratory '
                 f'backtests are --tag bench.')

    excl = excluded_task_name()
    discarded = [r for r in rows if r['discarded']]
    kept = [r for r in rows if not r['discarded']]
    primary = [r for r in kept if not r['excluded']]
    groups = by_arm(primary)

    print('=' * 74)
    print('CAMPAIGN REPORT'.center(74))
    print('=' * 74)
    # Counted against `kept`, not `rows`: an attempt discarded for an
    # infrastructure fault was never evidence about the excluded task either,
    # so charging it to the §4 exclusion double-counts it.
    print(f'\nattempts: {len(rows)} total, {len(primary)} in the primary set')
    print(f'excluded by prior declaration (§4): {len(kept) - len(primary)} '
          f'— {(excl or "?")[:48]}...')
    seeds_seen = sorted({r['seed'] for r in rows})
    print(f'seeds present: {seeds_seen}')

    # Any non-referee row in the primary set means a criterion failed to parse.
    # That is a data-quality problem, not a result, so it is surfaced loudly
    # rather than quietly averaged in.
    strays = [r for r in primary if r['label_source'] != 'referee']
    if strays:
        print(f'\n  WARNING: {len(strays)} primary-set row(s) are not referee-labeled.')
        print('  Their end_factor did not parse to an inventory shape. Fix the')
        print('  criterion and re-run those attempts — do not report them as measured.')
        for r in strays[:5]:
            print(f'    - {r["arm"]:<12} {r["task_name"][:52]}')

    # §8 discards, counted by reference. The arm name is intact on these rows,
    # so the rate can be broken down by the arm the attempt actually ran under.
    if discarded:
        per_arm = Counter(r['arm'] for r in discarded)
        print(f'\ndiscarded as infrastructure faults (§8): {len(discarded)} attempt(s), '
              f'{len(discarded) / len(rows) * 100:.1f}% discard rate')
        for a, n in sorted(per_arm.items()):
            print(f'    - {a:<36} {n} attempt(s)')
        print('  cause and rule per attempt: `exclusions` table, docs/paper/aborts.md')

    # Every section below iterates the ARMS catalogue, so an arm name that is
    # not in it contributes to nothing and vanishes without a count — a typo in
    # the arm passed to field_trial.sh would silently drop a whole segment.
    unknown = sorted(set(groups) - set(ARMS))

    if unknown:
        print(f'\n  WARNING: {len(unknown)} arm(s) in the data are not in the report')
        print('  catalogue — their rows appear in NO section below. Check the arm')
        print('  name passed to field_trial.sh, or add it to ARMS.')
        for a in unknown:
            print(f'    - {a:<20} {len(groups[a])} row(s)')

    print('\n' + '-' * 74)
    print('VERIFIED SUCCESS AND THE SAY-DO GAP, BY ARM')
    print('-' * 74)
    arm_table(groups, ARMS)
    print('\nsay-do gap = claimed minus verified, on the same attempts.')
    print('A positive gap is the agent overstating its own success.')

    # Arms that ran different task sets are not comparable row-to-row: the
    # benchmark grew from 10 tasks to 13, so an arm carrying tier 4 is scored
    # on strictly harder work than one that predates it and would look worse
    # for that reason alone. The pairwise tests below already intersect task
    # sets; this table is what a reader compares by eye, so when the design is
    # unequal, restate it on the shared tasks instead of leaving the raw rates
    # to be misread as like-for-like.
    shown = [a for a in ARMS if groups.get(a)]
    per_arm_tasks = {a: {r['task_name'] for r in groups[a]} for a in shown}
    common = set.intersection(*per_arm_tasks.values()) if per_arm_tasks else set()
    if any(per_arm_tasks[a] != common for a in shown):
        print('\n  NOTE: the arms above did not all run the same tasks, so those rates')
        print(f'  are not comparable to each other. Restated on the {len(common)} task(s)')
        print('  common to every arm shown:')
        print()
        if common:
            arm_table(groups, ARMS, restrict=common)
        else:
            print('    no task is shared by every arm — nothing can be compared.')

    # Primary endpoint: false completion. This is the claim the paper rests on
    # — the harness does not mainly make the agent better at the game, it stops
    # it reporting success it did not achieve — so it is reported first and with
    # its own interval.
    if 'on' in groups and 'off' in groups:
        print('\n' + '-' * 74)
        print('PRIMARY ENDPOINT — FALSE COMPLETION, A-ON vs A-OFF')
        print('-' * 74)
        for arm in ('on', 'off'):
            k = sum(false_completion(r) for r in groups[arm])
            n_a = len(groups[arm])
            lo, hi = wilson(k, n_a)
            line = f'  {arm:<4} {k}/{n_a} = {pct(k / n_a):>7}   95% CI [{pct(lo)}, {pct(hi)}]'
            if k == 0:
                # Zero events is not "eliminated". State what it rules out.
                line += f'   one-sided 95% upper bound {pct(1 - 0.05 ** (1 / n_a))}'
            print(line)
        b = cluster_bootstrap(groups['on'], groups['off'], value=false_completion)
        if b:
            print(f'\n  difference in false-completion rate: {pct(b["diff"])}')
            print(f'  95% CI: [{pct(b["lo"])}, {pct(b["hi"])}]   bootstrap p={b["p"]:.4f}   '
                  f'({b["tasks"]} tasks, {BOOTSTRAP_N} resamples)')
            spans = b['lo'] <= 0 <= b['hi']
            print(f'  H1 {"NOT supported — interval spans zero" if spans else "supported"}')

    # Secondary endpoint: overall task success. Underpowered by comparison, and
    # partly a capability question rather than a self-report one.
    if 'on' in groups and 'off' in groups:
        print('\n' + '-' * 74)
        print('SECONDARY ENDPOINT — VERIFIED SUCCESS, A-ON vs A-OFF')
        print('-' * 74)
        b = cluster_bootstrap(groups['on'], groups['off'])
        if b:
            print(f'  difference in verified success: {pct(b["diff"])}')
            print(f'  95% CI: [{pct(b["lo"])}, {pct(b["hi"])}]   bootstrap p={b["p"]:.4f}   '
                  f'({b["tasks"]} tasks, {BOOTSTRAP_N} resamples)')
            spans = b['lo'] <= 0 <= b['hi']
            print(f'  H2 {"NOT supported — interval spans zero" if spans else "supported"}')

    # Exploratory, and labelled as such regardless of what it shows.
    # The correction family is the arms actually run, not the catalogue. When
    # the split arms are present, `measurement` is their conjunction and is
    # dropped to keep the family independent; when they are not (the seeds-1-2
    # data), `measurement` IS the pre-registered hypothesis and must be tested.
    present = [a for a in LAYER_ARMS if a in groups]
    if 'measurement' in groups and not ('verify' in groups and 'autofinish' in groups):
        present.append('measurement')
    if 'on' in groups and present:
        print('\n' + '-' * 74)
        print('PER-LAYER ABLATION vs A-ON (exploratory — underpowered by design)')
        print('-' * 74)
        results, ps = {}, []
        for arm in present:
            b = cluster_bootstrap(groups['on'], groups[arm])
            if b:
                results[arm] = b
                ps.append((arm, b['p']))
        for arm, p, adj in holm(ps):
            b = results[arm]
            print(f'  {arm:<13} drop {pct(b["diff"])}  CI [{pct(b["lo"])}, {pct(b["hi"])}]  '
                  f'p={p:.4f}  Holm-adj={adj:.4f}')
        print(f'\n  {len(present)} arms at this seed count cannot resolve small effects. Read the intervals,')
        print('  not the ranking.')

    # Cost, for the efficiency line in the paper.
    print('\n' + '-' * 74)
    print('COST PER VERIFIED SUCCESS')
    print('-' * 74)
    print(f'{"arm":<13} {"in-tok/run":>11} {"sec/run":>9} {"in-tok per success":>20}')
    for arm in ARMS:
        rs = groups.get(arm, [])
        if not rs:
            continue
        v = sum(r['success'] for r in rs)
        tok = sum(r['input_tokens'] or 0 for r in rs)
        sec = sum(r['wall_clock_seconds'] or 0 for r in rs)
        per = f'{tok / v:>20,.0f}' if v else f'{"n/a (0 successes)":>20}'
        print(f'{arm:<13} {tok/len(rs):>11,.0f} {sec/len(rs):>9.1f} {per}')
    print()


if __name__ == '__main__':
    sel = None
    if '--seeds' in sys.argv:
        sel = {int(x) for x in sys.argv[sys.argv.index('--seeds') + 1].split(',')}
    # Default is `conf` — the CONFIRMATORY namespace. Exploratory data lives
    # under `bench` and must be asked for explicitly (`--tag bench`). Making the
    # confirmatory set the default, in its own namespace rather than separated
    # by a convention about seed numbers, is what stops the two regimes being
    # pooled by someone running the script with no arguments.
    tag = 'conf'
    if '--tag' in sys.argv:
        tag = sys.argv[sys.argv.index('--tag') + 1]
    main(sel, tag)
