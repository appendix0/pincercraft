// Phase H1: slash-command dispatcher. Maps player /commands to small skill
// functions that build the right !addTask + !newAction chain — same shape as
// Claude Code's /init, /review, /explore, etc. Each skill is a tiny JS
// function that knows the right task decomposition.
//
// Bedrock note: vanilla Minecraft reserves the / prefix for built-in
// commands, so Bedrock players can use !! (double-bang) as an alias.
// Both /init and !!init dispatch to the same skill. Per blueprint §8
// (Bedrock chat ergonomics open question).
//
// H2-H6 register the actual player-facing skills (init/review/explore/sleep/
// restock). H7-H9 register meta-skills the bot self-invokes (stuck/loop/
// verify). This module owns only the registry + dispatcher; skill bodies
// live alongside their registrations.

import settings from './settings.js';
import { executeCommand } from './commands/index.js';
import { layerOn } from './harness_mode.js';

const skills = new Map();

export function registerSlashSkill(name, def) {
    if (!name || typeof name !== 'string') throw new Error('slash-skill name required');
    if (!def || typeof def.run !== 'function') throw new Error(`slash-skill /${name} needs a run(agent, args, ctx) function`);
    skills.set(name.toLowerCase(), {
        name: name.toLowerCase(),
        description: def.description || '',
        run: def.run,
        // Meta-skills are self-invokable by the bot via !invokeSkill — they
        // skip the player-authorization check. Default: player-only.
        meta: !!def.meta,
    });
}

export function getSlashSkill(name) {
    return skills.get(String(name || '').toLowerCase());
}

export function listSlashSkills() {
    return Array.from(skills.values()).map(s => ({ name: s.name, description: s.description, meta: s.meta }));
}

// `/init`, `/init arg1 arg2`, `!!init arg1` all match.
const SLASH_RE = /^\s*(?:\/|!!)([a-z][a-z0-9_-]*)(?:\s+(.*))?$/i;

export function parseSlashCommand(message) {
    if (!message) return null;
    const m = String(message).match(SLASH_RE);
    if (!m) return null;
    return { name: m[1].toLowerCase(), args: (m[2] || '').trim() };
}

function normalizeName(n) {
    return String(n || '').replace(/^\./, '').toLowerCase();
}

function isAuthorized(source) {
    if (!source) return false;
    const trusted = settings.only_chat_with;
    if (Array.isArray(trusted) && trusted.length > 0) {
        const norm = normalizeName(source);
        return trusted.some(p => normalizeName(p) === norm);
    }
    return true; // open-server fallback
}

// Dispatcher called by agent.js _processInput before the LLM turn. Returns:
//   undefined → not a slash command, fall through to normal handling
//   string    → reply text to route back to the player
//   null      → skill ran silently (no chat reply)
export async function dispatchSlashCommand(agent, source, message) {
    const parsed = parseSlashCommand(message);
    if (!parsed) return undefined;
    if (!isAuthorized(source)) {
        return `Slash commands are restricted. Ask the owner to add you to only_chat_with.`;
    }
    const skill = skills.get(parsed.name);
    if (!skill) {
        const names = Array.from(skills.values())
            .filter(s => !s.meta)
            .map(s => '/' + s.name)
            .sort();
        return `Unknown slash skill /${parsed.name}. Available: ${names.join(', ') || '(none registered)'}.`;
    }
    try {
        const out = await skill.run(agent, parsed.args, { source });
        return out ?? null;
    } catch (e) {
        console.warn(`slash-skill /${parsed.name} threw:`, e?.message || e);
        return `/${parsed.name} failed: ${e?.message || e}`;
    }
}

// Bot-side invocation. Phase E/H7's `stuck` meta-skill (and H8/H9's loop/verify)
// call this directly via the !invokeSkill command — same registry, no player
// auth, returns the skill's result string so the orchestrator can feed it back
// to the LLM as a system message.
export async function invokeMetaSkill(agent, name, args = '') {
    const skill = skills.get(String(name || '').toLowerCase());
    if (!skill) return `Unknown skill: ${name}.`;
    if (!skill.meta) return `Skill /${name} is player-only — the bot cannot self-invoke it.`;
    try {
        const out = await skill.run(agent, args, { source: 'bot:self' });
        return out ?? `(${name} ran silently)`;
    } catch (e) {
        console.warn(`meta-skill ${name} threw:`, e?.message || e);
        return `Skill ${name} failed: ${e?.message || e}`;
    }
}

// Helper for skill implementations: queue + start a single task via the
// existing !addTask + !startTask plumbing. Centralizes the format so each
// skill doesn't reinvent the chain.
export async function queueTask(agent, description, end_factor, { autostart = false } = {}) {
    if (!agent.task_queue) return { ok: false, message: 'No task_queue available' };
    const add = agent.task_queue.addTask(description, end_factor);
    if (autostart && add?.ok !== false && agent.planMode !== true) {
        agent.task_queue.startTask(null);
    }
    return add;
}

