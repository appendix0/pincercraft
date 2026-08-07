import * as skills from './library/skills.js';
import * as world from './library/world.js';
import * as verify from './verify.js';
import * as mc from '../utils/mcdata.js';
import settings from './settings.js'
import convoManager from './conversation.js';
import { layerOn } from './harness_mode.js';

async function say(agent, message) {
    agent.bot.modes.behavior_log += message + '\n';
    if (agent.shut_up || !settings.narrate_behavior) return;
    agent.openChat(message);
}

// Deterministic predicate for the tool_break_guard reflex: did the bot's LAST
// pickaxe just break *while mining*? Pure + exported so the trigger logic is
// unit-testable without a live bot. The msSinceDig window is what separates a
// real break (item vanished right after a dig) from giving/depositing the
// pickaxe (no recent dig) — so a handoff is never mistaken for a break.
export function pickaxeJustBrokeMining({ hadPickaxe, pickaxeCount, msSinceDig, idle }) {
    return hadPickaxe && pickaxeCount === 0 && msSinceDig < 1500 && !idle;
}

// a mode is a function that is called every tick to respond immediately to the world
// it has the following fields:
// on: whether 'update' is called every tick
// active: whether an action has been triggered by the mode and hasn't yet finished
// paused: whether the mode is paused by another action that overrides the behavior (eg followplayer implements its own self defense)
// update: the function that is called every tick (if on is true)
// when a mode is active, it will trigger an action to be performed but won't wait for it to return output

