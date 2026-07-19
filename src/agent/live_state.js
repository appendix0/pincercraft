// Deterministic live-state block — the "state authority" rendered into the
// UNCACHED dynamic half of the system prompt, rebuilt every orchestrator turn
// (orchestrator_v2.js getSystemPrompt, inside the per-turn loop). Because it is
// recomputed from a fresh inventory snapshot each turn, it can never go stale:
// mine 3 raw_iron and next turn the CAPABILITIES gap recomputes without it.
//
// Boundary (Yoon's design): code owns the FACTS here (counts, canMine, craft
// gap) — the LLM only consumes them and owns the plan. HP stays a pure reflex
// in modes.js and is NOT driven by this block.
//
// Format follows Voyager's flat labeled observation convention (SELF / INVENTORY
// (used/36) / NEARBY near→far / capabilities), which stock Mindcraft already
// approximates via !stats+!inventory+!nearbyBlocks. The new part is CAPABILITIES.

import * as world from './library/world.js';
import * as mc from '../utils/mcdata.js';
import { parseEndFactorTarget } from './verify.js';
import { harnessOn } from './harness_mode.js';

const NEARBY_BLOCK_CAP = 10;
const NEARBY_ENTITY_CAP = 5;
const STEP_CAP = 4;

function timeLabel(bot) {
    const t = bot?.time?.timeOfDay ?? 0;
    if (t < 6000) return 'Morning';
    if (t < 12000) return 'Afternoon';
    return 'Night';
}

function selfLine(bot, agent) {
    const p = bot.entity.position;
    let action = agent?.actions?.currentActionLabel || 'Idle';
    if (agent?.isIdle?.()) action = 'Idle';
    let biome = 'unknown';
    try { biome = world.getBiomeName(bot); } catch {}
    return `SELF: Health ${Math.round(bot.health)}/20 | Hunger ${Math.round(bot.food)}/20 | `
        + `Pos x:${p.x.toFixed(0)} y:${p.y.toFixed(0)} z:${p.z.toFixed(0)} | `
        + `Biome ${biome} | Time ${timeLabel(bot)} | Action ${action}`;
}

function inventoryLines(bot, inv, agent) {
    const used = agent?.inventory_manager?.usedSlots?.() ?? Object.keys(inv).length;
    const items = Object.entries(inv).filter(([, n]) => n > 0)
        .map(([name, n]) => `${name}:${n}`);
    const body = items.length ? items.join(', ') : 'empty';
    const held = bot.heldItem?.name || 'none';
    const armorSlots = [5, 6, 7, 8].map(i => bot.inventory.slots[i]?.name).filter(Boolean);
    const armor = armorSlots.length ? armorSlots.join(', ') : 'none';
    return `INVENTORY (${used}/36 slots): ${body}\n  Equipped hand: ${held} | Armor: ${armor}`;
}

function nearbyLine(bot) {
    // Blocks near→far, deduped by name, capped — same "what's relevant nearby"
    // signal as !nearbyBlocks but compact (comma-joined, no surrounding dump).
    let blockNames = [];
    try {
        const seen = new Set();
        for (const b of world.getNearestBlocks(bot, null, 16, 400)) {
            if (seen.has(b.name)) continue;
            seen.add(b.name);
            blockNames.push(b.name);
            if (blockNames.length >= NEARBY_BLOCK_CAP) break;
        }
    } catch {}
    const blocks = blockNames.length ? blockNames.join(', ') : 'none';

    let mobs = [], drops = 0;
    try {
        const me = bot.entity.position;
        for (const e of world.getNearbyEntities(bot, 16)) {
            if (e === bot.entity) continue;
            if (e.name === 'item') { drops++; continue; }
            if (e.type === 'player') continue;
            if (mobs.length < NEARBY_ENTITY_CAP) {
                const d = e.position.distanceTo(me);
                mobs.push(`${e.name}(${d.toFixed(0)}m)`);
            }
        }
    } catch {}
    const entities = mobs.length ? mobs.join(', ') : 'none';

    let chest = 'none';
    try {
        const c = world.getNearestBlock(bot, 'chest', 32);
        if (c) chest = `(${c.position.x},${c.position.y},${c.position.z})`;
    } catch {}

    return `NEARBY: blocks(near→far): ${blocks} | entities: ${entities} | dropped items: ${drops || 'none'} | known chest: ${chest}`;
}

