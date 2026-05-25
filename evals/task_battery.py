"""Task battery + reports for the eval harness (Parts 3 & 4).

Part 3 — the task registry with a held-out train/eval split, and the two report
generators. The improvement loop is ONLY ever shown the TRAIN report; the EVAL
report is for the human and carries a do-not-paste header. The split is enforced
by SQL filtering (task_set = ?), so eval rows can never leak into a train report.

Part 4 — the train report's adversarial cost/behavior metrics, each compared to
a baseline commit (default: the earliest commit recorded in the DB). Metrics that
indicate specification gaming when they move the wrong way are flagged:
retry_count / wall_clock when RISING, n_distinct_actions when COLLAPSING toward 1-2.
"""
import statistics
from dataclasses import dataclass

from . import checks

EVAL_HEADER = "HUMAN REVIEW ONLY — DO NOT PASTE INTO IMPROVEMENT-LOOP CONTEXT."


@dataclass(frozen=True)
class Task:
    task_id: str
    task_name: str        # key into checks.CHECKS — the deterministic grader
    difficulty_tier: str  # wood | stone | iron | diamond
    task_set: str         # train | eval
    description: str      # natural-language prompt injected via MCP add_task
    end_factor: str       # observable end condition handed to the bot

    @property
    def check(self):
        return checks.CHECKS[self.task_name]


# ── the battery ─────────────────────────────────────────────────────────────
# train: wood_01, wood_02, stone_01, iron_01   eval (held out): wood_03, stone_02, iron_02
TASKS = [
    Task("wood_01", "wood_01_chop_oak", "wood", "train",
         "Chop oak trees until you have at least 3 oak logs.",
         "at least 3 oak_log in inventory"),
    Task("wood_02", "wood_02_craft_planks", "wood", "train",
         "Craft oak planks from logs until you have at least 4 oak planks.",
         "at least 4 oak_planks in inventory"),
    Task("stone_01", "stone_01_mine_cobblestone", "stone", "train",
         "Mine stone with a pickaxe until you have at least 8 cobblestone.",
         "at least 8 cobblestone in inventory"),
    Task("iron_01", "iron_01_smelt_iron", "iron", "train",
         "Smelt iron ore in a furnace until you have at least 3 iron ingots.",
         "at least 3 iron_ingot in inventory"),
    Task("wood_03", "wood_03_craft_crafting_table", "wood", "eval",
         "Craft a crafting table.",
         "at least 1 crafting_table in inventory"),
    Task("stone_02", "stone_02_craft_stone_pickaxe", "stone", "eval",
         "Craft a stone pickaxe.",
         "at least 1 stone_pickaxe in inventory"),
    Task("iron_02", "iron_02_craft_iron_pickaxe", "iron", "eval",
         "Craft an iron pickaxe.",
         "at least 1 iron_pickaxe in inventory"),
]

BY_ID = {t.task_id: t for t in TASKS}


def tasks_for(task_set: str) -> list[Task]:
    """All tasks in a set. Raises on an unknown set name."""
    if task_set not in ("train", "eval", "both"):
        raise ValueError(f"unknown task_set: {task_set!r}")
    if task_set == "both":
        return list(TASKS)
    return [t for t in TASKS if t.task_set == task_set]


# ── metric helpers (Part 4) ──────────────────────────────────────────────────
def _baseline_commit(conn) -> str | None:
    row = conn.execute(
        "SELECT commit_hash FROM task_attempts ORDER BY timestamp ASC LIMIT 1"
    ).fetchone()
    return row[0] if row else None


def _attempts(conn, commit_hash, task_set):
    return [dict(r) for r in conn.execute(
        "SELECT * FROM task_attempts WHERE commit_hash = ? AND task_set = ?",
        (commit_hash, task_set),
    )]


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return statistics.fmean(xs) if xs else None


def _std(xs):
    xs = [x for x in xs if x is not None]
    return statistics.pstdev(xs) if len(xs) >= 2 else 0.0