// the order of this list matters! first modes will be prioritized
// while update functions are async, they should *not* be awaited longer than ~100ms as it will block the update loop
// to perform longer actions, use the execute function which won't block the update loop
const modes_list = [
    {
        name: 'self_preservation',
        description: 'Respond to drowning, burning, and damage at low health. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        fall_blocks: ['sand', 'gravel', 'concrete_powder'], // includes matching substrings like 'sandstone' and 'red_sand'
        update: async function (agent) {
            const bot = agent.bot;
            let block = bot.blockAt(bot.entity.position);
            let blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            if (!block) block = {name: 'air'}; // hacky fix when blocks are not loaded
            if (!blockAbove) blockAbove = {name: 'air'};
            if (blockAbove.name === 'water') {
                // does not call execute so does not interrupt other actions
                if (!bot.pathfinder.goal) {
                    bot.setControlState('jump', true);
                }
            }
            else if (this.fall_blocks.some(name => blockAbove.name.includes(name))) {
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 2);
                });
            }
            else if (block.name === 'lava' || block.name === 'fire' ||
                blockAbove.name === 'lava' || blockAbove.name === 'fire') {
                say(agent, 'I\'m on fire!');
                // if you have a water bucket, use it
                let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                if (waterBucket) {
                    execute(this, agent, async () => {
                        let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                        if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                    });
                }
                else {
                    execute(this, agent, async () => {
                        let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                        if (waterBucket) {
                            let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                            if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                            return;
                        }
                        let nearestWater = world.getNearestBlock(bot, 'water', 20);
                        if (nearestWater) {
                            const pos = nearestWater.position;
                            let success = await skills.goToPosition(bot, pos.x, pos.y, pos.z, 0.2);
                            if (success) say(agent, 'Found some water, ahhhh that\'s better!');
                            return;
                        }
                        await skills.moveAway(bot, 5);
                    });
                }
            }
            else if (Date.now() - bot.lastDamageTime < 3000 && (bot.health < 5 || bot.lastDamageTaken >= bot.health)) {
                say(agent, 'I\'m dying!');
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 20);
                });
            }
            else if (agent.isIdle()) {
                bot.clearControlStates(); // clear jump if not in danger or doing anything else
            }
        }
    },
    {
        // Deterministic reflex: when the LAST pickaxe breaks WHILE mining, stop
        // and tell the player — never keep flailing bare-handed (ore drops
        // nothing without a pickaxe). Code owns this fact; the LLM doesn't get
        // to guess it. The interrupt makes execute() re-ground the planner with
        // live inventory, so it re-plans (craft a pickaxe) instead of mining
        // air. Only fires right after a dig, so giving/depositing the pickaxe
        // is never mistaken for a break. Keeping a spare pickaxe → no fire
        // (count only hits 0 when the last one is gone).
        name: 'tool_break_guard',
        description: 'Stop and alert when the pickaxe breaks while mining. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        had_pickaxe: false,
        last_dig_time: 0,
        update: function (agent) {
            if (!layerOn('reflexes')) return; // reflex under field-trial ablation
            const bot = agent.bot;
            if (bot.targetDigBlock) this.last_dig_time = Date.now();
            const items = bot.inventory?.items?.() || [];
            const pickaxeCount = items.filter(i => i.name && i.name.endsWith('_pickaxe')).length;
            if (pickaxeJustBrokeMining({
                hadPickaxe: this.had_pickaxe,
                pickaxeCount,
                msSinceDig: Date.now() - this.last_dig_time,
                idle: agent.isIdle(),
            })) {
                say(agent, 'My pickaxe broke — stopping. I need a new pickaxe before mining more.');
                execute(this, agent, async () => {
                    agent.actions.cancelResume(); // don't auto-resume bare-handed mining
                });
            }
            this.had_pickaxe = pickaxeCount > 0;
        }
    },
    {
        name: 'unstuck',
        description: 'Attempt to get unstuck when in the same place for a while. Interrupts some actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        prev_location: null,
        distance: 2,
        stuck_time: 0,
        last_time: Date.now(),
        max_stuck_time: 20,
        prev_dig_block: null,
        update: async function (agent) {
            if (agent.isIdle()) { 
                this.prev_location = null;
                this.stuck_time = 0;
                return; // don't get stuck when idle
            }
            const bot = agent.bot;
            const cur_dig_block = bot.targetDigBlock;
            if (cur_dig_block && !this.prev_dig_block) {
                this.prev_dig_block = cur_dig_block;
            }
            if (this.prev_location && this.prev_location.distanceTo(bot.entity.position) < this.distance && cur_dig_block == this.prev_dig_block) {
                this.stuck_time += (Date.now() - this.last_time) / 1000;
            }
            else {
                this.prev_location = bot.entity.position.clone();
                this.stuck_time = 0;
                this.prev_dig_block = null;
            }
            const max_stuck_time = cur_dig_block?.name === 'obsidian' ? this.max_stuck_time * 2 : this.max_stuck_time;
            if (this.stuck_time > max_stuck_time) {
                say(agent, 'I\'m stuck!');
                this.stuck_time = 0;
                execute(this, agent, async () => {
                    // Upstream killed the PROCESS here if moveAway didn't finish
                    // in 10s — in a dug pit that's guaranteed death → disconnect
                    // mid-session (hit live 2026-07-05). Owner rule: never
                    // reboot-to-fix; tell the player honestly and stay online.
                    const bailTimeout = setTimeout(() => {
                        agent.requestInterrupt();
                        const t = agent.task_queue?.tasks?.find(x => x.status === 'in_progress');
                        if (t) agent.task_queue.cancelTask(t.id);
                        const p = bot.entity.position;
                        say(agent, `I'm stuck at ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)} and can't free myself — help me out or give me a new task.`);
                    }, 10000);
                    await skills.moveAway(bot, 5);
                    clearTimeout(bailTimeout);
                    say(agent, 'I\'m free.');
                });
            }
            this.last_time = Date.now();
        },
        unpause: function () {
            this.prev_location = null;
            this.stuck_time = 0;
            this.prev_dig_block = null;
        }
    },
    {
        name: 'cowardice',
        description: 'Run away from enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 16);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                say(agent, `Aaa! A ${enemy.name.replace("_", " ")}!`);
                execute(this, agent, async () => {
                    await skills.avoidEnemies(agent.bot, 24);
                });
            }
        }
    },
    {
        name: 'self_defense',
        description: 'Attack nearby enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 8);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                say(agent, `Fighting ${enemy.name}!`);
                execute(this, agent, async () => {
                    await skills.defendSelf(agent.bot, 8);
                });
            }
        }
    },
    {
        name: 'hunting',
        description: 'Hunt nearby animals when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        update: async function (agent) {
            const huntable = world.getNearestEntityWhere(agent.bot, entity => mc.isHuntable(entity), 8);
            if (huntable && await world.isClearPath(agent.bot, huntable)) {
                execute(this, agent, async () => {
                    say(agent, `Hunting ${huntable.name}!`);
                    await skills.attackEntity(agent.bot, huntable, true, false); // autonomous hunt: stay armed
                });
            }
        }
    },
    {
        name: 'item_collecting',
        description: 'Collect dropped items matching the current task goal when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,

        wait: 2, // number of seconds to wait after noticing an item to pick it up
        prev_item: null,
        noticed_at: -1,
        update: async function (agent) {
            // Only chase drops the active task is actually FOR (owner rule:
            // "only collect targeted drops, not every nearby drop"). Without a
            // matching target this mode stays idle — untargeted pickups also
            // ping-ponged with the tidyJunk reflex (pick up dirt → toss → pick
            // up the toss → …). Vanilla touch-pickup for handoffs is unaffected.
            const targets = verify.taskCollectTargets(agent.task_queue?.tasks?.find(t => t.status === 'in_progress'));
            if (targets.length === 0) {
                this.noticed_at = -1;
                return;
            }
            let item = world.getNearestEntityWhere(agent.bot, entity => entity.name === 'item' && targets.includes(world.droppedItemName(entity)), 8);
            let empty_inv_slots = agent.bot.inventory.emptySlotCount();
            if (item && item !== this.prev_item && await world.isClearPath(agent.bot, item) && empty_inv_slots > 1) {
                if (this.noticed_at === -1) {
                    this.noticed_at = Date.now();
                }
                if (Date.now() - this.noticed_at > this.wait * 1000) {
                    say(agent, `Picking up item!`);
                    this.prev_item = item;
                    execute(this, agent, async () => {
                        await skills.pickupNearbyItems(agent.bot, 8, targets);
                    });
                    this.noticed_at = -1;
                }
            }
            else {
                this.noticed_at = -1;
            }
        }
    },
    {
        name: 'torch_placing',
        description: 'Place torches when idle and there are no torches nearby.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        cooldown: 5,
        last_place: Date.now(),
        update: function (agent) {
            if (world.shouldPlaceTorch(agent.bot)) {
                if (Date.now() - this.last_place < this.cooldown * 1000) return;
                execute(this, agent, async () => {
                    const pos = agent.bot.entity.position;
                    await skills.placeBlock(agent.bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
                });
                this.last_place = Date.now();
            }
        }
    },
    {
        name: 'elbow_room',
        description: 'Move away from nearby players when idle.',
        interrupts: ['action:followPlayer'],
        // Off by default — fires at 0.5 blocks which is what happens when the
        // player walks INTO the bot (chest exchange, item handoff, standing
        // next to it). For a single-player companion bot the "shy" behavior
        // reads as broken. Re-enable per-session via !setMode("elbow_room", true).
        on: false,
        active: false,
        distance: 0.5,
        update: async function (agent) {
            const player = world.getNearestEntityWhere(agent.bot, entity => entity.type === 'player', this.distance);
            if (player) {
                execute(this, agent, async () => {
                    // wait a random amount of time to avoid identical movements with other bots
                    const wait_time = Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, wait_time));
                    if (player.position.distanceTo(agent.bot.entity.position) < this.distance) {
                        await skills.moveAwayFromEntity(agent.bot, player, this.distance);
                    }
                });
            }
        }
    },
    {
        name: 'idle_staring',
        description: 'Animation to look around at entities when idle.',
        interrupts: [],
        on: true,
        active: false,

        staring: false,
        last_entity: null,
        next_change: 0,
        update: function (agent) {
            const entity = agent.bot.nearestEntity();
            let entity_in_view = entity && entity.position.distanceTo(agent.bot.entity.position) < 10 && entity.name !== 'enderman';
            if (entity_in_view && entity !== this.last_entity) {
                this.staring = true;
                this.last_entity = entity;
                this.next_change = Date.now() + Math.random() * 1000 + 4000;
            }
            if (entity_in_view && this.staring) {
                let isbaby = entity.type !== 'player' && entity.metadata[16];
                let height = isbaby ? entity.height/2 : entity.height;
                agent.bot.lookAt(entity.position.offset(0, height, 0));
            }
            if (!entity_in_view)
                this.last_entity = null;
            if (Date.now() > this.next_change) {
                // look in random direction
                this.staring = Math.random() < 0.3;
                if (!this.staring) {
                    const yaw = Math.random() * Math.PI * 2;
                    const pitch = (Math.random() * Math.PI/2) - Math.PI/4;
                    agent.bot.look(yaw, pitch, false);
                }
                this.next_change = Date.now() + Math.random() * 10000 + 2000;
            }
        }
    },
    {
        name: 'cheat',
        description: 'Use cheats to instantly place blocks and teleport.',
        interrupts: [],
        on: false,
        active: false,
        update: function (agent) { /* do nothing */ }
    }
];

