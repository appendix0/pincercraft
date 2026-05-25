#!/usr/bin/env python3
"""eval_report.py — summarize task_attempts for a commit (range) vs a baseline.

Usage:
  eval_report.py COMPARE [--baseline BASE] [--db PATH]

COMPARE / BASE may be a short or full commit hash. COMPARE may also be a
comma-list of hashes, or a git range A..B (expanded via `git rev-list`, pooled).
If --baseline is omitted, the earliest-timestamped commit in the DB is used.

Prints, for the compare group and the baseline group:
  - per-tier success rate: mean ± std (over the trials in that tier)
  - tokens_per_successful_task
  - steps_per_task
  - tokens_per_step
and the compare-minus-baseline delta for each aggregate.
"""
import argparse, os, subprocess, sys
from statistics import mean, pstdev

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from eval_db import connect, DB_PATH  # noqa: E402


def tokens(a):
    return (a["input_tokens"] or 0) + (a["output_tokens"] or 0)


def commit_matches(stored, target):
    if not stored or not target:
        return False
    return stored == target or stored.startswith(target) or target.startswith(stored)


def expand_range(spec):
    """commit | a,b,c | A..B  ->  list of target hashes."""
    if ".." in spec:
        try:
            out = subprocess.check_output(["git", "rev-list", spec], text=True, stderr=subprocess.DEVNULL)
            return [h.strip() for h in out.splitlines() if h.strip()]
        except Exception:
            sys.exit(f"could not expand git range {spec!r} (not in a repo?)")
    return [s.strip() for s in spec.split(",") if s.strip()]


def group(attempts, targets):
    return [a for a in attempts if any(commit_matches(a["commit_hash"], t) for t in targets)]


def per_tier(attempts):
    tiers = {}
    for a in attempts:
        tiers.setdefault(a["difficulty_tier"] or "?", []).append(int(a["success"] or 0))
    out = {}
    for tier, succ in sorted(tiers.items()):
        out[tier] = (mean(succ), pstdev(succ), len(succ))
    return out


def aggregates(attempts):
    succ = [a for a in attempts if a["success"]]
    tok_succ = sum(tokens(a) for a in succ)
    tot_tok = sum(tokens(a) for a in attempts)
    tot_steps = sum((a["steps"] or 0) for a in attempts)
    return {
        "tokens_per_successful_task": (tok_succ / len(succ)) if succ else None,
        "steps_per_task": (mean([a["steps"] or 0 for a in attempts])) if attempts else None,
        "tokens_per_step": (tot_tok / tot_steps) if tot_steps else None,
    }


def fnum(x, nd=0):
    if x is None:
        return "—"
    return f"{x:,.{nd}f}"


def delta(b, c):
    if b is None or c is None:
        return "—"
    d = c - b
    pct = f" ({d / b * +100:+.1f}%)" if b else ""
    return f"{d:+,.1f}{pct}"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("compare", help="commit hash | a,b,c | git range A..B")
    ap.add_argument("--baseline", help="baseline commit (default: earliest in DB)")
    ap.add_argument("--db", default=DB_PATH)
    args = ap.parse_args()

    with connect(args.db) as conn:
        attempts = [dict(r) for r in conn.execute(
            "SELECT * FROM task_attempts ORDER BY timestamp")]
    if not attempts:
        sys.exit("no task_attempts in DB yet — run the loop first.")

    base_spec = args.baseline or attempts[0]["commit_hash"]
    base = group(attempts, expand_range(base_spec))
    comp = group(attempts, expand_range(args.compare))
    if not base:
        sys.exit(f"no attempts for baseline {base_spec!r}")
    if not comp:
        sys.exit(f"no attempts for compare {args.compare!r}")

    print(f"\nPincerCraft eval report   (db: {args.db})")
    print(f"  baseline {base_spec:<14} {len(base)} attempts")
    print(f"  compare  {args.compare:<14} {len(comp)} attempts")
    print("  success = mean ± std over the trials recorded per tier\n")

    bt, ct = per_tier(base), per_tier(comp)
    print("per-tier success rate")
    print(f"  {'tier':<10} {'baseline':<22} {'compare':<22} {'Δ mean':>8}")
    for tier in sorted(set(bt) | set(ct)):
        bm, bs, bn = bt.get(tier, (None, None, 0))
        cm, cs, cn = ct.get(tier, (None, None, 0))
        bcol = f"{bm:.2f} ± {bs:.2f} (n={bn})" if bn else "—"
        ccol = f"{cm:.2f} ± {cs:.2f} (n={cn})" if cn else "—"
        dcol = f"{cm - bm:+.2f}" if (bn and cn) else "—"
        print(f"  {tier:<10} {bcol:<22} {ccol:<22} {dcol:>8}")

    ba, ca = aggregates(base), aggregates(comp)
    print("\naggregate (compare vs baseline)")
    rows = [
        ("tokens_per_successful_task", 0),
        ("steps_per_task", 1),
        ("tokens_per_step", 1),
    ]
    print(f"  {'metric':<28} {'baseline':>12} {'compare':>12}   {'delta':<18}")
    for key, nd in rows:
        print(f"  {key:<28} {fnum(ba[key], nd):>12} {fnum(ca[key], nd):>12}   {delta(ba[key], ca[key]):<18}")
    print()


if __name__ == "__main__":
    main()
