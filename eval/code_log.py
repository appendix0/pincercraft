#!/usr/bin/env python3
# Brief log of code changes -> code_changes table in pincercraft_evals.db.
# Standing rule (user, 2026-06-09): every code change gets a short row — what
# changed + why — pinned to its commit. Keep it terse.
#   python3 eval/code_log.py --files "src/agent/verify.js" \
#       --change "..." --reason "..." [--commit <hash>]
import sqlite3, subprocess, datetime, argparse, os

# Honour the same override as eval_db.py. Without it this resolves relative to
# the checkout it is run from, so a run inside a git worktree silently creates a
# throwaway DB (CREATE TABLE IF NOT EXISTS below) and reports success against it.
DB = os.environ.get(
    'PINCER_EVAL_DB',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'pincercraft_evals.db'))

def head():
    # Resolved from the working directory, i.e. the checkout that actually holds
    # the commit being logged. Deriving it from the DB's directory instead would
    # stamp the main checkout's HEAD onto a change committed in a worktree.
    try:
        return subprocess.check_output(
            ['git', 'rev-parse', '--short', 'HEAD']).decode().strip()
    except Exception:
        return None

def main():
    ap = argparse.ArgumentParser(description='Log a code change (what + why) to the DB.')
    ap.add_argument('--files', required=True, help='files touched')
    ap.add_argument('--change', required=True, help='what changed (brief)')
    ap.add_argument('--reason', required=True, help='why (brief)')
    ap.add_argument('--commit', help='commit hash (defaults to current HEAD)')
    a = ap.parse_args()

    con = sqlite3.connect(DB)
    con.execute('''CREATE TABLE IF NOT EXISTS code_changes(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT NOT NULL,
        commit_hash TEXT,
        files       TEXT,
        change      TEXT,
        reason      TEXT)''')
    con.execute('INSERT INTO code_changes(timestamp,commit_hash,files,change,reason) VALUES(?,?,?,?,?)',
        (datetime.datetime.now(datetime.timezone.utc).isoformat(), a.commit or head(), a.files, a.change, a.reason))
    con.commit()
    n = con.execute('SELECT COUNT(*) FROM code_changes').fetchone()[0]
    print(f"code change #{n} logged @ {a.commit or head()} — {a.change[:60]}")

if __name__ == '__main__':
    main()
