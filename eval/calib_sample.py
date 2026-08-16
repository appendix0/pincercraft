#!/usr/bin/env python3
"""Stratified draw for the scorer re-calibration (preregistration, 2026-08-16).

    draw     [--out-dir docs/paper]   deterministic draw + sealed commitment
    reveal   [--out-dir docs/paper]   write the stratum-annotated manifest
    verify   [--out-dir docs/paper]   re-derive the draw, check it against the seal

Why this exists rather than `evidence.py cards --limit 30`:
`cards` issues attempts in glob order and takes the first N. That is the
convenience sampling which produced the existing calibration set, in which 34 of
39 labels are true completions and the scorer's *false-completion* verdict — the
one every headline rate depends on — carries 2 labels. Drawing the replacement
set the same way would reproduce the same composition. This module draws by
stratum instead, oversampling the cell that certifies the endpoint.

The three cells are the 2x2 of scorer verdict against agent claim, collapsed to
the three that can occur:

    A  scorer says success                        -> certifies sensitivity
    B  scorer says fail, agent claimed done       -> FALSE COMPLETION, the endpoint
    C  scorer says fail, agent did not claim      -> certifies the reverse error

and each is split by which scorer path produced the verdict, because the
inventory-delta path and the block-scan path are two different instruments and a
label on one certifies nothing about the other.

**The seal.** A stratum-annotated manifest reveals the scorer's verdict for
every drawn attempt, so publishing one before labelling would hand the labeller
the answer key. `draw` therefore writes two files: a sealed commitment holding
the SHA-256 of the annotated manifest plus the task_ids in a seeded presentation
order that carries no stratum information, and the annotated manifest itself,
which is withheld until labelling completes. `reveal` re-emits the manifest and
`verify` re-derives the whole draw from the declared seed and checks it against
the seal, so the draw is auditable rather than trusted.
"""
import argparse, hashlib, json, os, random, sqlite3, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from eval_db import DB_PATH as DB          # noqa: E402  single env-aware definition
from campaign_report import load           # noqa: E402  one definition of the primary set

# Declared in the pre-registration entry before any card was rendered. Changing
# any of these changes which attempts are drawn, which is why they live here as
# constants and are printed by `verify` rather than passed on a command line.
SEED = 20260816
PLATFORM_PREFIX = 'Build a solid 5x5 cobblestone platform'
ALLOCATION = {
    ('B', 'inventory'): 17,   # false completion, delta-scored — the endpoint
    ('B', 'blockscan'): 4,    # false completion, block-scan — uncalibrated path
    ('C', 'inventory'): 4,
    ('C', 'blockscan'): 1,
    ('A', 'inventory'): 4,
}
SEAL_NAME = 'calibration_sample.seal.txt'
MANIFEST_NAME = 'calibration_sample.json'


def cell(row):
    if row['success']:
        return 'A'
    # claimed() resolves to exactly this: the scorer flags where the agent's
    # claim and its own world read diverge, so false completion is not inferred.
    if (row['failure_mode'] or '') == 'false_done_referee':
        return 'B'
    return 'C'


def path_of(row):
    return 'blockscan' if row['task_name'].startswith(PLATFORM_PREFIX) else 'inventory'


def eligible(con):
    """The registered universe: confirmatory primary set, minus collided ids.

    A `task_id` carried by more than one `task_attempts` row is dropped, because
    `agreement.py label` binds a human call to the LATEST row for that id — so a
    label on a collided id would certify an attempt the labeller never saw."""
    rows = load(con, None, 'conf')
    primary = [r for r in rows if not r['discarded'] and not r['excluded']]
    cur = con.cursor()
    collided = {t for (t,) in cur.execute(
        'SELECT task_id FROM task_attempts GROUP BY task_id HAVING COUNT(*) > 1')}
    out, dropped = [], []
    for r in primary:
        tid = cur.execute('SELECT task_id FROM task_attempts WHERE attempt_id=?',
                          (r['attempt_id'],)).fetchone()[0]
        if str(tid) in collided:
            dropped.append(int(tid))
            continue
        d = dict(r)
        d['task_id'] = int(tid)
        out.append(d)
    return out, sorted(set(dropped))


