#!/usr/bin/env bash
# eval/gate.sh — the human authorization gate. Logs the decision AND acts on it.
#   bash eval/gate.sh approve "reason…"   → merge the pending improve branch into develop
#   bash eval/gate.sh reject  "reason…"   → delete the branch
# Reads eval/.pending_gate.json (written by loop.sh) for the branch + summary,
# then records one row in gate_decisions. A reason is required either way.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
PEND="$ROOT/eval/.pending_gate.json"
DECISION="${1:-}"; REASON="${2:-}"

case "$DECISION" in approve|reject) ;; *) echo 'usage: gate.sh approve|reject "reason"'; exit 1;; esac
[ -n "$REASON" ] || { echo "a human_reason is required"; exit 1; }
[ -f "$PEND" ]   || { echo "no pending gate — run eval/loop.sh first"; exit 1; }

BRANCH=$(node -e 'process.stdout.write(require(process.argv[1]).branch)'  "$PEND")
SUMMARY=$(node -e 'process.stdout.write(require(process.argv[1]).summary)' "$PEND")
COMMIT=$(node -e 'process.stdout.write(require(process.argv[1]).commit)'  "$PEND")

if [ "$DECISION" = approve ]; then
  git switch develop && git merge --no-ff -m "merge $BRANCH (approved: $REASON)" "$BRANCH" \
    || { echo "merge failed — resolve manually; gate NOT logged"; exit 1; }
  echo "✓ merged $BRANCH into develop — restart the bot to evaluate the new commit"
else
  git branch -D "$BRANCH" && echo "✓ deleted $BRANCH"
fi

python3 eval/eval_db.py log-gate --commit "$COMMIT" --summary "$SUMMARY" \
  --decision "$DECISION" --reason "$REASON" >/dev/null
rm -f "$PEND"
echo "✓ gate decision logged to pincercraft_evals.db"
