#!/usr/bin/env python3
"""Campaign analysis — the numbers that go in the paper.

    python3 eval/campaign_report.py [--seeds N] [--tag conf|bench]

Implements the analysis plan pre-registered in docs/paper/preregistration.md §10,
written before the data existed:

  - verified success per arm, Wilson 95% interval
  - the say-do gap per arm (claimed vs verified on the SAME attempts)
  - the full harness vs every other arm, cluster bootstrap with task as the unit
    (the 3 seeds within a task are not independent, so task is the cluster)
  - Holm-Bonferroni across the per-layer comparisons

Nothing here is described as significant without its interval printed beside it.

Task-level exclusions are applied by task identity, declared in advance (§4) —
never by whether a given row happened to fall back to honor_system, which would
condition the exclusion on the outcome. As of 2026-08-14 there are none: the
platform task's exclusion was lifted once the block-scan scorer could label it.
"""
import json, os, random, sqlite3, sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'eval'))
from eval_db import DB_PATH as DB  # noqa: E402  single env-aware definition
from analysis_rules import (  # noqa: E402  one definition of each rule
    BENCH, LAYER_ENDPOINT, MEI, claimed, excluded_task_name, is_category)
BOOTSTRAP_N = 10000
# 'measurement' is the seeds-1-2 compound arm, superseded by the verify /
# autofinish split. It stays in ARMS so the historical rows still print, but it
# is deliberately NOT in LAYER_ARMS: Holm corrects over a family of hypotheses,
# and measurement is not independent of verify/autofinish — it is exactly their
# conjunction. Including all three would correct across a redundant comparison
# and silently inflate every adjusted p-value in the family.
ARMS = ['on', 'off', 'perception', 'gates', 'reflexes', 'verify', 'autofinish', 'measurement']
LAYER_ARMS = ['perception', 'gates', 'reflexes', 'verify', 'autofinish']

# Manuscript names, printed instead of the code identifiers (terminology.md §1.1).
# The identifiers stay in the DB and in every `task_set` — renaming those would
# break reproducibility of collected receipts — but the report is what gets read
# and quoted, so it speaks the manuscript's language. A-ON/A-OFF/B1-B5 are retired
# from new prose: "A" is never expanded and reads as A/B testing, and an index
# costs a legend lookup per row.
ARM_LABEL = {
    'on': 'full harness',
    'off': 'no harness',
    'perception': '- perception',
    'gates': '- preconditions',
    'reflexes': '- reflexes',
    'verify': '- completion check',
    'autofinish': '- deterministic termination',
    'measurement': '- verify+autofinish (retired)',
}


def label(arm):
    """Manuscript name for an arm, falling back to the raw identifier so an arm
    added to ARMS without a label still prints rather than vanishing."""
    return ARM_LABEL.get(arm, arm)


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