def draw_strata(con):
    elig, dropped = eligible(con)
    strata = {}
    for r in elig:
        strata.setdefault((cell(r), path_of(r)), []).append(r)

    picked = {}
    for key, want in sorted(ALLOCATION.items()):
        pool = sorted({r['task_id'] for r in strata.get(key, [])})
        if len(pool) < want:
            raise SystemExit(
                f'stratum {key} has {len(pool)} eligible attempts, allocation asks '
                f'for {want} — the registered allocation cannot be honoured; amend '
                f'the pre-registration rather than silently drawing fewer')
        # One RNG per stratum, seeded from the declared seed and the stratum name,
        # so adding or resizing one stratum cannot change what another drew.
        rng = random.Random(f'{SEED}:{key[0]}:{key[1]}')
        picked[key] = sorted(rng.sample(pool, want))
    return picked, elig, dropped


def manifest_bytes(picked):
    """Canonical bytes of the annotated draw — what the seal commits to."""
    body = {f'{c}_{p}': ids for (c, p), ids in sorted(picked.items())}
    return json.dumps(body, indent=2, sort_keys=True).encode()


def cmd_draw(out_dir):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    picked, elig, dropped = draw_strata(con)

    raw = manifest_bytes(picked)
    digest = hashlib.sha256(raw).hexdigest()

    every = sorted({t for ids in picked.values() for t in ids})
    order = list(every)
    random.Random(f'{SEED}:presentation').shuffle(order)

    seal = [
        '# Sealed calibration draw — preregistration 2026-08-16',
        '',
        'The stratum-annotated manifest is withheld until labelling completes,',
        'because the stratum IS the scorer verdict. This file commits to it.',
        '',
        f'seed                : {SEED}',
        f'eligible attempts   : {len(elig)}',
        f'dropped (task_id collision) : {dropped}',
        f'drawn               : {len(every)}',
        f'manifest sha256     : {digest}',
        '',
        'Presentation order (seeded shuffle across strata, so the order carries',
        'no information about which cell an attempt came from):',
        '',
    ]
    seal += [f'  {i + 1:>2}. #{t}' for i, t in enumerate(order)]
    seal += ['', 'Verify with: python3 eval/calib_sample.py verify', '']

    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, SEAL_NAME), 'w') as f:
        f.write('\n'.join(seal))
    with open(os.path.join(out_dir, MANIFEST_NAME), 'wb') as f:
        f.write(raw)

    print(f'eligible {len(elig)}, dropped {dropped}, drawn {len(every)}')
    for key, ids in sorted(picked.items()):
        print(f'  {key[0]} {key[1]:<10} {len(ids):>2}')
    print(f'\nsealed  : {os.path.join(out_dir, SEAL_NAME)}   (commit now)')
    print(f'manifest: {os.path.join(out_dir, MANIFEST_NAME)}   (WITHHOLD until labelled)')
    print(f'sha256  : {digest}')
    print('\npresentation order:', ' '.join(f'#{t}' for t in order))


def cmd_verify(out_dir):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    picked, elig, dropped = draw_strata(con)
    digest = hashlib.sha256(manifest_bytes(picked)).hexdigest()
    seal_path = os.path.join(out_dir, SEAL_NAME)
    if not os.path.exists(seal_path):
        sys.exit(f'no seal at {seal_path} — run `draw` first')
    sealed = None
    for line in open(seal_path):
        if line.startswith('manifest sha256'):
            sealed = line.split(':', 1)[1].strip()
    print(f'seed {SEED}, eligible {len(elig)}, dropped {dropped}')
    print(f'  re-derived : {digest}')
    print(f'  sealed     : {sealed}')
    print('  MATCH' if sealed == digest else '  MISMATCH — the draw is not the one committed to')
    if sealed != digest:
        sys.exit(1)


def cmd_reveal(out_dir):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    picked, _, _ = draw_strata(con)
    raw = manifest_bytes(picked)
    with open(os.path.join(out_dir, MANIFEST_NAME), 'wb') as f:
        f.write(raw)
    print(raw.decode())
    print(f'sha256: {hashlib.sha256(raw).hexdigest()}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('command', choices=['draw', 'verify', 'reveal'])
    ap.add_argument('--out-dir', default=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs', 'paper'))
    a = ap.parse_args()
    {'draw': cmd_draw, 'verify': cmd_verify, 'reveal': cmd_reveal}[a.command](a.out_dir)
