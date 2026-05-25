"""Cost-layer metrics from a bot.log slice (Part 5 helper).

Reading the log for COST/behavior metrics is allowed — what is forbidden is
deciding task *success* from logs (that is checks.py's job, from world state).
This module never touches success; it only counts tokens, turns, retries, and
action diversity for one task's slice of bot.log.

retry_count and n_distinct_actions are documented HEURISTICS (markers below),
intentionally easy to tune — they are early-warning signals for spec gaming
(retries rising / action variety collapsing), not ground truth.
"""
import re

# A [cost] line, e.g.:
#   [cost] kind=convo input=6299 output=14 cache_read=0 cache_creation=0 | total_turns=1 ...
# The contiguous 4-field sequence only matches the per-turn section, never the
# "total_input=" rollup after the pipe.
_COST = re.compile(
    r"input=(\d+)\s+output=(\d+)\s+cache_read=(\d+)\s+cache_creation=(\d+)"
)

# World-affecting action commands (NOT read-only queries like !inventory/!stats).
# Distinct count is the behavior-diversity signal; collapse toward 1-2 = degenerate.
ACTION_COMMANDS = {
    "collectBlocks", "craftRecipe", "smeltItem", "placeHere", "newAction",
    "goToCoords", "goToPlayer", "searchForBlock", "moveAway", "attack",
    "equip", "mineBlock", "putInChest", "takeFromChest", "discard",
    "activate", "consume", "followPlayer",
}
_ACTION = re.compile(r"!([a-zA-Z][a-zA-Z0-9]*)")

# Struggle / retry / backoff markers.
_RETRY = re.compile(
    r"PathStopped|pathStopped|stuck|Stuck|restart|Restart|429|trying again|retrying"
)


def parse_slice(text: str) -> dict:
    """Extract cost/behavior metrics from one task's bot.log slice."""
    inp = out = steps = 0
    for i, o, cr, cc in _COST.findall(text):
        inp += int(i) + int(cr) + int(cc)   # input convention matches the prototype
        out += int(o)
        steps += 1
    actions = {a for a in _ACTION.findall(text) if a in ACTION_COMMANDS}
    return {
        "input_tokens": inp,
        "output_tokens": out,
        "steps": steps,
        "retry_count": len(_RETRY.findall(text)),
        "n_distinct_actions": len(actions),
    }