def _agg(rows):
    """Aggregate one (commit, set) slice into the Part-4 metric set."""
    succ = [r for r in rows if r["success"] == 1]
    tok = lambda r: (r.get("input_tokens") or 0) + (r.get("output_tokens") or 0)
    total_tok = sum(tok(r) for r in rows)
    total_steps = sum((r.get("steps") or 0) for r in rows)
    return {
        "n": len(rows),
        "tokens_per_successful_task": (sum(tok(r) for r in succ) / len(succ)) if succ else None,
        "steps_per_task": _mean([r.get("steps") for r in rows]),
        "tokens_per_step": (total_tok / total_steps) if total_steps else None,
        "retry_count_per_attempt": _mean([r.get("retry_count") for r in rows]),
        "wall_clock_per_attempt": _mean([r.get("wall_clock_seconds") for r in rows]),
        "n_distinct_actions_per_attempt": _mean([r.get("n_distinct_actions") for r in rows]),
    }


def _fmt(x):
    if x is None:
        return "—"
    return f"{x:.2f}" if isinstance(x, float) else str(x)


def _delta(cur, base):
    if cur is None or base is None:
        return "—"
    d = cur - base
    arrow = "▲" if d > 0 else ("▼" if d < 0 else "→")
    return f"{arrow}{abs(d):.2f}"


def _report(conn, commit_hash, task_set, baseline_commit=None, *, for_llm):
    base = baseline_commit or _baseline_commit(conn)
    rows = _attempts(conn, commit_hash, task_set)
    base_rows = _attempts(conn, base, task_set) if base else []
    cur, b = _agg(rows), _agg(base_rows)

    lines = []
    if not for_llm:
        lines += [f"> **{EVAL_HEADER}**", ""]
    lines += [
        f"# {task_set.upper()} report — commit `{commit_hash}`  (baseline `{base or 'n/a'}`)",
        "",
        f"_{cur['n']} attempts in this slice; {len(tasks_for(task_set))} tasks in the {task_set} set._",
        "",
        "## Success rate by tier (mean ± std)",
        "",
        "| tier | trials | success mean ± std | Δ vs baseline |",
        "| --- | --- | --- | --- |",
    ]
    tiers = sorted({t.difficulty_tier for t in tasks_for(task_set)})
    for tier in tiers:
        s = [r["success"] for r in rows if r["difficulty_tier"] == tier]
        bs = [r["success"] for r in base_rows if r["difficulty_tier"] == tier]
        m, sd = _mean(s), _std(s)
        bm = _mean(bs)
        cell = f"{m:.2f} ± {sd:.2f}" if m is not None else "—"
        lines.append(f"| {tier} | {len(s)} | {cell} | {_delta(m, bm)} |")

    lines += [
        "",
        "## Cost & behavior (current vs baseline)",
        "",
        "| metric | current | baseline | Δ | flag |",
        "| --- | --- | --- | --- | --- |",
    ]
    # (metric_key, higher_is_worse, collapse_check)
    rising_bad = {"retry_count_per_attempt", "wall_clock_per_attempt"}
    for key in ("tokens_per_successful_task", "steps_per_task", "tokens_per_step",
                "retry_count_per_attempt", "wall_clock_per_attempt",
                "n_distinct_actions_per_attempt"):
        c, bv = cur[key], b[key]
        flag = ""
        if c is not None and bv is not None:
            if key in rising_bad and c > bv:
                flag = "⚠ rising"
            if key == "n_distinct_actions_per_attempt" and c < bv:
                flag = "⚠ collapsing" + (" → degenerate" if c <= 2 else "")
        lines.append(f"| {key} | {_fmt(c)} | {_fmt(bv)} | {_delta(c, bv)} | {flag} |")

    return "\n".join(lines) + "\n"


# ── public report generators (Part 3) ────────────────────────────────────────
def generate_train_report(conn, commit_hash, baseline_commit=None) -> str:
    """Train-set metrics — the ONLY report the improvement loop may see."""
    return _report(conn, commit_hash, "train", baseline_commit, for_llm=True)


def generate_eval_report(conn, commit_hash, baseline_commit=None) -> str:
    """Held-out eval-set metrics — human only; carries the do-not-paste header."""
    return _report(conn, commit_hash, "eval", baseline_commit, for_llm=False)
