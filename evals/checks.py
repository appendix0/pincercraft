"""Deterministic task checks — the ground-truth grader for the eval battery.

HARD CONSTRAINTS (do not relax):
  * A check NEVER calls an LLM.
  * A check NEVER reads the agent's logs or self-reports.
  * A check is a pure function of two world-state snapshots — same snapshots in,
    same verdict out.

Snapshot contract (built by the Part-5 runner from the bot's own !inventory /
!stats commands — i.e. real Mineflayer world state, not the agent's narration):

    {
      "inventory": { <mineflayer registry name>: <int count>, ... },
      "elapsed_seconds": <float wall-clock since this task started>,
      # reserved for future block/location checks (unused by the 7 starters):
      # "position": {"x":.., "y":.., "z":..}, "dimension": "overworld",
    }

`inventory` keys MUST be Mineflayer registry names (item.name, e.g. "oak_log",
not "Oak Log"); the runner is responsible for that normalization.

Check signature:
    check(state, task_start_state) -> (success: int{0,1}, progress: float[0,1], failure_mode: str|None)

Success is measured as DELTA gained since task start (see ADR in db: the bot's
server-side inventory persists across runs, so absolute counts are gameable).

failure_mode returned by a check is one of:
  * None                  — task succeeded.
  * "timeout"             — goal not reached and elapsed >= the tier timeout.
  * "world_state_mismatch"— goal not reached but still within the time budget
                            (the run ended — finished/cancelled — without the
                            world showing the goal achieved).
The other enum tags ("plan_invalid", "tool_error") are process failures not
visible in world state; the runner may assign those from cost-layer log signals.
"""

# Per-tier time budgets (seconds). A run exceeding its budget without reaching
# the goal is graded a timeout.
TIMEOUT_WOOD = 300
TIMEOUT_STONE = 600
TIMEOUT_IRON = 1200


def _count(snapshot, item):
    return (snapshot or {}).get("inventory", {}).get(item, 0)


def _inventory_delta_check(item, threshold, timeout_s):
    """Build a check: success iff (end-count - start-count) of `item` >= threshold."""

    def check(state, task_start_state):
        gained = _count(state, item) - _count(task_start_state, item)
        progress = max(0.0, min(1.0, gained / threshold))
        if gained >= threshold:
            return (1, 1.0, None)
        elapsed = (state or {}).get("elapsed_seconds", 0.0)
        if elapsed >= timeout_s:
            return (0, progress, "timeout")
        return (0, progress, "world_state_mismatch")

    # metadata for the task battery / reports
    check.item = item
    check.threshold = threshold
    check.timeout_s = timeout_s
    return check


# ── 7 starter checks (all inventory-count based) ────────────────────────────
wood_01_chop_oak = _inventory_delta_check("oak_log", 3, TIMEOUT_WOOD)
wood_02_craft_planks = _inventory_delta_check("oak_planks", 4, TIMEOUT_WOOD)
wood_03_craft_crafting_table = _inventory_delta_check("crafting_table", 1, TIMEOUT_WOOD)
stone_01_mine_cobblestone = _inventory_delta_check("cobblestone", 8, TIMEOUT_STONE)
stone_02_craft_stone_pickaxe = _inventory_delta_check("stone_pickaxe", 1, TIMEOUT_STONE)
iron_01_smelt_iron = _inventory_delta_check("iron_ingot", 3, TIMEOUT_IRON)
iron_02_craft_iron_pickaxe = _inventory_delta_check("iron_pickaxe", 1, TIMEOUT_IRON)

# task_name -> check fn. The task battery (Part 3) maps task_id/task_set/tier;
# this dict is the single source of truth for "how is this task graded".
CHECKS = {
    "wood_01_chop_oak": wood_01_chop_oak,
    "wood_02_craft_planks": wood_02_craft_planks,
    "wood_03_craft_crafting_table": wood_03_craft_crafting_table,
    "stone_01_mine_cobblestone": stone_01_mine_cobblestone,
    "stone_02_craft_stone_pickaxe": stone_02_craft_stone_pickaxe,
    "iron_01_smelt_iron": iron_01_smelt_iron,
    "iron_02_craft_iron_pickaxe": iron_02_craft_iron_pickaxe,
}
