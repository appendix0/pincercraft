#!/usr/bin/env python3
"""The rules that decide what the paper's numbers are computed over.

Extracted so there is exactly ONE definition of each. campaign_report.py and
taxonomy.py both need the claim rule, the primary-set rule and the outcome
categories; before this module existed taxonomy imported them from
campaign_report, which made the reverse direction (campaign_report needing the
categories, to score each layer on its own endpoint) a circular import and
tempted a second copy. Two copies of a rule that decides which attempts count
is precisely the drift this file exists to prevent.

Nothing here touches the database or the filesystem except `excluded_task_name`,
which reads the benchmark definition.
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BENCH = os.path.join(ROOT, 'eval', 'benchmarks.json')

CATEGORIES = [
    'true_completion',          # claimed done, and it was
    'false_completion',         # claimed done, world says otherwise
    'reached_not_recognized',   # goal met, agent never claimed it
    'capability_failure',       # tried, gave up, goal genuinely unmet
    'budget_exhaustion',        # ran out of time with the goal unmet
    'infrastructure',           # the rig, not the agent
]


def excluded_task_name(dataset):
    """The pre-declared exclusion for `dataset`, or None if nothing is excluded.

    Keyed on an explicit `exclude_from_primary` flag, not on the presence of a
    `note`: notes are documentation and several tasks carry one, so matching on
    `note` picked whichever such row happened to sit first in the file. That
    resolved correctly only by file ordering, and a reorder would have quietly
    swapped the exclusion — dropping a referee-labeled task from the primary
    endpoint and admitting the one task that can only be honor-system labeled.

    `dataset` is the task_set prefix ('conf' or 'bench'), because the exclusion
    is a property of how the data was SCORED, not of the task. The 2026-08-09
    deviation lifted it "for confirmatory runs" once a block-scan referee could
    label the platform task, and retained it for the exploratory backtests,
    whose platform attempts were honor-system scored — re-scoring those now
    would mix two instruments inside one dataset. Applying one rule to both
    would therefore silently restate already-reported pilot numbers.

    Lifted for confirmatory data 2026-08-14, the condition in that deviation
    having been met: the campaign re-ran the whole set under the new referee and
    all 27 confirmatory platform attempts carry label_source=referee. The
    confirmatory primary set is 13 tasks/arm, not 12."""
    if dataset == 'conf':
        return None
    with open(BENCH) as f:
        rows = json.load(f)
    marked = [r['description'] for r in rows if r.get('exclude_from_primary')]
    # Exactly one row must be marked: zero means the exclusion silently stopped
    # applying to the exploratory data, more than one is unreadable as intent,
    # and every exploratory rate is computed against this set.
    if len(marked) != 1:
        raise SystemExit(
            f'{BENCH}: expected exactly 1 task with "exclude_from_primary": true, '
            f'found {len(marked)}')
    return marked[0]


def claimed(success, failure_mode):
    """Did the AGENT declare the task complete?

    The referee's verdict is `success`; the bot's own claim is recoverable
    because the referee flags exactly where the two diverge."""
    if failure_mode == 'false_done_referee':
        return 1          # bot said done, world disagreed
    if failure_mode == 'queue_never_finished':
        return 0          # world says done, bot never claimed it
    return success


def classify(row, claim, discarded=frozenset()):
    """One attempt -> one category. `row` is a task_attempts record.
    `claim` is a bool: did the agent declare the task complete?

    `discarded` holds attempt_ids recorded in the `exclusions` table."""
    # Infrastructure first: a bot that could not act never produced a result to
    # classify, and scoring it as a capability failure is how a credit outage
    # once read as a 61pp layer effect (docs/paper/aborts.md).
    if row['attempt_id'] in discarded:
        return 'infrastructure'
    if (row['steps'] or 0) == 0 and (row['failure_mode'] or '') == 'timeout':
        return 'infrastructure'

    success = bool(row['success'])

    if success:
        return 'true_completion' if claim else 'reached_not_recognized'
    if claim:
        return 'false_completion'
    if (row['failure_mode'] or '') == 'timeout':
        return 'budget_exhaustion'
    return 'capability_failure'


def category_of(row):
    """The taxonomy category of a loaded report row.

    Report rows already carry a resolved `claimed`, so this needs no evidence
    lookup — the two paths agree on 256/256 attempts carrying both signals."""
    return classify(row, bool(row['claimed']))


def is_category(name):
    """An endpoint selector for cluster_bootstrap: 1 when the attempt fell in
    `name`, else 0."""
    return lambda r: 1 if category_of(r) == name else 0


# Which outcome each ablation is scored on. Pre-registration (2026-08-09):
# "Endpoints are the taxonomy category each layer targets, not overall success
# (separating verify from autofinish on success needs n=372/arm)." Scoring a
# layer on overall success instead both tests a hypothesis nobody registered and
# does it at a sample size chosen for a different, sharper quantity.
#
# terminology.md §5 names the target category for the two termination layers.
# The three capability layers have no separately declared category; their target
# is the one they can move, `capability_failure`, and it is written here rather
# than left implicit so the endpoint appears beside every number in the output.
LAYER_ENDPOINT = {
    'verify': 'false_completion',
    'autofinish': 'reached_not_recognized',
    'perception': 'capability_failure',
    'gates': 'capability_failure',
    'reflexes': 'capability_failure',
    # The retired compound arm targets whatever its two halves did; false
    # completion is the one it was read on in backtests 1-2.
    'measurement': 'false_completion',
}

# Pre-declared minimum effect of interest for a per-layer ablation, in points.
# A layer that moves its target failure mode by less than this is reported as a
# bounded null rather than chased with more n (preregistration, 2026-08-09).
MEI = 0.15
