#!/usr/bin/env bash
# eval/stock_strip.sh — the stock-stripped ablated arm (preregistration, 2026-08-15).
#
# Tests whether a starting bag that already satisfies the goal CAUSES the false
# completions of results.md §8.1, rather than merely coinciding with them. The
# §8.1 matched test is causal for the harness; nothing yet is causal for the
# stock. This supplies that manipulation.
#
# It edits NOTHING. `TASKS`, `RESET_KIT`, `ARMS` and `TAG` are already
# environment variables of the frozen runner, so the collection path stays
# byte-for-byte what the confirmatory campaign ran (verified against 7ea45ee
# with comments stripped: rcon.py and eval_db.py identical, field_trial.sh and
# loop.sh differing only in `say` lines and one JS comment, benchmarks.json only
# in a `note`). If you find yourself wanting to change field_trial.sh to make
# this work, stop — that invalidates the comparison this script exists to make.
#
# The kit is stripped PER TASK, dropping only that task's target item. One
# stripped kit for all six would remove the pickaxe and the axe, so the bot
# could no longer mine or chop, and difficulty would move — the exact confound
# being removed here. Every enabler is retained, so the work required is
# identical to the confirmatory arm and the only variable is the starting stock.
#
# Usage:
#   bash eval/stock_strip.sh smoke     # 1 task, 1 replicate, TAG=smoke — inert
#   bash eval/stock_strip.sh run       # 6 tasks x 4 replicates = 24 attempts
#
# Rows land in `stockstrip_off`. campaign_report.py selects `conf_%`, so these
# are invisible to every published rate unless asked for by name. They are
# never pooled with the confirmatory campaign.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The confirmatory kit, for reference (eval/field_trial.sh):
#   96 cobblestone,16 oak_log,96 stick,48 oak_planks,8 coal,
#   1 stone_pickaxe,1 stone_axe,1 crafting_table
#
# idx : target item : kit with that item dropped
CASES=(
  "0|cobblestone|16 oak_log,96 stick,48 oak_planks,8 coal,1 stone_pickaxe,1 stone_axe,1 crafting_table"
  "1|oak_log|96 cobblestone,96 stick,48 oak_planks,8 coal,1 stone_pickaxe,1 stone_axe,1 crafting_table"
  "3|oak_planks|96 cobblestone,16 oak_log,96 stick,8 coal,1 stone_pickaxe,1 stone_axe,1 crafting_table"
  "4|stick|96 cobblestone,16 oak_log,48 oak_planks,8 coal,1 stone_pickaxe,1 stone_axe,1 crafting_table"
  "7|stone_pickaxe|96 cobblestone,16 oak_log,96 stick,48 oak_planks,8 coal,1 stone_axe,1 crafting_table"
  "11|cobblestone|16 oak_log,96 stick,48 oak_planks,8 coal,1 stone_pickaxe,1 stone_axe,1 crafting_table"
)

MODE="${1:-}"
case "$MODE" in
  # Task #4 is the emblematic case — 96 sticks in the bag against a +12 target,
  # and the attempt that started this whole line of questioning (#755).
  smoke) CASES=("4|stick|96 cobblestone,16 oak_log,48 oak_planks,8 coal,1 stone_pickaxe,1 stone_axe,1 crafting_table")
         SEEDS=1; TAG=smokestrip ;;
  run)   SEEDS=4; TAG=stockstrip ;;
  *)     sed -n '2,30p' "$0"; exit 1 ;;
esac

for case in "${CASES[@]}"; do
  IFS='|' read -r idx item kit <<< "$case"
  printf '\n\033[1;36m═══ benchmark #%s — %s stripped from the kit ═══\033[0m\n' "$idx" "$item"
  TASKS="$idx" RESET_KIT="$kit" ARMS=off SEEDS="$SEEDS" TAG="$TAG" \
    bash eval/field_trial.sh || echo "  (segment returned $? — rows still logged, continuing)"
done

printf '\n\033[1;33m■ done. inspect with:\033[0m\n'
printf '   python3 eval/stock_strip_report.py %s\n' "$TAG"
