"""Part 6 — deterministic check semantics over mocked Mineflayer state."""
from evals import checks


def snap(inv, elapsed=0.0):
    return {"inventory": inv, "elapsed_seconds": elapsed}


def test_clean_success_returns_full_progress():
    s, p, f = checks.wood_01_chop_oak(snap({"oak_log": 3}), snap({}))
    assert (s, p, f) == (1, 1.0, None)


def test_overshoot_still_success_and_capped_progress():
    s, p, f = checks.stone_01_mine_cobblestone(snap({"cobblestone": 20}), snap({}))
    assert s == 1 and p == 1.0 and f is None


def test_leftovers_do_not_count_gaming_resistance():
    # started with 6, ended 6 -> gained 0 -> not success even though absolute >= 3
    s, p, f = checks.wood_01_chop_oak(snap({"oak_log": 6}), snap({"oak_log": 6}))
    assert s == 0 and p == 0.0 and f == "world_state_mismatch"


def test_partial_progress_within_budget_is_world_state_mismatch():
    s, p, f = checks.wood_01_chop_oak(snap({"oak_log": 2}, 50), snap({}))
    assert s == 0 and abs(p - 2 / 3) < 1e-9 and f == "world_state_mismatch"


def test_timeout_when_elapsed_exceeds_tier_budget():
    # wood tier budget is 300s; elapsed 301 with goal unmet -> timeout
    s, p, f = checks.wood_01_chop_oak(snap({"oak_log": 2}, 301), snap({}))
    assert s == 0 and f == "timeout"


def test_negative_gain_clamps_progress_to_zero():
    s, p, f = checks.wood_01_chop_oak(snap({"oak_log": 0}, 10), snap({"oak_log": 2}))
    assert s == 0 and p == 0.0


def test_delta_uses_start_state():
    # gained exactly threshold from a non-empty start
    s, p, f = checks.stone_01_mine_cobblestone(
        snap({"cobblestone": 40}), snap({"cobblestone": 32}))
    assert s == 1  # 40-32 = 8 >= 8


def test_all_seven_checks_registered_with_metadata():
    assert len(checks.CHECKS) == 7
    for name, fn in checks.CHECKS.items():
        assert isinstance(fn.item, str) and fn.threshold >= 1 and fn.timeout_s in (300, 600, 1200)


def test_tier_timeouts_match_spec():
    assert checks.wood_02_craft_planks.timeout_s == 300
    assert checks.stone_02_craft_stone_pickaxe.timeout_s == 600
    assert checks.iron_01_smelt_iron.timeout_s == 1200


def test_check_is_deterministic():
    a = checks.iron_01_smelt_iron(snap({"iron_ingot": 3}), snap({}))
    b = checks.iron_01_smelt_iron(snap({"iron_ingot": 3}), snap({}))
    assert a == b
