#!/usr/bin/env python3
"""eval_db.py — system of record for the Daedelus404 self-improvement loop.

SQLite store (pincercraft_evals.db) with three tables:
  task_attempts   — one row per agent loop run, tagged by task_source
                    (player vs llm task-giver) and rag_version (regime fingerprint)
  gate_decisions  — one row per human approve/reject at the authorization gate
  eval_regimes    — one row per code-regime boundary (e.g. the RAG-revival fix),
                    so post-fix data can be analyzed apart from pre-fix data

Schema is created/migrated on demand, so `connect()` is safe to call anywhere.

CLI:
  eval_db.py init
  eval_db.py log-attempt --json '<row>'      # or pipe JSON on stdin
  eval_db.py log-gate --commit C --summary S --decision approve|reject --reason R
  eval_db.py log-regime --name N --rag-version V --commit C --note NOTE
  eval_db.py ingest-jsonl [--path eval/play_attempts.jsonl]  # load + truncate play log
"""
import argparse, json, os, sqlite3, sys, uuid
from datetime import datetime, timezone

DB_PATH = os.environ.get(
    "PINCER_EVAL_DB",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pincercraft_evals.db"),
)

# Where play_logger.js appends player-driven attempt rows (one JSON object per line).
PLAY_LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "play_attempts.jsonl")

