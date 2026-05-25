-- evals/__init__.sql — schema/migration for pincercraft_evals.db
-- Applied idempotently by evals/db.connect() on every connection.
-- CHECK constraints are the enforcement layer for every enum the spec names.

-- task_attempts: one row per task run.
-- `success` is set ONLY by a deterministic check (evals/checks.py) reading a
-- Mineflayer world-state snapshot — never by an LLM, never from agent logs.
CREATE TABLE IF NOT EXISTS task_attempts (
    attempt_id          TEXT PRIMARY KEY,                          -- UUID
    task_id             TEXT    NOT NULL,
    task_name           TEXT    NOT NULL,
    difficulty_tier     TEXT    NOT NULL CHECK (difficulty_tier IN ('wood','stone','iron','diamond')),
    task_set            TEXT    NOT NULL CHECK (task_set IN ('train','eval')),
    commit_hash         TEXT    NOT NULL,
    timestamp           TEXT    NOT NULL,                           -- ISO-8601 UTC
    success             INTEGER NOT NULL CHECK (success IN (0,1)),  -- deterministic check ONLY
    progress_score      REAL    CHECK (progress_score IS NULL OR (progress_score >= 0.0 AND progress_score <= 1.0)),
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    steps               INTEGER,
    retry_count         INTEGER,
    wall_clock_seconds  REAL,
    n_distinct_actions  INTEGER,
    failure_mode        TEXT    CHECK (failure_mode IS NULL OR failure_mode IN ('plan_invalid','world_state_mismatch','timeout','tool_error'))
);

-- gate_decisions: one row per human approve/reject at the improvement gate.
CREATE TABLE IF NOT EXISTS gate_decisions (
    decision_id             TEXT PRIMARY KEY,                       -- UUID
    timestamp               TEXT NOT NULL,                          -- ISO-8601 UTC
    commit_hash             TEXT NOT NULL,
    proposed_change_summary TEXT,
    proposed_diff           TEXT,                                   -- full unified diff
    decision                TEXT NOT NULL CHECK (decision IN ('approve','reject')),
    human_reason            TEXT                                    -- nullable
);

CREATE INDEX IF NOT EXISTS idx_attempts_commit   ON task_attempts (commit_hash);
CREATE INDEX IF NOT EXISTS idx_attempts_set_tier ON task_attempts (task_set, difficulty_tier);
