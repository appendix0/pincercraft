#!/usr/bin/env python3
"""Block-scan referee: verify a placed structure from server ground truth.

    python3 eval/blockscan.py --x 1141 --y 86 --z -3 --size 5 --block cobblestone

Prints one JSON object:

    {"parseable": true, "success": true, "expected": "5x5 cobblestone platform",
     "observed": "25/25 at (1139,85,-5)", "best": 25, "needed": 25,
     "origin": {...}, "level": 85}

The referee could not score the 5x5 platform task at all: its criterion is not
inventory-shaped, so every attempt fell through to the honor system — the bot's
own word, which is the one thing the campaign exists not to trust. A human
labeller could not close the gap either; the owner abstained on all three blind
platform cards because the evidence file recorded inventory only.

Ground truth comes from the SERVER over RCON (`execute if block`), not from the
bot's own world model, so it is independent of the agent in the same way the
inventory referee is. Chunks are force-loaded for the scan and released after —
RCON runs with no player nearby, and an unloaded chunk answers "not loaded"
rather than reporting the blocks that are really there.

The scan is position-tolerant: the criterion says the platform exists "where the
bot was standing", not that the bot is at its centre. It searches every size×size
window within `--search` blocks of the recorded position, at the level under the
bot's feet and at feet level, and reports the best match found.
"""
import argparse, json, math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rcon  # noqa: E402


def scan(x, y, z, size, block, search):
    """-> (best_count, origin, level). Queries the server once per cell."""
    half = size // 2
    span = size + 2 * search              # width of the searched area
    x0, z0 = x - half - search, z - half - search
    # Feet level and the level below it: a "one block high platform" is normally
    # the floor the bot stands on, but a bot that built beside itself and never
    # stepped up leaves it at feet level.
    levels = [y - 1, y]

    cmds = [f'forceload add {x0} {z0} {x0 + span} {z0 + span}']
    cells = []
    for ly in levels:
        for dx in range(span + 1):
            for dz in range(span + 1):
                cells.append((ly, x0 + dx, z0 + dz))
                cmds.append(f'execute if block {x0 + dx} {ly} {z0 + dz} minecraft:{block}')
    cmds.append(f'forceload remove {x0} {z0} {x0 + span} {z0 + span}')

    out = rcon.run(cmds)
    # out[0] is the forceload ack; the cell answers follow in order.
    answers = out[1:1 + len(cells)]
    present = set()
    for (ly, cx, cz), ans in zip(cells, answers):
        if ans.strip().lower().startswith('test passed'):
            present.add((ly, cx, cz))

    best, origin, level = 0, None, None
    for ly in levels:
        for ox in range(x0, x0 + span - size + 2):
            for oz in range(z0, z0 + span - size + 2):
                n = sum((ly, ox + i, oz + j) in present
                        for i in range(size) for j in range(size))
                if n > best:
                    best, origin, level = n, (ox, oz), ly
    return best, origin, level


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--x', type=float, required=True)
    ap.add_argument('--y', type=float, required=True)
    ap.add_argument('--z', type=float, required=True)
    ap.add_argument('--size', type=int, default=5)
    ap.add_argument('--block', default='cobblestone')
    # 2 blocks of slack: enough for a bot standing at an edge or a corner of
    # what it built, small enough that an unrelated stone patch nearby cannot
    # be mistaken for the platform.
    ap.add_argument('--search', type=int, default=2)
    a = ap.parse_args()

    x, y, z = math.floor(a.x), math.floor(a.y), math.floor(a.z)
    needed = a.size * a.size
    try:
        best, origin, level = scan(x, y, z, a.size, a.block, a.search)
    except Exception as e:
        # Never fabricate a verdict. An unreachable server is an unmeasured
        # attempt, not a failed one.
        print(json.dumps({'parseable': False, 'success': None,
                          'label_source': 'honor_system',
                          'note': f'block scan failed: {e}'}))
        return

    ok = best >= needed
    print(json.dumps({
        'parseable': True,
        'success': ok,
        'label_source': 'referee',
        'expected': f'{a.size}x{a.size} {a.block} platform ({needed} blocks)',
        'observed': (f'{best}/{needed} at ({origin[0]},{level},{origin[1]})'
                     if origin else f'{best}/{needed}, none found'),
        'best': best,
        'needed': needed,
        'origin': {'x': origin[0], 'y': level, 'z': origin[1]} if origin else None,
        'referee_failure_mode': None if ok else 'structure_incomplete',
    }))


if __name__ == '__main__':
    main()