async function execute(mode, agent, func, timeout=-1) {
    if (agent.self_prompter.isActive())
        agent.self_prompter.stopLoop();
    let interrupted_action = agent.actions.currentActionLabel;
    mode.active = true;
    let code_return = await agent.actions.runAction(`mode:${mode.name}`, async () => {
        await func();
    }, { timeout });
    mode.active = false;
    console.log(`Mode ${mode.name} finished executing, code_return: ${code_return.message}`);

    let should_reprompt =
        interrupted_action && // it interrupted a previous action
        !agent.actions.resume_func && // there is no resume function
        !agent.self_prompter.isActive(); // self prompting is not on
    // NOTE: we deliberately no longer require !code_return.interrupted. When the
    // recovery action is itself interrupted (chained stuck → unstuck → stuck),
    // the ORIGINAL action still did not complete — and suppressing the notice in
    // that case is exactly how an interrupted attack got narrated as a kill.
    // Always tell the planner the action did not finish.

    if (should_reprompt) {
        // auto prompt to respond to the interruption
        let role = convoManager.inConversation() ? agent.last_sender : 'system';
        let logs = agent.bot.modes.flushBehaviorLog();
        // Re-ground the planner at the moment it's most confused: an interruption
        // is NOT task completion. Restate the active task + live inventory so a
        // small model can't carry forward a stale or invented "I finished / I have
        // it" belief (the false "got 20 diamonds/iron" failure).
        let regrounding = '';
        try {
            const active = agent.task_queue?.tasks?.find(t => t.status === 'in_progress');
            if (active) regrounding += ` You were working task #${active.id}: "${active.description}"${active.endFactor ? ` (done when: ${active.endFactor})` : ''}.`;
            const counts = world.getInventoryCounts(agent.bot);
            const invStr = Object.entries(counts).map(([n, c]) => `${n} x${c}`).join(', ') || 'empty';
            const resumeTail = agent._awaitingDeathChoice
                ? 'Do NOT resume anything — you died and already asked the player whether to retrieve your items or forget them. Stand still and wait for their answer.'
                : 'Then resume.';
            regrounding += ` Your inventory RIGHT NOW: ${invStr}. Re-check the end_factor against this before any claim — never tell the player you have or finished something your inventory does not show. ${resumeTail}`;
            // Kill/hit goals leave no inventory trace, so the line above can't
            // catch a confabulated "I killed it". Add live ground truth: the
            // target is almost always still standing right there.
            if (/attack|kill|hunt|hit/i.test(interrupted_action)) {
                const mobs = [];
                for (const e of world.getNearbyEntities(agent.bot, 16)) {
                    if (e === agent.bot.entity || e.type === 'player' || e.name === 'item') continue;
                    if (mobs.length < 6) mobs.push(`${e.name}(${e.position.distanceTo(agent.bot.entity.position).toFixed(0)}m)`);
                }
                regrounding += ` Living mobs near you RIGHT NOW: ${mobs.length ? mobs.join(', ') : 'none'}. If you were told to kill or hit something and it is still in this list, it is NOT dead — do not claim it is.`;
            }
        } catch (e) { /* best-effort re-grounding */ }
        agent.enqueue({
            source: role,
            message: `(AUTO MESSAGE) Your action '${interrupted_action}' was INTERRUPTED by ${mode.name} — this is NOT task completion.${regrounding}\nBehavior log: ${logs}`,
            kind: 'mode_auto',
            mode_name: mode.name,
        });
    }
}