def load(con, seeds=None, tag='conf'):
    excl = excluded_task_name(tag)
    # Discards are looked up by attempt_id in `exclusions`, not inferred from a
    # rewritten arm name — raw receipts are append-only, so `task_set` keeps
    # saying which arm the attempt actually ran under even after it is excluded.
    # `source` comes along because two different dispositions live in this table
    # (terminology.md §6): a DISCARD is an infrastructure fault, meaning the
    # attempt was never evidence; a SUPERSESSION is valid data replaced wholesale
    # by a declared re-run. Both leave the primary set, only the first is a rig
    # failure, and folding them into one rate reported a 28.2% fault rate against
    # a true 15.0%.
    dropped = {r[0]: (r[1] or '') for r in
               con.execute("SELECT attempt_id, source FROM exclusions")}
    rows = con.execute(
        "SELECT attempt_id, task_set, task_name, seed, success, failure_mode, label_source, "
        # `steps` is needed by the shared classify(): a zero-step timeout is an
        # infrastructure fault, not a capability failure.
        "steps, input_tokens, output_tokens, wall_clock_seconds "
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
        #   excluded  — §4 prior commitment, this TASK has no scorer coverage
        d['discarded'] = d['attempt_id'] in dropped
        d['superseded'] = 'superseded' in dropped.get(d['attempt_id'], '')
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
    """Verified rate, say-do gap and false completion per arm.

    `restrict` limits every arm to the same task names. Without it the rates
    are each computed over whatever tasks that arm happens to hold, which is
    only meaningful when the arms ran the same set — hence the `tasks` column,
    so an unequal design is visible in the table rather than implied by it.

    The discordant cells b and c are printed because the say-do gap is (b-c)/n
    while false completion is b/n: the two coincide only when c = 0, and an arm
    with c > 0 nets one error against the other. Without these columns a reader
    cannot tell a genuinely honest arm from a cancelling one — the -reflexes arm
    shows a 0.0% gap holding one false completion and one unrecognized
    success (terminology.md §5.2)."""
    print(f'{"arm":<28} {"n":>4} {"tasks":>6}  {"verified":>8}  {"95% CI":>16}'
          f'   {"claimed":>8}  {"b":>3} {"c":>3}  {"say-do gap":>10}  {"false compl":>11}')
    for arm in arms:
        rs = groups.get(arm, [])
        if restrict is not None:
            rs = [r for r in rs if r['task_name'] in restrict]
        if not rs:
            continue
        n = len(rs)
        v = sum(r['success'] for r in rs)
        c = sum(r['claimed'] for r in rs)
        b_cell = sum(1 for r in rs if r['claimed'] and not r['success'])
        c_cell = sum(1 for r in rs if not r['claimed'] and r['success'])
        lo, hi = wilson(v, n)
        t = len({r['task_name'] for r in rs})
        print(f'{label(arm):<28} {n:>4} {t:>6}  {pct(v/n)}  [{pct(lo)},{pct(hi)}]'
              f'   {pct(c/n)}  {b_cell:>3} {c_cell:>3}  {pct(c/n - v/n)}  {pct(b_cell/n)}')


# 1 when the agent claimed done and the scorer's world read disagreed. The
# paper's central quantity, derived rather than stored, and taken from the same
# taxonomy rule every other endpoint uses so the primary endpoint cannot drift
# away from the category of the same name.
false_completion = is_category('false_completion')


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
        # Two-sided bootstrap p, with the (r+1)/(B+1) correction. Without it a
        # resample set that never crosses zero yields exactly 0, which printed
        # as "p=0.0000" — a value no resampling procedure can justify, and one
        # a reviewer is right to reject.
        #
        # The floor is 2/(B+1), NOT 1/(B+1). The one-sided count is doubled, so
        # the smallest value this expression can return is 2*(0+1)/(B+1) —
        # 0.0002 at B=10000. Reporting "<0.0001" claimed the statistic had gone
        # below a bound it cannot reach, and the number it was claiming to be
        # under is exactly the number it had computed. This is the same class of
        # error as the "p=0.0000" the (r+1)/(B+1) correction fixed on
        # 2026-08-10, left half-corrected: the estimator was fixed and the
        # resolution bound reported beside it was not.
        'p': min(1.0, 2 * (min(sum(d <= 0 for d in diffs),
                               sum(d >= 0 for d in diffs)) + 1) / (len(diffs) + 1)),
        'p_floor': 2.0 / (len(diffs) + 1),
        'tasks': len(tasks),
    }


def fmt_p(b):
    """A bootstrap p at the resolution the resample count can support.

    At the floor the honest report is "<=" and not "<": the procedure returned
    that exact value and cannot return less, so a strict inequality overstates
    the resolution by claiming a bound the design never bought."""
    return f'<={b["p_floor"]:.4f}' if b['p'] <= b['p_floor'] else f'={b["p"]:.4f}'


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


