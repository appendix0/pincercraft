#!/usr/bin/env python3
# Append a HUMAN-VERIFIED, high-value interaction row to gold_attempts.
#
# This is the CURATED gold set — deliberately distinct from the auto rows in
# task_attempts (task_source 'llm' = eval loop, 'player' = auto play_logger):
#   - added ONLY on explicit command (never automatically),
#   - `success` is the HUMAN's real-success call, not the verify gate,
#   - pinned to the commit_hash that produced the trace.
# Multi-line action logs: pass --log-file - to read the log from stdin.
import sqlite3, sys, subprocess, datetime, argparse, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from eval_db import DB_PATH as DB  # noqa: E402  single env-aware definition

def head():
    try:
        return subprocess.check_output(
            ['git', 'rev-parse', '--short', 'HEAD'],
            cwd=os.path.dirname(os.path.abspath(DB))).decode().strip()
    except Exception:
        return None

def ensure_table(con):
    con.execute('''CREATE TABLE IF NOT EXISTS gold_attempts(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT NOT NULL,
        commit_hash TEXT,
        task_name   TEXT,          -- the command / goal given
        action_log  TEXT,          -- the action sequence / interaction chunk
        success     INTEGER,       -- HUMAN real-success call (1/0)
        notes       TEXT,
        source      TEXT DEFAULT 'gold')''')

def main():
    ap = argparse.ArgumentParser(description='Add a human-verified gold interaction row.')
    ap.add_argument('--task', required=True, help='the command / goal you gave')
    ap.add_argument('--log', default='', help='the action log / interaction chunk')
    ap.add_argument('--log-file', help='read action log from a file, or - for stdin')
    ap.add_argument('--success', type=int, required=True, choices=[0, 1], help='YOUR real-success call')
    ap.add_argument('--notes', default='')
    a = ap.parse_args()

    action_log = a.log
    if a.log_file:
        action_log = sys.stdin.read() if a.log_file == '-' else open(a.log_file).read()

    con = sqlite3.connect(DB)
    ensure_table(con)
    con.execute(
        'INSERT INTO gold_attempts(timestamp,commit_hash,task_name,action_log,success,notes,source) '
        'VALUES(?,?,?,?,?,?,?)',
        (datetime.datetime.utcnow().isoformat() + 'Z', head(), a.task, action_log, a.success, a.notes, 'gold'))
    con.commit()
    n = con.execute('SELECT COUNT(*) FROM gold_attempts').fetchone()[0]
    print(f"gold row #{n} added — {a.task!r}  success={a.success}  @ {head()}")

if __name__ == '__main__':
    main()