// Helper: execute a bare !command string through the normal executeCommand
// path so the plan-mode + permission gates still apply.
export async function runCommand(agent, commandText) {
    return await executeCommand(agent, commandText);
}

// ----------------------------------------------------------------------------
// Phase H2–H6: player-facing slash skills. Each one decomposes a single
// player intent into the !addTask + !newAction chain the orchestrator wants.
// Skills exit plan mode if it's on — typing /init is an unambiguous request,
// not the kind of ambiguous chat where the plan-mode confirmation is useful.
// ----------------------------------------------------------------------------

function _xyz(pos) {
    return `${pos.x.toFixed(0)}/${pos.y.toFixed(0)}/${pos.z.toFixed(0)}`;
}

// /init — survey spawn area, save coords and biome/landmarks to memory.
registerSlashSkill('init', {
    description: 'Survey the current area: save spawn coords, capture biome and key landmarks to memory.',
    async run(agent, args, ctx) {
        if (!agent.bot) return 'I\'m not in-world yet — try again in a few seconds.';
        if (agent.planMode) agent.exitPlanMode();
        const pos = agent.bot.entity.position;
        try {
            agent.memory_bank?.rememberPlace?.('init_spawn', pos.x, pos.y, pos.z);
        } catch (e) {
            console.warn('/init rememberPlace failed:', e?.message || e);
        }
        agent.task_queue.addTask(
            `Survey the area for /init invoked from (${_xyz(pos)}). !newAction("Use !stats and !nearbyBlocks to describe: current biome, time of day, nearby water/lava, nearest tree species, highest block above. Then chat a 3-line summary to the player and call !remember(\\"spawn-survey\\", \\"<the summary>\\") so it persists.").`,
            'spawn-survey memory written and 3-line summary chatted'
        );
        try { agent.task_queue.startTask(null); } catch {}
        return `/init queued from (${_xyz(pos)}). I'll save the spawn point and survey the area.`;
    },
});

// /review — quick health/inventory/queue snapshot, no movement.
registerSlashSkill('review', {
    description: 'Snapshot: position, time, HP/hunger, top inventory items, and the current task queue.',
    async run(agent, args, ctx) {
        if (!agent.bot) return 'I\'m not in-world yet.';
        const bot = agent.bot;
        const pos = bot.entity?.position;
        const time = bot.time?.timeOfDay ?? 0;
        const timeStr = time < 6000 ? 'morning' : time < 12000 ? 'afternoon' : 'night';
        const health = Number.isFinite(bot.health) ? Math.round(bot.health) : '?';
        const hunger = Number.isFinite(bot.food) ? Math.round(bot.food) : '?';
        const inv = bot.inventory?.items?.() || [];
        const top = [...inv].sort((a, b) => b.count - a.count).slice(0, 5);
        const invStr = top.length ? top.map(i => `${i.count}x ${i.name}`).join(', ') : 'empty';
        const queueText = agent.task_queue
            ? agent.task_queue.formatForChat({ planMode: agent.planMode === true })
            : '(no queue)';
        return `/review · ${pos ? _xyz(pos) : '?'}, ${timeStr}, HP ${health}/20, hunger ${hunger}/20 · inv: ${invStr} · ${queueText}`;
    },
});

// /explore <radius> — structured exploration, notes saved to memory.
registerSlashSkill('explore', {
    description: 'Explore a radius around the current position. Notes from each cardinal direction are saved to memory. Default radius 32.',
    async run(agent, args, ctx) {
        if (!agent.bot) return 'I\'m not in-world yet.';
        const m = String(args || '').match(/(\d+)/);
        let radius = m ? Number(m[1]) : 32;
        radius = Math.max(8, Math.min(128, radius));
        if (agent.planMode) agent.exitPlanMode();
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
        const topic = `explore-${ts}`;
        agent.task_queue.addTask(
            `Explore radius ${radius} around current position. !newAction("walk ${radius} blocks north then return, repeat for east/south/west, at each turnaround note via !nearbyBlocks: biome, notable ores/structures/hazards. After all four directions, call !remember(\\"${topic}\\", \\"<concise summary with one line per direction including notable findings>\\"). End by chatting the summary to the player.").`,
            `${topic} memory written with notes from all four directions`
        );
        try { agent.task_queue.startTask(null); } catch {}
        return `/explore: scanning ${radius}-block radius in 4 directions, saving notes to memory (${topic}).`;
    },
});