def robustness(groups):
    """The §10 sensitivity checks, on the two headline endpoints.

    Exists because results.md §10 quoted four intervals that no CLI produced.
    They were correct, but the file opens by promising every number is
    regenerated by this script, and a number a reader cannot reproduce is one
    they have to take on trust — which is the opposite of the point.

    Each row drops a class of attempt and re-runs the same cluster bootstrap.
    Both drops make the effect LARGER, so reporting the undropped figure is the
    conservative choice and the pre-registration's rule against removing rows
    after seeing which way they move the result costs us effect size here
    rather than manufacturing it."""
    on, off = groups.get('on', []), groups.get('off', [])
    if not on or not off:
        print('\n  (robustness needs both the full-harness and no-harness arms)')
        return
    succ = lambda r: r['success']                       # noqa: E731
    fc = is_category('false_completion')
    # A zero-step timeout is a bot that never acted. analysis_rules.classify()
    # already calls it `infrastructure`, but these rows are not in `exclusions`,
    # so the endpoint tables still count them as failures — the known
    # inconsistency results.md §10 flags rather than silently resolving.
    zero = lambda rs: [r for r in rs                    # noqa: E731
                       if not ((r['steps'] or 0) == 0
                               and (r['failure_mode'] or '') == 'timeout')]
    # Which task is the platform task is already defined once, in
    # benchmarks.json's `exclude_from_primary` flag, and read by
    # excluded_task_name. Asking it under the 'bench' dataset returns that name
    # whatever the tag being reported — a second copy of the description here
    # would be one more place for it to drift.
    platform = excluded_task_name('bench')
    plat = lambda rs: [r for r in rs if r['task_name'] != platform]  # noqa: E731

    print('\n' + '-' * 74)
    print('ROBUSTNESS — §10 SENSITIVITY OF THE TWO HEADLINE ENDPOINTS')
    print('-' * 74)
    print(f'{"subset":<34} {"task success":>18} {"false completion":>20}')
    for name, f in (('as reported', lambda rs: rs),
                    ('dropping the platform task', plat),
                    ('dropping zero-step timeouts', zero)):
        a, b = f(on), f(off)
        cells = []
        for value in (succ, fc):
            r = cluster_bootstrap(a, b, value=value)
            cells.append('n/a' if not r else
                         f"{r['diff']*100:+.1f} [{r['lo']*100:+.1f},{r['hi']*100:+.1f}]")
        print(f'{name:<34} {cells[0]:>18} {cells[1]:>20}')
    print('\nON minus OFF, cluster bootstrap by task, '
          f'{BOOTSTRAP_N:,} resamples. Both drops enlarge both')
    print('effects, so the reported figures are the conservative ones.')


