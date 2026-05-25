"""Part 6 — DB inserts/queries and CHECK-constraint enforcement (temp DB)."""
import sqlite3

import pytest

from evals import db


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.db")
    yield c
    c.close()


def _attempt(conn, **over):
    kw = dict(task_id="wood_01", task_name="wood_01_chop_oak",
              difficulty_tier="wood", task_set="train", commit_hash="abc",
              success=1)
    kw.update(over)
    return db.insert_attempt(conn, **kw)


def test_connect_creates_both_tables(conn):
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"task_attempts", "gate_decisions"} <= names


def test_insert_attempt_roundtrip_and_uuid(conn):
    aid = _attempt(conn, progress_score=1.0, input_tokens=100, output_tokens=10,
                   steps=4, retry_count=0, wall_clock_seconds=12.0, n_distinct_actions=3)
    assert len(aid) == 36
    row = conn.execute("SELECT * FROM task_attempts WHERE attempt_id=?", (aid,)).fetchone()
    assert row["task_set"] == "train" and row["success"] == 1 and row["n_distinct_actions"] == 3


def test_insert_gate_roundtrip(conn):
    gid = db.insert_gate(conn, commit_hash="abc", decision="approve",
                         proposed_change_summary="x", proposed_diff="--- a\n+++ b",
                         human_reason="lgtm")
    assert len(gid) == 36
    row = conn.execute("SELECT * FROM gate_decisions WHERE decision_id=?", (gid,)).fetchone()
    assert row["decision"] == "approve" and row["proposed_diff"].startswith("---")


@pytest.mark.parametrize("over", [
    {"difficulty_tier": "copper"},
    {"task_set": "holdout"},
    {"success": 2},
    {"progress_score": 1.5},
    {"failure_mode": "bogus"},
])
def test_attempt_check_constraints_reject_bad_enums(conn, over):
    with pytest.raises(sqlite3.IntegrityError):
        _attempt(conn, **over)


def test_gate_decision_constraint_rejects_bad_enum(conn):
    with pytest.raises(sqlite3.IntegrityError):
        db.insert_gate(conn, commit_hash="abc", decision="maybe")


def test_valid_failure_mode_and_null_allowed(conn):
    _attempt(conn, success=0, failure_mode="timeout")
    _attempt(conn, success=1, failure_mode=None)
    assert conn.execute("SELECT count(*) FROM task_attempts").fetchone()[0] == 2