// /sleep — auto-bed when night falls.
registerSlashSkill('sleep', {
    description: 'Find the nearest bed and sleep through the night.',
    async run(agent, args, ctx) {
        if (!agent.bot) return 'I\'m not in-world yet.';
        const time = agent.bot.time?.timeOfDay ?? 0;
        // Beds only work at night (timeOfDay >= 12541) or during thunderstorms.
        const canSleep = time >= 12000 || agent.bot.thunderState > 0;
        if (!canSleep) {
            return `/sleep: it's still daytime (timeOfDay ${time}, beds need ≥12000). Try again at night.`;
        }
        if (agent.planMode) agent.exitPlanMode();
        agent.task_queue.addTask(
            'Go to your assigned bed and sleep. !goToBed and stay until day breaks. If no bed is assigned, ask the owner to assign one.',
            'bot slept through the night (timeOfDay back to morning)'
        );
        try { agent.task_queue.startTask(null); } catch {}
        return `/sleep: heading to bed.`;
    },
});

// ----------------------------------------------------------------------------
// Phase E + H7: 'stuck' meta-skill. Self-invokable by the bot via
// !invokeSkill("stuck") or auto-invoked by the orchestrator when the
// path-failure tripwire fires. Replaces the old PATH_FAILURE_NUDGE pattern
// with a stateful two-step escalation:
//   1st trip on the same task: nudge the LLM to use !newAction with a
//     concrete obstacle-handling plan instead of chaining primitives.
//   2nd trip on the same task: cancel the task and ask the player for help.
// Stuck state lives on the agent; switching tasks (or cancelling) resets.
// ----------------------------------------------------------------------------

// 'loop' — progress checker for "keep mining until N" style tasks. The skill
// doesn't drive the bot itself (that would block the orchestrator); instead
// it reads inventory and emits a system message that nudges the LLM toward
// the next iteration or !finishTask.
registerSlashSkill('loop', {
    meta: true,
    description: '(bot-self) Iterative progress check. Args: "<item_name> <target_count>". Use between iterations of a "keep mining/gathering until N" task.',
    async run(agent, args, ctx) {
        if (!agent.bot) return '[loop] not in-world.';
        const tokens = String(args || '').trim().split(/\s+/).filter(Boolean);
        if (tokens.length < 2) {
            return '[loop] usage: !invokeSkill("loop", "<item> <target>") — e.g. "iron_ore 64". I need both an item name and a count.';
        }
        const item = tokens[0].toLowerCase().replace(/^minecraft:/, '');
        const target = Math.max(1, Math.floor(Number(tokens[1])));
        if (!Number.isFinite(target)) return `[loop] invalid target: ${tokens[1]}`;
        const inv = agent.bot.inventory?.items?.() || [];
        const have = inv.filter(i => i.name === item).reduce((s, i) => s + i.count, 0);
        if (!layerOn('verify')) return `[loop] ${have}/${target} ${item}.`; // count only, no coaching
        if (have >= target) {
            return `[loop:complete ${have}/${target} ${item}] Target reached. Your next action MUST be !finishTask — the end_factor is met.`;
        }
        const need = target - have;
        return `[loop:${have}/${target} ${item}] still need ${need}. Your next action MUST be another !newAction("mine ${need} more ${item}; equip the right pickaxe, dig stairs / bridge water if the path requires it"). Do NOT call !finishTask yet — inventory hasn't hit ${target}.`;
    },
});

