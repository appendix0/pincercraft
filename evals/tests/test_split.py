"""Part 6 — the held-out split: eval results must NEVER appear in a train report."""
import pytest

from evals import db
from evals import task_battery as tb


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.db")
    yield c
    c.close()


def _seed(conn, commit, task_set, success):
    for t in tb.tasks_for(task_set):
        db.insert_attempt(conn, task_id=t.task_id, task_name=t.task_name,
                          difficulty_tier=t.difficulty_tier, task_set=t.task_set,
                          commit_hash=commit, success=success, progress_score=1.0,
                          input_tokens=1000, output_tokens=100, steps=5,
                          retry_count=0, wall_clock_seconds=10.0, n_distinct_actions=4)


def test_train_and_eval_sets_are_disjoint_and_complete():
    train = {t.task_id for t in tb.tasks_for("train")}
    ev = {t.task_id for t in tb.tasks_for("eval")}
    assert train.isdisjoint(ev)
    assert train | ev == {t.task_id for t in tb.TASKS}
    assert train == {"wood_01", "wood_02", "stone_01", "iron_01"}
    assert ev == {"wood_03", "stone_02", "iron_02"}


def test_eval_rows_never_leak_into_train_report(conn):
    _seed(conn, "c1", "train", success=1)
    _seed(conn, "c1", "eval", success=1)
    report = tb.generate_train_report(conn, "c1")
    for t in tb.tasks_for("eval"):
        assert t.task_id not in report
        assert t.task_name not in report
    # the train slice counts only the 4 train tasks, not all 7
    assert "4 tasks in the train set" in report


def test_eval_report_carries_do_not_paste_header_train_does_not(conn):
    _seed(conn, "c1", "train", success=1)
    _seed(conn, "c1", "eval", success=1)
    assert tb.EVAL_HEADER in tb.generate_eval_report(conn, "c1")
    assert tb.EVAL_HEADER not in tb.generate_train_report(conn, "c1")


def test_train_report_counts_only_train_attempts(conn):
    _seed(conn, "c1", "train", success=1)   # 4 attempts
    _seed(conn, "c1", "eval", success=0)    # 3 attempts, different set
    report = tb.generate_train_report(conn, "c1")
    assert "4 attempts in this slice" in report