// One deterministic acquisition hint for a missing base item, using existing
// mcdata tables: mine it directly, or smelt its raw form (which is itself mined).
// e.g. iron_ingot → "smelt raw_iron (← mine iron_ore; canMine: NO — need stone_pickaxe)".
function acquisitionHint(im, item, inv) {
    const direct = mc.getItemBlockSources(item);
    if (direct && direct.length) {
        const block = direct[0];
        const cm = im.canMine(block, inv);
        return `${item} ← mine ${block} (canMine: ${cm.ok ? 'YES' : 'NO — ' + cm.reason})`;
    }
    const raw = mc.getItemSmeltingIngredient(item);
    if (raw) {
        const rawSrc = mc.getItemBlockSources(raw);
        if (rawSrc && rawSrc.length) {
            const block = rawSrc[0];
            const cm = im.canMine(block, inv);
            return `${item} ← smelt ${raw} (← mine ${block}; canMine: ${cm.ok ? 'YES' : 'NO — ' + cm.reason})`;
        }
        return `${item} ← smelt ${raw}`;
    }
    return null;
}

function capabilitiesBlock(agent, inv) {
    const im = agent?.inventory_manager;
    if (!im) return null;
    const tasks = agent?.task_queue?.tasks || [];
    const active = tasks.find(t => String(t.status).includes('progress'));
    if (!active) return null;

    const target = parseEndFactorTarget(active); // {item, count} or null
    if (!target) return null;

    const gap = im.craftGap(target.item, target.count, inv);
    if (!gap) return null;

    const id = active.id != null ? `#${active.id} ` : '';
    const lines = ['CAPABILITIES:'];

    if (gap.missing.length === 0) {
        lines.push(`  task ${id}${target.item} x${target.count}: have all materials — make it now`);
    } else {
        const missing = gap.missing.map(m => `${m.count} ${m.item}`).join(', ');
        lines.push(`  task ${id}${target.item} x${target.count}: MISSING ${missing}`);
        if (gap.steps.length) {
            lines.push(`    path: ${gap.steps.slice(0, STEP_CAP).join('; ')}`);
        }
        // Deterministic acquisition hint per missing base item (bounded).
        for (const m of gap.missing) {
            const hint = acquisitionHint(im, m.item, inv);
            if (hint) lines.push(`    ${hint}`);
        }
    }
    return lines.join('\n');
}

// Deterministic progress for the ACTIVE task's primary target — the count the
// LLM must not eyeball. Covers gather targets (diamonds, logs) that the
// CAPABILITIES craft-gap intentionally skips (they aren't craftable) as well as
// crafted targets: progress is just "how many of the end_factor item do I hold
// vs how many the criterion needs." Live evidence this was missing: 2026-06-06
// diamond run, the deterministic count was 2 but the LLM claimed "have 7" and
// planned off the wrong number. One authoritative line closes that drift.
export function taskProgressLine(agent, inv) {
    const tasks = agent?.task_queue?.tasks || [];
    const active = tasks.find(t => String(t.status).includes('progress'));
    if (!active) return null;
    const target = parseEndFactorTarget(active); // {item, count} or null
    if (!target) return null;
    const have = inv[target.item] || 0;
    const id = active.id != null ? `#${active.id} ` : '';
    if (have >= target.count) {
        return `TASK PROGRESS ${id}${target.item}: ${have}/${target.count} — TARGET MET. Call !finishTask now (do not gather more).`;
    }
    const need = target.count - have;
    return `TASK PROGRESS ${id}${target.item}: ${have}/${target.count} — ${need} more to go. `
        + `This count is authoritative; do NOT !finishTask until it reaches ${target.count}.`;
}

/**
 * Build the deterministic live-state block for the uncached dynamic system half.
 * Reads inventory ONCE and threads that snapshot through every capability query
 * so SELF / INVENTORY / CAPABILITIES are always mutually consistent. Never
 * throws — a render bug must not take down the orchestrator turn.
 */
export function buildLiveStateBlock(agent) {
    try {
        const bot = agent.bot;
        const inv = world.getInventoryCounts(bot); // single snapshot per turn
        // OFF arm: raw state only (SELF/INVENTORY/NEARBY — upstream parity).
        // TASK-PROGRESS and CAPABILITIES are the "don't act against the facts"
        // layer under ablation.
        const prog = harnessOn() ? taskProgressLine(agent, inv) : null;
        const parts = [
            '=== LIVE STATE (deterministic, refreshed every turn) ===',
            selfLine(bot, agent),
            // Right after SELF so it's the first thing read — the authoritative
            // count that overrides whatever number the model thinks it has.
            ...(prog ? [prog] : []),
            inventoryLines(bot, inv, agent),
            nearbyLine(bot),
        ];
        const caps = harnessOn() ? capabilitiesBlock(agent, inv) : null;
        if (caps) parts.push(caps);
        return parts.join('\n');
    } catch (e) {
        return `=== LIVE STATE ===\n(state render error: ${e?.message || e})`;
    }
}