// 'verify' — re-checks the in-progress task's end_factor before !finishTask.
// Closes the LLM-honor-system loophole where the model marks a task done
// without actually meeting the criterion. Two deterministic patterns matched
// (inventory count, coord arrival); everything else falls back to LLM
// judgment via a "[verify:unknown]" message biased toward "don't finish".
registerSlashSkill('verify', {
    meta: true,
    description: '(bot-self) Re-check the in-progress task end_factor before !finishTask. Returns [verify:pass] (safe to finish), [verify:fail] (keep going), or [verify:unknown] (use judgment).',
    async run(agent, args, ctx) {
        if (!agent.bot) return '[verify] not in-world.';
        if (!layerOn('verify')) return '[verify] verification disabled — use your own judgment.'; // ablation
        const active = agent.task_queue?.tasks?.find(t => t.status === 'in_progress');
        if (!active) return '[verify] no task in progress.';
        const end = active.endFactor || '';
        if (!end) return `[verify] task #${active.id} has no end_factor — !finishTask is unguarded. Add an end_factor next time.`;
        const lower = end.toLowerCase();
        // Inventory-count match: "5 iron_ore in inventory" / "64 cobblestone in inventory"
        const invMatch = lower.match(/(\d+)\s+([a-z_]+)\s+in\s+inventory/);
        if (invMatch) {
            const need = Number(invMatch[1]);
            const item = invMatch[2];
            const inv = agent.bot.inventory?.items?.() || [];
            const have = inv.filter(i => i.name === item).reduce((s, i) => s + i.count, 0);
            if (have >= need) return `[verify:pass] ${have}/${need} ${item} in inventory. End_factor met — !finishTask is safe.`;
            return `[verify:fail] only ${have}/${need} ${item} in inventory. DO NOT !finishTask — keep working.`;
        }
        // Coord-arrival match: "bot at coords 100,64,-50" / "at coords (100, 64, -50)"
        const coordMatch = lower.match(/at\s+coords?\s*\(?\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/);
        if (coordMatch) {
            const tx = Number(coordMatch[1]);
            const ty = Number(coordMatch[2]);
            const tz = Number(coordMatch[3]);
            const p = agent.bot.entity?.position;
            if (!p) return '[verify] bot position unavailable.';
            const dist = Math.hypot(p.x - tx, p.y - ty, p.z - tz);
            if (dist <= 4) return `[verify:pass] at (${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}), target (${tx},${ty},${tz}), distance ${dist.toFixed(1)}. End_factor met.`;
            return `[verify:fail] at (${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}), target (${tx},${ty},${tz}), distance ${dist.toFixed(1)}. DO NOT !finishTask — keep moving.`;
        }
        // Player-pickup match: "player picked up the pickaxe" — can't deterministically check.
        // Fall through to unknown so the LLM uses judgment.
        return `[verify:unknown] end_factor "${end}" doesn't match a deterministic pattern (inventory-count or at-coords). Use !inventory / !stats to judge it yourself. If unsure, do NOT call !finishTask — leave it in progress and continue.`;
    },
});

registerSlashSkill('stuck', {
    meta: true,
    description: '(bot-self) Recover from no-progress. 1st trip: rewrite the plan via !newAction. 2nd trip on the same task: !cancelTask + ask the player.',
    async run(agent, args, ctx) {
        const active = agent.task_queue?.tasks?.find(t => t.status === 'in_progress');
        const activeId = active?.id ?? 0;
        agent._stuckState = agent._stuckState || { taskId: 0, count: 0 };
        if (agent._stuckState.taskId !== activeId) {
            agent._stuckState = { taskId: activeId, count: 0 };
        }
        agent._stuckState.count++;
        const trip = agent._stuckState.count;
        const reason = String(args || '').trim() || 'repeated path/tool failures';
        if (trip === 1) {
            return `[stuck:1] ${reason}. Your next action MUST be !newAction(detailed_prompt) with a concrete multi-step plan that addresses the obstacle: dig stairs through stone, bridge water with cobblestone, tower up with dirt. Be specific about materials and target coords. Chaining another primitive will not work.`;
        }
        // 2nd+ trip: cancel + ping player.
        let cancelDetail = '';
        if (active) {
            try {
                const r = agent.task_queue.cancelTask(active.id);
                cancelDetail = r?.message || '';
            } catch (e) {
                cancelDetail = `cancel failed: ${e?.message || e}`;
            }
        }
        try {
            const desc = active?.description ? `"${active.description}"` : 'the current task';
            agent.openChat?.(`I'm stuck on ${desc} (${reason}). Want me to skip it or try a different approach?`);
        } catch {}
        // Reset state so a fresh attempt starts at trip 1.
        agent._stuckState = { taskId: 0, count: 0 };
        return `[stuck:${trip}] Stuck on task #${active?.id ?? '?'} (${reason}). Cancelled (${cancelDetail}) and pinged the player. Don't retry the same plan — wait for direction.`;
    },
});

// /restock <item> [target_qty=64] — top up an item to a target quantity.
registerSlashSkill('restock', {
    description: 'Top up an item to a target quantity (default 64). Usage: /restock <item> [quantity].',
    async run(agent, args, ctx) {
        if (!agent.bot) return 'I\'m not in-world yet.';
        const tokens = String(args || '').trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0) return 'Usage: /restock <item> [target_qty=64]';
        const item = tokens[0].toLowerCase().replace(/^minecraft:/, '');
        const target = tokens[1] ? Math.max(1, Math.floor(Number(tokens[1]))) : 64;
        if (!Number.isFinite(target)) return `Invalid target qty: ${tokens[1]}`;
        const inv = agent.bot.inventory?.items?.() || [];
        const have = inv.filter(i => i.name === item).reduce((s, i) => s + i.count, 0);
        if (have >= target) return `/restock: already have ${have} ${item} (target ${target}). Skipping.`;
        const need = target - have;
        if (agent.planMode) agent.exitPlanMode();
        agent.task_queue.addTask(
            `Restock ${item} to ${target} (currently ${have}, need ${need} more). !newAction("gather ${need} ${item} via the most efficient route — mine the ore if it's a block, craft from materials if craftable, or check a nearby chest. Equip the right tool first.").`,
            `${target} ${item} in inventory`
        );
        try { agent.task_queue.startTask(null); } catch {}
        return `/restock: queued ${need} more ${item} (have ${have} of ${target}).`;
    },
});
