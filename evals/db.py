"""SQLite access for pincercraft_evals.db (stdlib only).

connect() applies the schema idempotently and returns a live connection.
insert_attempt() / insert_gate() are the only write paths; both use
keyword-only args so a caller cannot silently misorder columns, and both let
the DB's CHECK constraints reject bad enums (sqlite3.IntegrityError).
"""
import datetime
import pathlib
import sqlite3
import uuid

_HERE = pathlib.Path(__file__).resolve().parent
ROOT = _HERE.parent
DB_PATH = ROOT / "pincercraft_evals.db"
SCHEMA_PATH = _HERE / "__init__.sql"


def _utcnow() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def connect(db_path: pathlib.Path | str = DB_PATH) -> sqlite3.Connection:
    """Open the DB, apply the schema (idempotent), return the connection."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA_PATH.read_text())
    conn.commit()
    return conn


def insert_attempt(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    task_name: str,
    difficulty_tier: str,
    task_set: str,
    commit_hash: str,
    success: int,
    progress_score: float | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    steps: int | None = None,
    retry_count: int | None = None,
    wall_clock_seconds: float | None = None,
    n_distinct_actions: int | None = None,
    failure_mode: str | None = None,
    timestamp: str | None = None,
    attempt_id: str | None = None,
) -> str:
    """Insert one task_attempts row. Returns the attempt_id (UUID if not given)."""
    attempt_id = attempt_id or str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO task_attempts (
            attempt_id, task_id, task_name, difficulty_tier, task_set,
            commit_hash, timestamp, success, progress_score,
            input_tokens, output_tokens, steps, retry_count,
            wall_clock_seconds, n_distinct_actions, failure_mode
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            attempt_id, task_id, task_name, difficulty_tier, task_set,
            commit_hash, timestamp or _utcnow(), int(success), progress_score,
            input_tokens, output_tokens, steps, retry_count,
            wall_clock_seconds, n_distinct_actions, failure_mode,
        ),
    )
    conn.commit()
    return attempt_id


def insert_gate(
    conn: sqlite3.Connection,
    *,
    commit_hash: str,
    decision: str,
    proposed_change_summary: str | None = None,
    proposed_diff: str | None = None,
    human_reason: str | None = None,
    timestamp: str | None = None,
    decision_id: str | None = None,
) -> str:
    """Insert one gate_decisions row. Returns the decision_id (UUID if not given)."""
    decision_id = decision_id or str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO gate_decisions (
            decision_id, timestamp, commit_hash, proposed_change_summary,
            proposed_diff, decision, human_reason
        ) VALUES (?,?,?,?,?,?,?)
        """,
        (
            decision_id, timestamp or _utcnow(), commit_hash,
            proposed_change_summary, proposed_diff, decision, human_reason,
        ),
    )
    conn.commit()
    return decision_id