def main(seeds=None, tag='conf', robust=False):
    if not os.path.exists(DB):
        sys.exit(f'no database at {DB}')
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    rows = load(con, seeds, tag)
    if not rows:
        sys.exit(f'no rows for task_set {tag}_*, seed > 0.\n'
                 f'The default namespace is the CONFIRMATORY set; the exploratory '
                 f'replicates are --tag bench.')

    excl = excluded_task_name(tag)
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
    if excl:
        print(f'excluded by prior declaration (§4): {len(kept) - len(primary)} '
              f'— {excl[:48]}...')
    else:
        print('excluded by prior declaration (§4): none — the platform-task '
              'exclusion was lifted for confirmatory data 2026-08-14')
    seeds_seen = sorted({r['seed'] for r in rows})
    print(f'seeds present: {seeds_seen}')

    # Any non-scorer row in the primary set means a criterion failed to parse.
    # That is a data-quality problem, not a result, so it is surfaced loudly
    # rather than quietly averaged in.
    strays = [r for r in primary if r['label_source'] != 'referee']
    if strays:
        print(f'\n  WARNING: {len(strays)} primary-set row(s) are not scorer-labeled.')
        print('  Their end_factor did not parse to an inventory shape. Fix the')
        print('  criterion and re-run those attempts — do not report them as measured.')
        for r in strays[:5]:
            print(f'    - {r["arm"]:<12} {r["task_name"][:52]}')

    # §8 discards, counted by reference. The arm name is intact on these rows,
    # so the rate can be broken down by the arm the attempt actually ran under.
    # Faults and supersessions are reported on separate lines and never summed
    # into one rate (terminology.md §6): a discard says this attempt is not
    # evidence, a supersession says it was evidence that better evidence
    # replaced. Only the first is a statement about rig reliability.
    faults = [r for r in discarded if not r['superseded']]
    superseded = [r for r in discarded if r['superseded']]
    if faults:
        per_arm = Counter(r['arm'] for r in faults)
        print(f'\ndiscarded as infrastructure faults (§8): {len(faults)} attempt(s), '
              f'{len(faults) / (len(primary) + len(faults)) * 100:.1f}% discard rate')
        for a, n in sorted(per_arm.items()):
            print(f'    - {a:<36} {n} attempt(s)')
        print('  cause and rule per attempt: `exclusions` table, docs/paper/aborts.md')
    if superseded:
        per_arm = Counter(r['arm'] for r in superseded)
        print(f'\nsuperseded by a declared re-run: {len(superseded)} attempt(s) '
              f'— NOT a fault, excluded from the discard rate above')
        for a, n in sorted(per_arm.items()):
            print(f'    - {a:<36} {n} attempt(s)')

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
    print('\nb = claimed but not verified.  c = verified but never claimed.')
    print('say-do gap = (b-c)/n, a summary statistic — the two cancel.')
    print('false compl = b/n, the endpoint — they do not. Equal only when c = 0.')
    print('A positive gap is the agent overstating its own success (terminology.md §5.2).')

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
        print('CO-PRIMARY ENDPOINT — FALSE COMPLETION, FULL HARNESS vs NO HARNESS')
        print('-' * 74)
        for arm in ('on', 'off'):
            k = sum(false_completion(r) for r in groups[arm])
            n_a = len(groups[arm])
            lo, hi = wilson(k, n_a)
            line = f'  {label(arm):<14} {k}/{n_a} = {pct(k / n_a):>7}   95% CI [{pct(lo)}, {pct(hi)}]'
            if k == 0:
                # Zero events is not "eliminated". State what it rules out.
                line += f'   one-sided 95% upper bound {pct(1 - 0.05 ** (1 / n_a))}'
            print(line)
        b = cluster_bootstrap(groups['on'], groups['off'], value=false_completion)
        if b:
            print(f'\n  difference in false-completion rate: {pct(b["diff"])}')
            print(f'  95% CI: [{pct(b["lo"])}, {pct(b["hi"])}]   bootstrap p{fmt_p(b)}   '
                  f'({b["tasks"]} tasks, {BOOTSTRAP_N} resamples)')
            spans = b['lo'] <= 0 <= b['hi']
            print(f'  H1 {"NOT supported — interval spans zero" if spans else "supported"}')

    # Primary endpoint, per the frozen preregistration §4: "Primary endpoint:
    # verified success rate, A-ON vs A-OFF. Co-primary: say-do gap." The report
    # previously called false completion primary and this secondary, which is the
    # opposite of the pre-commitment. Both are supported, so no conclusion moves —
    # but reporting a different primary endpoint than the one registered is
    # exactly what pre-registration exists to prevent, so the freeze wins and the
    # labels follow it. False completion is the per-attempt form of the co-primary
    # say-do gap (terminology.md §5.2); it is printed first because it is the
    # phenomenon the paper is about, and the ordering is presentational only.
    if 'on' in groups and 'off' in groups:
        print('\n' + '-' * 74)
        print('PRIMARY ENDPOINT — TASK SUCCESS, FULL HARNESS vs NO HARNESS')
        print('-' * 74)
        b = cluster_bootstrap(groups['on'], groups['off'])
        if b:
            print(f'  difference in verified success: {pct(b["diff"])}')
            print(f'  95% CI: [{pct(b["lo"])}, {pct(b["hi"])}]   bootstrap p{fmt_p(b)}   '
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
        print('PER-LAYER ABLATION vs THE FULL HARNESS, each on its target failure mode')
        print('-' * 74)
        # Each layer is scored on the taxonomy category it targets, NOT on
        # overall success. This is the pre-registered endpoint, and the
        # confirmatory arms were sized for it: separating verify from autofinish
        # on overall success needs n=372/arm against the 52/arm actually
        # planned, so scoring them on success tests an unregistered hypothesis
        # at a sample size chosen for a different one.
        results, ps = {}, []
        for arm in present:
            endpoint = LAYER_ENDPOINT[arm]
            # Ablation minus full harness: a positive number is the ablation RAISING the
            # failure mode the layer is supposed to suppress, which is the
            # direction the hypothesis predicts.
            b = cluster_bootstrap(groups[arm], groups['on'],
                                  value=is_category(endpoint))
            if b:
                b['endpoint'] = endpoint
                results[arm] = b
                ps.append((arm, b['p']))
        print(f'  {"layer":<28} {"target failure mode":<24} {"rise":>7}  '
              f'{"95% CI":<26}  {"Holm-adj":>8}  verdict')
        for arm, p, adj in holm(ps):
            b = results[arm]
            sel = is_category(b['endpoint'])
            k_a, n_a = sum(sel(r) for r in groups[arm]), len(groups[arm])
            ci = f'[{pct(b["lo"])},{pct(b["hi"])}]'
            # When neither arm produced a single event, every resample is zero
            # and the bootstrap returns [0,0] — an interval with no uncertainty
            # in it, which is an artefact of the method and not a finding. Zero
            # events in n bounds the rate; it does not pin it to zero. Fall back
            # to the exact one-sided bound, which at these arm sizes is usually
            # WIDER than the minimum effect of interest and therefore refuses
            # the bounded-null verdict the degenerate interval would have won.
            degenerate = k_a == 0 and b['lo'] == 0.0 and b['hi'] == 0.0
            if degenerate:
                ub = 1 - 0.05 ** (1 / n_a)
                ci = f'0 events in {n_a}, rate <{pct(ub)}'
                verdict = (f'bounded null (<{MEI:.0%})' if ub < MEI
                           else 'inconclusive — n too small to bound')
            elif b['lo'] > 0 and b['diff'] >= MEI:
                verdict = 'dominant mechanism'
            elif b['hi'] < MEI:
                verdict = f'bounded null (<{MEI:.0%})'
            else:
                verdict = 'inconclusive'
            print(f'  {label(arm):<28} {b["endpoint"]:<24} {pct(b["diff"]):>7}  '
                  f'{ci:<26}  {adj:>8.4f}  {verdict}')
        print(f'\n  Minimum effect of interest {MEI:.0%}, pre-declared (the standard name for')
        print('  this quantity is the smallest effect size of interest, SESOI).')
        print('  "Bounded null" is an equivalence-testing verdict (cf. TOST): the interval')
        print(f'  RULES OUT an effect as large as {MEI:.0%} — it is not a failure to reject.')
        print('  "Inconclusive" means the interval spans both that threshold and zero.')

    # Cost, for the efficiency line in the paper.
    print('\n' + '-' * 74)
    print('COST PER VERIFIED SUCCESS')
    print('-' * 74)
    print(f'{"arm":<28} {"in-tok/run":>11} {"sec/run":>9} {"in-tok per success":>20}')
    for arm in ARMS:
        rs = groups.get(arm, [])
        if not rs:
            continue
        v = sum(r['success'] for r in rs)
        tok = sum(r['input_tokens'] or 0 for r in rs)
        sec = sum(r['wall_clock_seconds'] or 0 for r in rs)
        per = f'{tok / v:>20,.0f}' if v else f'{"n/a (0 successes)":>20}'
        print(f'{label(arm):<28} {tok/len(rs):>11,.0f} {sec/len(rs):>9.1f} {per}')
    print()

    # Opt-in: it re-runs the bootstrap four more times and the default report is
    # already the slowest thing in the analysis path.
    if robust:
        robustness(groups)


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
    main(sel, tag, robust='--robustness' in sys.argv)
