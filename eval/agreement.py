#!/usr/bin/env python3
"""Scorer-agreement tooling for the supervised run.

    label  <task_id> <0|1> [notes...]   record YOUR success call for an attempt
    report                              scorer-vs-human agreement table

`label` writes a gold_attempts row (human call, per the gold-DB rule: rows are
added only on an explicit command — running this IS the command), tied to the
task_attempts row by `agree:task_id=N` in notes, since gold_attempts has no
task_id column and task_name joins are fragile.

`report` is the credibility anchor for the benchmark campaign: % of attempts
where the deterministic scorer's verdict matched the human's, split by
label_source (scorer-measured vs honor-system rows).
"""
import sqlite3, sys, os, datetime, subprocess, re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from eval_db import DB_PATH as DB  # noqa: E402  single env-aware definition
MARK = re.compile(r'agree:task_id=(\d+)')

def head():
    try:
        return subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'],
                                       cwd=os.path.dirname(DB)).decode().strip()
    except Exception:
        return None

def latest_attempt(con, task_id):
    return con.execute(
        'SELECT attempt_id, task_id, task_name, success, label_source, failure_mode, timestamp '
        'FROM task_attempts WHERE task_id=? ORDER BY rowid DESC LIMIT 1',
        (str(task_id),)).fetchone()

def label(task_id, success, notes):
    con = sqlite3.connect(DB)
    att = latest_attempt(con, task_id)
    if not att:
        sys.exit(f'no task_attempts row with task_id={task_id} — run a cycle first')
    tag = f'agree:task_id={task_id}'
    dupe = con.execute("SELECT id FROM gold_attempts WHERE notes LIKE ?", (f'%{tag}%',)).fetchone()
    if dupe:
        sys.exit(f'task_id={task_id} already labeled (gold row #{dupe[0]}) — delete that row to relabel')
    con.execute(
        'INSERT INTO gold_attempts(timestamp,commit_hash,task_name,action_log,success,notes,source) '
        'VALUES(?,?,?,?,?,?,?)',
        (datetime.datetime.utcnow().isoformat() + 'Z', head(), att[2], '',
         success, f'{tag} {notes}'.strip(), 'gold'))
    con.commit()
    ref = 'referee' if att[4] == 'referee' else att[4]
    agree = 'AGREE' if bool(att[3]) == bool(success) else 'DISAGREE'
    print(f'labeled task #{task_id} ({att[2]!r}): human={success} vs {ref}={att[3]} → {agree}')

def report():
    con = sqlite3.connect(DB)
    rows = con.execute('SELECT success, notes FROM gold_attempts WHERE notes LIKE "%agree:task_id=%"').fetchall()
    if not rows:
        sys.exit('no labeled attempts yet — label with: python3 eval/agreement.py label <task_id> <0|1>')
    pairs = []
    for human_success, notes in rows:
        m = MARK.search(notes or '')
        if not m:
            continue
        att = latest_attempt(con, int(m.group(1)))
        if att:
            pairs.append((att, bool(human_success)))
    print(f'{"task":>6}  {"label_src":<12} {"referee":<8} {"human":<6} {"verdict":<9} name')
    ref_n = ref_ok = hon_n = hon_ok = 0
    for att, human in sorted(pairs, key=lambda p: int(p[0][1])):
        agree = bool(att[3]) == human
        src = att[4] or 'honor_system'
        if src == 'referee':
            ref_n += 1; ref_ok += agree
        else:
            hon_n += 1; hon_ok += agree
        print(f'#{att[1]:>5}  {src:<12} {str(bool(att[3])):<8} {str(human):<6} '
              f'{"AGREE" if agree else "DISAGREE":<9} {att[2][:60]}')
    print()
    if ref_n:
        print(f'scorer-measured agreement: {ref_ok}/{ref_n} ({100*ref_ok/ref_n:.0f}%)  ← the anchor number')
    if hon_n:
        print(f'honor-system rows (queue outcome vs human): {hon_ok}/{hon_n} ({100*hon_ok/hon_n:.0f}%)')

if __name__ == '__main__':
    if len(sys.argv) >= 4 and sys.argv[1] == 'label':
        label(int(sys.argv[2]), int(sys.argv[3]), ' '.join(sys.argv[4:]))
    elif len(sys.argv) == 2 and sys.argv[1] == 'report':
        report()
    else:
        sys.exit(__doc__)
