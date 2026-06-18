# Minecraft World Knowledge — Daedelus404

Static facts you should always have. Don't waste turns rediscovering these by trial-and-error. Hot-edit this file to teach the bot something new.

## Crafting prerequisites

- **Crafting table required** for: pickaxes, axes, swords, shovels, hoes, bread, cake, cookies, bows, fishing_rod, shears, shield, bucket, compass, clock, beds, doors, trapdoors, fences, gates, signs, banners, armor (helmet/chestplate/leggings/boots), furnaces.
- **Crafting table NOT required** (2x2 inventory grid is enough) for: planks (from logs), sticks, torches, ladders, crafting_table itself.
- **ANY log → planks, ANY planks → sticks — you are NOT limited to oak.** If oak_log is missing, every other log type (spruce, birch, jungle, acacia, dark_oak, cherry, mangrove) crafts into planks (4 planks per log), and every plank type — even mixed types together — crafts into sticks (2 sticks per 2 planks). Never stall or refuse a planks/sticks/wood-tool task just because oak specifically isn't on hand: use whatever logs or planks you have, or gather the nearest log of any type.
- Before `!craftRecipe(item)` for anything table-required: bot must be within ~4 blocks of a `crafting_table`, OR have one in inventory to place. Otherwise the skill silently fails — your inventory won't change and `!craftRecipe` returns empty output.
- **Smelting** (iron_ingot, gold_ingot, cooked beef/mutton/chicken/porkchop, glass, smooth_stone) needs a `furnace` within ~4 blocks AND fuel. **Fuel the furnace with coal** (1 coal smelts 8 items) — if you have coal in your inventory, put it in the furnace before/while smelting; don't stall. Charcoal, planks, or sticks also work if you have no coal. Same silent-fail mode as crafting tables.

## Tool tiers (pickaxes)

| To mine | Need pickaxe ≥ |
|---|---|
| stone, coal_ore, copper_ore, andesite, diorite, granite | wooden |
| iron_ore, lapis_ore, redstone_ore | stone |
| diamond_ore, gold_ore (overworld), emerald_ore | iron |
| obsidian, ancient_debris, netherite_block | diamond |

Mining without the right tier wastes time and drops nothing. Always check `$INVENTORY` first.

## Block family aliases — `!searchForBlock` recovery

If `!searchForBlock` returns "Could not find any X", try a sibling before relocating:

- **Logs**: oak_log, spruce_log, birch_log, cherry_log, jungle_log, dark_oak_log, mangrove_log, acacia_log.
- **Planks**: same family as logs (oak_planks, spruce_planks, …).
- **Leaves**: same family (oak_leaves, etc.).
- **Wool**: white_wool, black_wool, red_wool, blue_wool, green_wool, yellow_wool, … (16 colors).
- **Concrete / terracotta / glazed_terracotta**: same 16-color pattern.
- **Coral**: tube/brain/bubble/fire/horn (each has dead_ variants).
- **Cobblestone family**: cobblestone, mossy_cobblestone, cobbled_deepslate.
- **Stone family**: stone, andesite, diorite, granite, deepslate, tuff — any of these + a pickaxe gives you "stone material" for tools.

## Y-level hints for ores (Java 1.18+)

- coal: y -8 to 192, peak around 96
- iron: y -64 to 320, peak around 16 (also y 232)
- copper: y -16 to 112, peak around 48 (more in dripstone caves)
- gold: y -64 to 32, peak around -16 (badlands biome: also up to y 256)
- redstone: y -64 to 16, peak around -58
- lapis: y -64 to 64, peak around 0
- diamond: y -64 to 16, peak around -58 (more common the lower you go)
- emerald: y -16 to 320, **mountain biomes only**, peak around 224
- ancient_debris (Nether): y 8 to 22, peak around 15

## Entities ≠ blocks

- **Dropped items** are entities, not blocks. `!searchForBlock("item", N)` always fails. Use `!pickupItems` (walks around and collects nearby dropped items) or `!goToCoordinates(x,y,z)` to where you died/dropped. `$STATS` shows a "Nearby dropped items" count each turn.
- Mobs are entities. `!searchForEntity("zombie", N)` works; `!searchForBlock` doesn't.
- Players are entities. Same rule.

## Common dimension hazards

- **Nether**: fire/lava everywhere. Always carry water bucket OFF (would evaporate) — use blocks to bridge gaps. Ghast fireballs deflect with a sword swing. Don't sleep — bed explodes.
- **Portals**: to change dimension, use `!usePortal` — it walks INTO the lit (purple) portal block and waits for the teleport. Don't just `!searchForBlock`/`goToPosition` near it (that stops short and never triggers the portal). Needs an active portal; an unlit obsidian frame won't work. Portals you pass through are saved as `portal_<dimension>` (e.g. `portal_overworld`) — `!goToRememberedPlace("portal_overworld")` to return.
- **End**: void below the main island. Don't walk off edges. Endermen everywhere — wear pumpkin head or avoid looking at them.

## Bot-specific gotchas

- To **find/get/mine a specific block** ("find more debris", "get me 5 iron"), use `!findAndMine(type, num)` — it goes TO the nearest match (even buried ore within render distance, tunnelling to reach it) and mines it, collecting the drop. Don't just `!searchForBlock` (that only walks you next to it and does NOT mine). If `!findAndMine` finds nothing, the ore is out of render range — move/explore toward the right Y-level (see table above) and retry.
- `!collectBlocks` only scans a tiny radius (~5 blocks) — good when the block is already right next to you; for anything distant or buried use `!findAndMine`.
- For **open-ended "keep mining / get more / another one"** requests, use `!gather(type)` — it mines every findable one in range without the player re-asking, and stops on its own when none remain, when full, or when told to stop. Use `!findAndMine(type, num)` only when the player names a specific amount.
- `!givePlayer` reports honestly: it counts as delivered ONLY when the item actually leaves your inventory for the player. If its result says the items bounced back or were not received, the player did NOT get them — move closer and retry. Never tell the player you gave them something your inventory still shows you holding.
- `!consume` requires the food in inventory and hunger < 20. If hunger is full, !consume is a no-op.
- After every `!craftRecipe` or `!smelt`, check `!inventory` to confirm the output appeared — both skills can fail silently if prerequisites missed.
- Crafting table placement: drop the table from inventory with `!placeHere("crafting_table")` if no table is in range and you have one.
