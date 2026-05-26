#!/usr/bin/env python3
"""eval_db.py — system of record for the Daedelus404 self-improvement loop.

SQLite store (pincercraft_evals.db) with two tables:
  task_attempts   — one row per agent loop run (the eval)
  gate_decisions  — one row per human approve/reject at the authorization gate

Schema is created on demand, so `connect()` is safe to call anywhere.

CLI:
  eval_db.py init
  eval_db.py log-attempt --json '<row>'      # or pipe JSON on stdin
  eval_db.py log-gate --commit C --summary S --decision approve|reject --reason R
"""
import argparse, json, os, sqlite3, sys, uuid
from datetime import datetime, timezone

DB_PATH = os.environ.get(
    "PINCER_EVAL_DB",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pincercraft_evals.db"),
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS task_attempts (
    attempt_id          TEXT PRIMARY KEY,
    task_id             TEXT,
    task_name           TEXT,
    difficulty_tier     TEXT,
    task_set            TEXT,
    commit_hash         TEXT,
    timestamp           TEXT,
    success             INTEGER,          -- 0/1
    progress_score      REAL,             -- 0.0–1.0
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    steps               INTEGER,
    retry_count         INTEGER,
    wall_clock_seconds  REAL,
    n_distinct_actions  INTEGER,
    failure_mode        TEXT              -- nullable
);
CREATE TABLE IF NOT EXISTS gate_decisions (
    decision_id             TEXT PRIMARY KEY,
    timestamp               TEXT,
    commit_hash             TEXT,
    proposed_change_summary TEXT,
    proposed_diff           TEXT,
    decision                TEXT,         -- approve | reject
    human_reason            TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_commit ON task_attempts(commit_hash);
CREATE INDEX IF NOT EXISTS idx_attempts_tier   ON task_attempts(difficulty_tier);
"""


def connect(path=DB_PATH):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def _now():
    return datetime.now(timezone.utc).isoformat()


def log_attempt(row: dict, path=DB_PATH):
    """row uses column names; attempt_id/timestamp filled if absent."""
    success = int(bool(row.get("success")))
    rec = {
        "attempt_id": row.get("attempt_id") or str(uuid.uuid4()),
        "task_id": str(row.get("task_id", "")),
        "task_name": row.get("task_name", ""),
        "difficulty_tier": str(row.get("difficulty_tier", "")),
        "task_set": str(row.get("task_set", row.get("mode", ""))),
        "commit_hash": row.get("commit_hash", ""),
        "timestamp": row.get("timestamp") or _now(),
        "success": success,
        "progress_score": float(row.get("progress_score", 1.0 if success else 0.0)),
        "input_tokens": int(row.get("input_tokens", 0)),
        "output_tokens": int(row.get("output_tokens", 0)),
        "steps": int(row.get("steps", 0)),
        "retry_count": int(row.get("retry_count", 0)),
        "wall_clock_seconds": float(row.get("wall_clock_seconds", 0.0)),
        "n_distinct_actions": int(row.get("n_distinct_actions", 0)),
        # failure_mode is NULL on success unless explicitly given
        "failure_mode": row.get("failure_mode") or (None if success else "unknown"),
    }
    # Named column list (not positional VALUES) so the insert survives schema
    # drift — extra columns in the live table default to NULL instead of
    # raising "N columns but M values supplied".
    with connect(path) as conn:
        conn.execute(
            "INSERT INTO task_attempts "
            "(attempt_id,task_id,task_name,difficulty_tier,task_set,commit_hash,timestamp,"
            "success,progress_score,input_tokens,output_tokens,steps,retry_count,"
            "wall_clock_seconds,n_distinct_actions,failure_mode) VALUES "
            "(:attempt_id,:task_id,:task_name,:difficulty_tier,:task_set,:commit_hash,:timestamp,"
            ":success,:progress_score,:input_tokens,:output_tokens,:steps,:retry_count,"
            ":wall_clock_seconds,:n_distinct_actions,:failure_mode)",
            rec,
        )
    return rec["attempt_id"]


def log_gate(commit_hash, summary, decision, reason, path=DB_PATH):
    decision = decision.lower()
    if decision not in ("approve", "reject"):
        raise SystemExit(f"decision must be approve|reject, got {decision!r}")
    rec = {
        "decision_id": str(uuid.uuid4()),
        "timestamp": _now(),
        "commit_hash": commit_hash or "",
        "proposed_change_summary": summary or "",
        "decision": decision,
        "human_reason": reason or "",
    }
    with connect(path) as conn:
        conn.execute(
            "INSERT INTO gate_decisions "
            "(decision_id,timestamp,commit_hash,proposed_change_summary,decision,human_reason) "
            "VALUES (:decision_id,:timestamp,:commit_hash,:proposed_change_summary,"
            ":decision,:human_reason)",
            rec,
        )
    return rec["decision_id"]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")

    a = sub.add_parser("log-attempt")
    a.add_argument("--json", help="row as JSON; if omitted, read stdin")

    g = sub.add_parser("log-gate")
    g.add_argument("--commit", required=True)
    g.add_argument("--summary", default="")
    g.add_argument("--decision", required=True)
    g.add_argument("--reason", default="")

    args = ap.parse_args()
    if args.cmd == "init":
        connect().close()
        print(f"initialized {DB_PATH}")
    elif args.cmd == "log-attempt":
        raw = args.json if args.json else sys.stdin.read()
        aid = log_attempt(json.loads(raw))
        print(aid)
    elif args.cmd == "log-gate":
        did = log_gate(args.commit, args.summary, args.decision, args.reason)
        print(did)


if __name__ == "__main__":
    main()