let _agent = null;
const modes_map = {};
for (let mode of modes_list) {
    modes_map[mode.name] = mode;
}

class ModeController {
    /*
    SECURITY WARNING:
    ModesController must be reference isolated. Do not store references to external objects like `agent`.
    This object is accessible by LLM generated code, so any stored references are also accessible.
    This can be used to expose sensitive information by malicious prompters.
    */
    constructor() {
        this.behavior_log = '';
    }

    exists(mode_name) {
        return modes_map[mode_name] != null;
    }

    setOn(mode_name, on) {
        modes_map[mode_name].on = on;
    }

    isOn(mode_name) {
        return modes_map[mode_name].on;
    }

    pause(mode_name) {
        modes_map[mode_name].paused = true;
    }

    unpause(mode_name) {
        const mode = modes_map[mode_name];
        //if  unpause func is defined and mode is currently paused
        if (mode.unpause && mode.paused) {
            mode.unpause();
        }
        mode.paused = false;
    }

    unPauseAll() {
        for (let mode of modes_list) {
            if (mode.paused) console.log(`Unpausing mode ${mode.name}`);
            this.unpause(mode.name);
        }
    }

    getMiniDocs() { // no descriptions
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on})`;
        }
        return res;
    }

    getDocs() {
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on}): ${mode.description}`;
        }
        return res;
    }

    async update() {
        if (_agent.isIdle()) {
            this.unPauseAll();
        }
        for (let mode of modes_list) {
            let interruptible = mode.interrupts.some(i => i === 'all') || mode.interrupts.some(i => i === _agent.actions.currentActionLabel);
            if (mode.on && !mode.paused && !mode.active && (_agent.isIdle() || interruptible)) {
                await mode.update(_agent);
            }
            if (mode.active) break;
        }
    }

    flushBehaviorLog() {
        const log = this.behavior_log;
        this.behavior_log = '';
        return log;
    }

    getJson() {
        let res = {};
        for (let mode of modes_list) {
            res[mode.name] = mode.on;
        }
        return res;
    }

    loadJson(json) {
        for (let mode of modes_list) {
            if (json[mode.name] != undefined) {
                mode.on = json[mode.name];
            }
        }
    }
}

export function initModes(agent) {
    _agent = agent;
    // the mode controller is added to the bot object so it is accessible from anywhere the bot is used
    agent.bot.modes = new ModeController();
    if (agent.task) {
        agent.bot.restrict_to_inventory = agent.task.restrict_to_inventory;
    }
    let modes_json = agent.prompter.getInitModes();
    if (modes_json) {
        agent.bot.modes.loadJson(modes_json);
    }
}
