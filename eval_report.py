#!/usr/bin/env python3
"""eval_report.py — CLI entry point for the PincerCraft eval battery (Part 5).

Subcommands:
  baseline               Run train+eval battery 3x at the current commit (sets the baseline).
  run --set SET          Run a set once at the current commit.  SET = train|eval|both
  report --set SET        Print a report for the current commit.  SET = train|eval
         [--since COMMIT]  Baseline commit to diff against (default: earliest in DB).

The runner drives the LIVE bot over MCP (it must be running on :8765) and grades
success with the DETERMINISTIC checks (evals/checks.py) over world-state
snapshots — never from logs or an LLM. Cost metrics come from the bot.log slice.
`report` is offline (DB only) and needs no bot.
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys
import time
import urllib.request

from evals import checks, db, runlog
from evals import task_battery as tb

ROOT = pathlib.Path(__file__).resolve().parent
BOTLOG = ROOT / "bot.log"
QLOG = ROOT / "queue.log"
MCP_URL = "http://127.0.0.1:8765/mcp"
WATCH_GRACE = 30   # seconds added to a task's tier timeout for the watch deadline
POLL = 5

_INV = re.compile(r"^- ([a-z0-9_]+): (\d+)", re.M)


# ── git / files ───────────────────────────────────────────────────────────
def current_commit() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True
        ).strip()
    except Exception:
        return "unknown"


def _lines(p: pathlib.Path) -> int:
    try:
        with p.open() as f:
            return sum(1 for _ in f)
    except FileNotFoundError:
        return 0


def _slice(p: pathlib.Path, start: int, end: int) -> str:
    with p.open() as f:
        return "".join(line for i, line in enumerate(f, 1) if start < i <= end)


# ── MCP client (stdlib urllib) ───────────────────────────────────────────────
def _token() -> str:
    return json.loads((ROOT / "keys.json").read_text()).get("mcp_token", "") or ""


def _rpc(method: str, params=None):
    body = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        body["params"] = params
    req = urllib.request.Request(
        MCP_URL,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json",
                 "Authorization": f"Bearer {_token()}"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        out = json.loads(r.read())
    if "error" in out:
        raise RuntimeError(f"MCP error: {out['error']}")
    return out["result"]


def tool_call(name: str, args: dict) -> str:
    res = _rpc("tools/call", {"name": name, "arguments": args})
    return res["content"][0]["text"]


def snapshot(elapsed: float = 0.0) -> dict:
    """World-state snapshot from the bot's own !inventory (ground truth)."""
    text = tool_call("read_inventory", {})
    inv = {m.group(1): int(m.group(2)) for m in _INV.finditer(text)}
    return {"inventory": inv, "elapsed_seconds": elapsed}


def preflight():
    try:
        _rpc("ping")
    except Exception as e:
        sys.exit(f"✗ MCP not reachable on :8765 — start the bot first.  ({e})")


# ── one task ─────────────────────────────────────────────────────────────────
def run_task(task: tb.Task, commit: str, conn) -> tuple[int, float, str | None]:
    timeout_s = task.check.timeout_s
    deadline = time.time() + timeout_s + WATCH_GRACE

    qstart = _lines(QLOG)
    start_state = snapshot(0.0)
    lstart = _lines(BOTLOG)
    t0 = time.time()
    tool_call("add_task", {"description": task.description, "end_factor": task.end_factor})

    # find the new task id
    taskid = None
    while time.time() < deadline and taskid is None:
        for line in _slice(QLOG, qstart, _lines(QLOG)).splitlines():
            m = re.search(r"#(\d+)", line)
            if m:
                taskid = m.group(1)
                break
        if taskid is None:
            time.sleep(2)
    if taskid is None:
        sys.exit(f"✗ {task.task_id}: no task id appeared in queue.log")

    # wait for terminal state
    outcome = "timeout"
    while time.time() < deadline:
        q = _slice(QLOG, qstart, _lines(QLOG))
        if re.search(rf"finish #{taskid} done", q):
            outcome = "done"; break
        if re.search(rf"cancel #{taskid} ", q):
            outcome = "cancelled"; break
        time.sleep(POLL)

    elapsed = time.time() - t0
    end_state = snapshot(elapsed)
    lend = _lines(BOTLOG)

    # DETERMINISTIC grading — world state only
    success, progress, fmode = task.check(end_state, start_state)
    # cost/behavior metrics — log slice (allowed for cost, never for success)
    m = runlog.parse_slice(_slice(BOTLOG, lstart, lend))

    db.insert_attempt(
        conn, task_id=task.task_id, task_name=task.task_name,
        difficulty_tier=task.difficulty_tier, task_set=task.task_set,
        commit_hash=commit, success=success, progress_score=progress,
        failure_mode=fmode, wall_clock_seconds=round(elapsed, 1),
        input_tokens=m["input_tokens"], output_tokens=m["output_tokens"],
        steps=m["steps"], retry_count=m["retry_count"],
        n_distinct_actions=m["n_distinct_actions"],
    )
    mark = "✓" if success else "✗"
    print(f"  {mark} {task.task_id:8s} {task.task_name:30s} "
          f"prog={progress:.2f} outcome={outcome} fmode={fmode or '-'} "
          f"tok={m['input_tokens']+m['output_tokens']} steps={m['steps']} "
          f"retry={m['retry_count']} ndistinct={m['n_distinct_actions']} {elapsed:.0f}s")
    return success, progress, fmode


def run_battery(task_set: str, trials: int, commit: str, conn):
    tasks = tb.tasks_for(task_set)
    print(f"▸ running '{task_set}' battery: {len(tasks)} tasks × {trials} trial(s) @ {commit}")
    for trial in range(trials):
        if trials > 1:
            print(f"— trial {trial + 1}/{trials} —")
        for task in tasks:
            run_task(task, commit, conn)


# ── subcommands ──────────────────────────────────────────────────────────────
def cmd_baseline(args):
    preflight()
    commit = current_commit()
    conn = db.connect()
    run_battery("both", 3, commit, conn)
    print(f"\n▸ baseline set at commit {commit} (3 trials, train+eval). "
          f"Reports diff against the earliest commit in the DB by default.")


def cmd_run(args):
    preflight()
    commit = current_commit()
    conn = db.connect()
    run_battery(args.set, 1, commit, conn)


def cmd_report(args):
    commit = current_commit()
    conn = db.connect()
    if args.set == "train":
        print(tb.generate_train_report(conn, commit, args.since))
    else:
        print(tb.generate_eval_report(conn, commit, args.since))


def main():
    p = argparse.ArgumentParser(prog="eval_report.py", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("baseline", help="run train+eval 3x at current commit (sets baseline)")

    pr = sub.add_parser("run", help="run a set once at the current commit")
    pr.add_argument("--set", choices=["train", "eval", "both"], required=True)

    rep = sub.add_parser("report", help="print a report (offline, DB only)")
    rep.add_argument("--set", choices=["train", "eval"], required=True)
    rep.add_argument("--since", default=None, metavar="COMMIT",
                     help="baseline commit to diff against (default: earliest in DB)")

    args = p.parse_args()
    {"baseline": cmd_baseline, "run": cmd_run, "report": cmd_report}[args.cmd](args)


if __name__ == "__main__":
    main()
