-- evals/__init__.sql — schema/migration for pincercraft_evals.db
-- Applied idempotently by evals/db.connect() on every connection.
-- This file SHARES the DB with the live eval/ loop (eval/eval_db.py), which
-- logs free-form difficulty_tier ('explore'), task_set ('explore'/'bench') and
-- failure_mode ('cancelled'). To let both subsystems write the same table, the
-- task_attempts enum CHECKs were dropped (2026-05-26, "eval/ wins" decision) —
-- their vocab is now convention, enforced in evals/checks.py / task_battery.py,
-- not by the DB. gate_decisions.decision keeps its CHECK (both writers conform).

-- task_attempts: one row per task run.
-- `success` is set ONLY by a deterministic check (evals/checks.py) reading a
-- Mineflayer world-state snapshot — never by an LLM, never from agent logs.
CREATE TABLE IF NOT EXISTS task_attempts (
    attempt_id          TEXT PRIMARY KEY,                          -- UUID
    task_id             TEXT    NOT NULL,
    task_name           TEXT    NOT NULL,
    difficulty_tier     TEXT    NOT NULL,                           -- conv: wood/stone/iron/diamond (evals) | explore (live loop)
    task_set            TEXT    NOT NULL,                           -- conv: train/eval (evals) | explore/bench (live loop)
    commit_hash         TEXT    NOT NULL,
    timestamp           TEXT    NOT NULL,                           -- ISO-8601 UTC
    success             INTEGER NOT NULL,                           -- 0/1, deterministic check ONLY
    progress_score      REAL,                                       -- 0.0–1.0 by convention
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    steps               INTEGER,
    retry_count         INTEGER,
    wall_clock_seconds  REAL,
    n_distinct_actions  INTEGER,
    failure_mode        TEXT                                        -- conv: plan_invalid/world_state_mismatch/timeout/tool_error (evals) | cancelled (live loop)
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