# Current code regime for the doc-retrieval pipeline. Bumped when a foundation
# fix changes bot behavior enough that older data must be quarantined.
#   0 = dead-RAG era (retriever ranked nothing -> coder hallucinated)
#   1 = lexical coverage retrieval revived (commit 96eca4c, 2026-05-31)
# New attempts are stamped with this unless the row overrides it.
CURRENT_RAG_VERSION = 1

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
    progress_score      REAL,             -- 0.0-1.0
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    steps               INTEGER,
    retry_count         INTEGER,
    wall_clock_seconds  REAL,
    n_distinct_actions  INTEGER,
    failure_mode        TEXT,             -- nullable
    rag_version         INTEGER DEFAULT 0,     -- regime fingerprint (see CURRENT_RAG_VERSION)
    task_source         TEXT DEFAULT 'llm'     -- 'player' (real play) | 'llm' (eval task-giver)
);
-- Declared discards (preregistration §8), kept OUT of task_attempts so raw
-- receipts stay append-only. The first two aborts were recorded by rewriting
-- task_set to '*_aborted_*', which mutates the very rows the analysis is
-- supposed to be able to re-derive from; a reader could no longer tell which
-- arm an attempt actually ran under. Excluding by reference fixes that and
-- makes the discard reversible and auditable.
CREATE TABLE IF NOT EXISTS exclusions (
    attempt_id  TEXT PRIMARY KEY,
    task_id     TEXT,
    rule        TEXT,          -- which of §8 rules 1-4
    reason      TEXT,
    excluded_at TEXT,
    source      TEXT           -- who/what recorded it
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
CREATE TABLE IF NOT EXISTS eval_regimes (
    regime_id    TEXT PRIMARY KEY,
    name         TEXT UNIQUE,
    rag_version  INTEGER,
    commit_hash  TEXT,
    created_at   TEXT,
    note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_commit ON task_attempts(commit_hash);
CREATE INDEX IF NOT EXISTS idx_attempts_tier   ON task_attempts(difficulty_tier);
"""

# Columns added after the original schema shipped. CREATE TABLE IF NOT EXISTS
# does not alter an existing table, so add them idempotently on connect.
_MIGRATIONS = (
    "ALTER TABLE task_attempts ADD COLUMN rag_version INTEGER DEFAULT 0",
    "ALTER TABLE task_attempts ADD COLUMN task_source TEXT DEFAULT 'llm'",
    # eval/referee.mjs: the task's completion criterion, and who labeled success —
    # 'referee' (independent inventory verdict) vs 'honor_system' (queue outcome).
    "ALTER TABLE task_attempts ADD COLUMN end_factor TEXT",
    "ALTER TABLE task_attempts ADD COLUMN label_source TEXT DEFAULT 'honor_system'",
    # Campaign seed: three independent passes per arm (preregistration.md §4).
    # The analysis clusters by task and treats seeds within a task as
    # non-independent, so the seed has to be recoverable per row rather than
    # inferred from timestamps. 0 = pre-campaign rows.
    "ALTER TABLE task_attempts ADD COLUMN seed INTEGER DEFAULT 0",
    # Position of this arm within its backtest's run order, 1-based. Arm order
    # used to be fixed, which made position perfectly confounded with arm
    # identity: `gates` always ran 4th, inherited the richest carried-over
    # inventory, and scored 30/30 — read as a layer effect until a controlled
    # re-run showed +0.0pp (p=1.000). Order is randomized now, so the variable
    # has to be recorded to be adjustable for. 0 = not part of a campaign arm.
    "ALTER TABLE task_attempts ADD COLUMN arm_position INTEGER DEFAULT 0",
    # The harness's OWN decisions, kept separate from the agent's claim
    # (evidence.outcome) and the referee's verdict (success). Without these the
    # three-way separation is not recoverable from the row: we could see what
    # the bot said and what was true, but not what the harness did about it.
    #   harness_verify:     blocked | passed | off
    #   harness_autofinish: fired   | not_fired | off
    "ALTER TABLE task_attempts ADD COLUMN harness_verify TEXT",
    "ALTER TABLE task_attempts ADD COLUMN harness_autofinish TEXT",
    # Model and inference configuration in force for this attempt. Unrecorded
    # until now, so a model or sampling change mid-campaign would have been
    # invisible in the data — arms could differ in the one variable the
    # protocol most insists on holding fixed and nothing would show it.
    # Stored as JSON (planner/coder model ids, max_tokens) rather than a column
    # each: the shape belongs to the profile, and widening the schema for every
    # new inference knob would churn the table.
    "ALTER TABLE task_attempts ADD COLUMN model_config TEXT",
    # Path to this attempt's action trace, relative to the repo root. The trace
    # already existed (bots/<name>/episodes/<id>.jsonl) but was reachable only
    # by guessing the filename, so the receipt did not actually lead to it.
    "ALTER TABLE task_attempts ADD COLUMN episode_path TEXT",
)


def connect(path=DB_PATH):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    for ddl in _MIGRATIONS:
        try:
            conn.execute(ddl)
        except sqlite3.OperationalError:
            pass  # duplicate column -> already migrated
    # Indexes on the migrated columns must come AFTER the ALTERs — the columns
    # don't exist when executescript runs on a pre-migration DB.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_attempts_source ON task_attempts(task_source)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_attempts_rag    ON task_attempts(rag_version)")
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
        # quarantine tags
        "rag_version": int(row.get("rag_version", CURRENT_RAG_VERSION)),
        "task_source": row.get("task_source", "llm"),
        "end_factor": row.get("end_factor"),
        "label_source": row.get("label_source", "honor_system"),
        "seed": int(row.get("seed", 0) or 0),
        "arm_position": int(row.get("arm_position", 0) or 0),
        # NULL, not a default string: a row written by a path that does not
        # know about the harness (player logging, older runners) must be
        # distinguishable from one that observed the layer switched off.
        "harness_verify": row.get("harness_verify") or None,
        "harness_autofinish": row.get("harness_autofinish") or None,
        "model_config": row.get("model_config") or None,
        "episode_path": row.get("episode_path") or None,
    }
    # Column list is derived from `rec`, not written out by hand. It used to be
    # hardcoded and ended at :seed, so arm_position / harness_verify /
    # harness_autofinish were assembled above and then silently dropped on
    # insert — the row was written, no error was raised, and the fields simply
    # read back NULL. Anything added to `rec` is now persisted by construction.
    with connect(path) as conn:
        cols = list(rec)
        conn.execute(
            f"INSERT INTO task_attempts ({','.join(cols)}) "
            f"VALUES ({','.join(':' + c for c in cols)})",
            rec,
        )
    return rec["attempt_id"]


def excluded_attempt_ids(path=DB_PATH):
    """attempt_ids discarded under §8. Analysis filters on this rather than on
    the arm name, so `task_set` keeps saying which arm the attempt ran under."""
    with connect(path) as conn:
        return {r[0] for r in conn.execute("SELECT attempt_id FROM exclusions")}


def log_exclusion(attempt_id, rule, reason, task_id="", source="manual", path=DB_PATH):
    """Record a discard by reference. Idempotent: re-recording the same attempt
    replaces the row rather than raising, so a re-run of a migration is safe."""
    with connect(path) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO exclusions "
            "(attempt_id,task_id,rule,reason,excluded_at,source) "
            "VALUES (?,?,?,?,?,?)",
            (attempt_id, str(task_id), str(rule), reason, _now(), source),
        )
    return attempt_id


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


def log_regime(name, rag_version, commit_hash, note, path=DB_PATH):
    """Record a code-regime boundary. Idempotent on name (re-runs update it)."""
    rec = {
        "regime_id": str(uuid.uuid4()),
        "name": name,
        "rag_version": int(rag_version),
        "commit_hash": commit_hash or "",
        "created_at": _now(),
        "note": note or "",
    }
    with connect(path) as conn:
        conn.execute(
            "INSERT INTO eval_regimes (regime_id,name,rag_version,commit_hash,created_at,note) "
            "VALUES (:regime_id,:name,:rag_version,:commit_hash,:created_at,:note) "
            "ON CONFLICT(name) DO UPDATE SET "
            "rag_version=excluded.rag_version, commit_hash=excluded.commit_hash, "
            "created_at=excluded.created_at, note=excluded.note",
            rec,
        )
    return rec["regime_id"]


def ingest_jsonl(jsonl_path, path=DB_PATH):
    """Load newline-delimited attempt rows (written by play_logger.js) into the
    DB. The file is atomically renamed BEFORE reading (the bot's appendFileSync
    recreates the original path), so a row appended mid-ingest can never be
    lost to the old read-then-truncate race. A leftover claim from a crashed
    ingest is consumed first. Returns count."""
    claimed = jsonl_path + ".ingesting"
    n = 0
    for source in ("leftover", "fresh"):
        if source == "fresh":
            if not os.path.exists(jsonl_path):
                break
            os.replace(jsonl_path, claimed)  # atomic claim
        if not os.path.exists(claimed):
            continue
        with open(claimed) as f:
            lines = [ln for ln in f if ln.strip()]
        for ln in lines:
            try:
                log_attempt(json.loads(ln), path)
                n += 1
            except Exception as e:
                print(f"ingest: skipped bad line ({e})", file=sys.stderr)
        os.remove(claimed)  # consumed
    return n


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

    r = sub.add_parser("log-regime")
    r.add_argument("--name", required=True)
    r.add_argument("--rag-version", type=int, required=True)
    r.add_argument("--commit", default="")
    r.add_argument("--note", default="")

    i = sub.add_parser("ingest-jsonl")
    i.add_argument("--path", default=PLAY_LOG_PATH, help="JSONL file to ingest and truncate")

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
    elif args.cmd == "log-regime":
        rid = log_regime(args.name, args.rag_version, args.commit, args.note)
        print(rid)
    elif args.cmd == "ingest-jsonl":
        n = ingest_jsonl(args.path)
        print(f"ingested {n} row(s) from {args.path}")


if __name__ == "__main__":
    main()
