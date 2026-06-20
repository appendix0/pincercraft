import * as skills from '../library/skills.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import { findMissingToolsInPrompt, MISSING_TOOL_REJECT, findRedundantFetchInPrompt, REDUNDANT_FETCH_SKIP } from '../classify_and_gate.js';
import { verifyEndFactor } from '../verify.js';


// The player currently directing me (Floodgate '.'-prefix aware). I resolve
// "this bed / this chest" relative to where the OWNER is standing/pointing, so
// re-designating a spot overwrites my memory with the coordinate THEY mean —
// not a stale remembered spot, and not whatever happens to be nearest me.
function speakerPosition(agent) {
    const name = agent.last_sender;
    if (!name) return null;
    const e = agent.bot.players[name]?.entity ?? agent.bot.players['.' + name]?.entity;
    return e?.position ?? null;
}

// Nearest block satisfying `predicate(name)` to a reference point `ref`.
// Returns { pos, name } or null. Used to determine the exact block the owner is
// pointing at before overwriting the remembered place with its coordinate.
function nearestBlockToRef(agent, predicate, maxDistance, ref) {
    const positions = agent.bot.findBlocks({ matching: (b) => predicate(b.name), maxDistance, count: 128 });
    if (positions.length === 0) return null;
    positions.sort((a, b) => ref.distanceTo(a) - ref.distanceTo(b));
    const pos = positions[0];
    return { pos, name: agent.bot.blockAt(pos)?.name ?? null };
}


function runAsAction (actionFn, resume = false, timeout = -1) {
    let actionLabel = null;  // Will be set on first use

    const wrappedAction = async function (agent, ...args) {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1); // Remove the ! prefix
        }

        const actionFnWithAgent = async () => {
            await actionFn(agent, ...args);
        };
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout, resume });
        if (code_return.interrupted && !code_return.timedout)
            return;
        return code_return.message;
    }
    // Step 2: mark so the tool_registry can derive isLongRunning without
    // each command entry having to declare it. Anything wrapped via
    // runAsAction blocks the worker on physical motion — Step 5 will
    // route those through background handles.
    wrappedAction.isLongRunning = true;

    return wrappedAction;
}

export const actionsList = [
    {
        name: '!newAction',
        description: 'Perform new and unknown custom behaviors that are not available as a command.', 
        params: {
            'prompt': { type: 'string', description: 'A natural language prompt to guide code generation. Make a detailed step-by-step plan.' }
        },
        perform: async function(agent, prompt) {
            // just ignore prompt - it is now in context in chat history
            if (!settings.allow_insecure_coding) {
                agent.openChat('newAction is disabled. Enable with allow_insecure_coding=true in settings.js');
                return "newAction not allowed! Code writing is disabled in settings. Notify the user.";
            }
            // Tool-availability gate: reject prompts that name tools the bot
            // doesn't have, before burning a Coder turn + pathfinder timeout.
            const inv = agent.bot?.inventory?.items?.() || [];
            const missing = findMissingToolsInPrompt(prompt, inv);
            if (missing.length > 0) {
                console.log('[tool-gate] rejecting !newAction, missing:', missing.join(', '));
                return MISSING_TOOL_REJECT(missing);
            }
            // Redundant-fetch gate (inverse): skip the Coder when the prompt
            // wants to fetch/craft a tool already in inventory (the
            // iron_pickaxe-from-chest loop). Skip + one-line chat, no code run.
            const redundant = findRedundantFetchInPrompt(prompt, inv);
            if (redundant.length > 0) {
                console.log('[tool-gate] skipping !newAction, already have:', redundant.join(', '));
                try { agent.openChat(`Already have my ${redundant[0]} — skipping that, moving on.`); } catch {}
                return REDUNDANT_FETCH_SKIP(redundant);
            }
            let result = "";
            const actionFn = async () => {
                try {
                    result = await agent.coder.generateCode(agent.history);
                } catch (e) {
                    result = 'Error generating code: ' + e.toString();
                }
            };
            await agent.actions.runAction('action:newAction', actionFn, {timeout: settings.code_timeout_mins});
            return result;
        }
    },
    {
        name: '!stop',
        isConcurrencySafe: true,
        description: 'Force stop the current action AND clear every pending task. Use whenever the player says stop/halt/abort.',
        perform: async function (agent) {
            await agent.actions.stop();
            agent.clearBotLogs();
            agent.actions.cancelResume();
            agent.bot.emit('idle');
            let msg = 'Agent stopped.';
            // Stop = stop EVERYTHING. Wipe the task queue too — the player's
            // mental model when they say "stop" is the whole plan, not just
            // the currently-running step. (2026-05-18 user feedback.)
            if (agent.task_queue) {
                const r = agent.task_queue.cancelAllPending();
                if (r.count > 0) msg += ` Cleared ${r.count} pending task(s).`;
            }
            if (agent.self_prompter.isActive())
                msg += ' Self-prompting still active.';
            return msg;
        }
    },
    {
        name: '!goToPlayer',
        description: 'Go to the given player.',
        params: {
            'player_name': {type: 'string', description: 'The name of the player to go to.'},
            'closeness': {type: 'float', description: 'How close to get to the player.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, closeness) => {
            await skills.goToPlayer(agent.bot, player_name, closeness);
        })
    },
    {
        name: '!followPlayer',
        description: 'Endlessly follow the given player.',
        params: {
            'player_name': {type: 'string', description: 'name of the player to follow.'},
            'follow_dist': {type: 'float', description: 'The distance to follow from.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, follow_dist) => {
            await skills.followPlayer(agent.bot, player_name, follow_dist);
        }, true)
    },
    {
        name: '!goToCoordinates',
        description: 'Go to x,y,z. Auto-digs/bridges obstacles. On failure, escalate to !newAction.',
        params: {
            'x': {type: 'float', description: 'The x coordinate.', domain: [-Infinity, Infinity]},
            'y': {type: 'float', description: 'The y coordinate.', domain: [-64, 320]},
            'z': {type: 'float', description: 'The z coordinate.', domain: [-Infinity, Infinity]},
            'closeness': {type: 'float', description: 'How close to get to the location.', domain: [0, Infinity]}
        },
        // Phase D4: rebound to smartGoTo. Original skills.goToPosition kept as
        // a low-level fallback for code paths that need the single-tier behavior.
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            const res = await skills.smartGoTo(agent.bot, x, y, z, closeness);
            if (res?.message) skills.log(agent.bot, res.message);
        })
    },
    {
        name: '!searchForBlock',
        description: 'Walk NEXT TO the nearest block (navigation/inspection only — does NOT mine it). To find AND mine/fetch a block, use !findAndMine.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the block. Minimum 32.', domain: [10, 512] }
        },
        perform: runAsAction(async (agent, block_type, range) => {
            if (range < 32) {
                skills.log(agent.bot, `Minimum search range is 32.`);
                range = 32;
            }
            await skills.goToNearestBlock(agent.bot, block_type, 4, range);
        })
    },
    {
        name: '!pickupItems',
        description: 'Walk around and pick up nearby dropped items (mob drops, scattered resources) within ~32 blocks. Use after a fight, or when $STATS shows dropped items nearby.',
        perform: runAsAction(async (agent) => {
            await skills.pickupNearbyItems(agent.bot, 32);
        })
    },
    {
        name: '!findAndMine',
        description: 'Find the nearest block of a type (wide range; includes buried ore in render distance), go to it and mine it once, collecting the drop. This is the "find/get/mine me X" command — it tunnels to reach buried blocks. Needs the right pickaxe tier. If none found, move/explore and retry. For a fixed amount use num; for open-ended "keep mining" use !gather.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to find and mine.' },
            'num': { type: 'int', description: 'How many to find and mine.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, type, num) => {
            await skills.findAndMine(agent.bot, type, num);
        })
    },
    {
        name: '!usePortal',
        description: 'Walk into the nearest lit nether portal and go through to the other dimension. Use when the player says "go through the portal" / "let\'s go to the nether / back to the overworld". Needs an active (purple) portal nearby. Remembers the portal you arrive at as portal_<dimension>.',
        perform: runAsAction(async (agent) => {
            const ok = await skills.usePortal(agent.bot);
            if (ok) {
                const dim = agent.bot.game.dimension.split(':').pop();
                const h = agent.bot.entity.position;
                agent.memory_bank.rememberPlace('portal_' + dim, Math.round(h.x), Math.round(h.y), Math.round(h.z));
            }
        })
    },
    {
        name: '!gather',
        description: 'Keep finding and mining a block type until none remain nearby, your inventory is full, or you are told to stop ("stop"/"that\'s enough" → !stop). Use for open-ended "keep mining X" / "get more X" / "another one" — you do NOT need the player to re-ask for each block. For a specific amount, use !findAndMine with num instead.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to keep gathering.' }
        },
        perform: runAsAction(async (agent, type) => {
            await skills.gather(agent.bot, type);
        })
    },
    {
        name: '!searchForEntity',
        description: 'Find and go to the nearest entity of a given type in a given range.',
        params: {
            'type': { type: 'string', description: 'The type of entity to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the entity.', domain: [32, 512] }
        },
        perform: runAsAction(async (agent, entity_type, range) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: 'Move away from the current location in any direction by a given distance.',
        params: {'distance': { type: 'float', description: 'The distance to move away.', domain: [0, Infinity] }},
        // Survival action — flee from danger cannot wait for plan approval.
        isSurvival: true,
        perform: runAsAction(async (agent, distance) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!rememberHere',
        isConcurrencySafe: true,
        description: 'Save the current location with a given name.',
        params: {'name': { type: 'string', description: 'The name to remember the location as.' }},
        perform: async function (agent, name) {
            const pos = agent.bot.entity.position;
            agent.memory_bank.rememberPlace(name, pos.x, pos.y, pos.z);
            return `Location saved as "${name}".`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: 'Go to a saved location.',
        params: {'name': { type: 'string', description: 'The name of the location to go to.' }},
        perform: runAsAction(async (agent, name) => {
            const pos = agent.memory_bank.recallPlace(name);
            if (!pos) {
            skills.log(agent.bot, `No location named "${name}" saved.`);
            return;
            }
            await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2], 1);
        })
    },
    {
        name: '!givePlayer',
        description: 'Give item to player by dropping near them. Success = delivery done.',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to give the item to.' },
            'item_name': { type: 'ItemName', description: 'The name of the item to give.' },
            'num': { type: 'int', description: 'The number of items to give.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: async function (agent, player_name, item_name, num) {
            // Deterministic give-gate: never give (or claim to give) what we don't
            // hold. Code owns this fact — the LLM's belief that it has the item
            // (the diamond_sword it never had) does NOT get a vote. Refuse with a
            // structured corrective BEFORE moving, so a hallucinated possession
            // can't turn into a hallucinated delivery. Fail-open if no manager.
            const gate = agent.inventory_manager?.requireHeld(item_name, num, 'give');
            if (gate && !gate.ok) {
                return `[give blocked] ${gate.corrective}`;
            }
            // Don't wrap via runAsAction() — it self-looks-up in actionsList by
            // perform-identity, and the inner wrapper is never registered, so
            // the lookup returned undefined and crashed with TypeError. Call
            // the action manager directly with an explicit label instead.
            const code_return = await agent.actions.runAction(
                'action:givePlayer',
                async () => { await skills.giveToPlayer(agent.bot, item_name, player_name, num); },
                { timeout: -1, resume: false },
            );
            const result = code_return.interrupted && !code_return.timedout ? undefined : code_return.message;
            // giveToPlayer logs "<player> received <item>" when the player
            // collected the drop, or "Gave N <item> (dropped at their feet)"
            // when the items left the bot's inventory at the player but weren't
            // collected yet — either way the give physically happened, so both
            // gate the auto-finish. Failure messages don't match.
            try {
                const pickedUp = result && /\b(received|gave)\b/i.test(result);
                if (pickedUp) {
                    const active = agent.task_queue?.tasks.find(t => t.status === 'in_progress');
                    if (active) {
                        const desc = active.description.toLowerCase();
                        const item = String(item_name).toLowerCase();
                        const player = String(player_name).toLowerCase().replace(/^\./, '');
                        const isDelivery = /(give|deliver|bring|hand|return|drop)/i.test(desc);
                        if (isDelivery && desc.includes(item) && desc.includes(player)) {
                            const finish = agent.task_queue.finishTask();
                            return `${result}\n${finish.message}`.trim();
                        }
                    }
                }
            } catch (e) {
                console.warn('auto-finish on !givePlayer failed:', e?.message || e);
            }
            return result;
        }
    },
    {
        name: '!consume',
        description: 'Eat/drink the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to consume.' }},
        // Survival action — bypasses plan-mode gate. The bot must be able to
        // eat even while a proposed plan is waiting for player approval.
        // Death from 3 HP starvation while plan-mode-locked was the original
        // motivating incident (2026-05-21).
        isSurvival: true,
        isLongRunning: true,
        // Plain async so the proprioception gate short-circuits: can't eat (or
        // claim to eat) food you don't hold — the "eat 2 chickens" hallucination.
        perform: async function (agent, item_name) {
            const gate = agent.inventory_manager?.requireHeld(item_name, 1, 'eat');
            if (gate && !gate.ok) {
                return `[eat blocked] ${gate.corrective}`;
            }
            const code_return = await agent.actions.runAction(
                'action:consume',
                async () => { await skills.consume(agent.bot, item_name); },
                { timeout: -1, resume: false },
            );
            return code_return.interrupted && !code_return.timedout ? undefined : code_return.message;
        }
    },
    {
        name: '!equip',
        description: 'Equip the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to equip.' }},
        // Survival action — equip shield/armor/sword during a fight cannot
        // wait for plan approval.
        isSurvival: true,
        perform: runAsAction(async (agent, item_name) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!putInChest',
        description: 'Put the given item in the nearest chest.',
        isLongRunning: true,
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to put in the chest.' },
            'num': { type: 'int', description: 'The number of items to put in the chest.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        // Plain async (not runAsAction) so the proprioception gate short-circuits
        // BEFORE pathing to the chest — don't walk there to stash what you don't hold.
        perform: async function (agent, item_name, num) {
            const gate = agent.inventory_manager?.requireHeld(item_name, num, 'put in the chest');
            if (gate && !gate.ok) {
                return `[put blocked] ${gate.corrective}`;
            }
            const code_return = await agent.actions.runAction(
                'action:putInChest',
                async () => { await skills.putInChest(agent.bot, item_name, num); },
                { timeout: -1, resume: false },
            );
            return code_return.interrupted && !code_return.timedout ? undefined : code_return.message;
        }
    },
    {
        name: '!takeFromChest',
        description: 'Take the given items from the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to take.' },
            'num': { type: 'int', description: 'The number of items to take.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        // Plain async (not runAsAction) so the idempotency guard can short-
        // circuit before acquiring the action lock / pathing to the chest.
        // Mirrors !givePlayer's explicit-label runAction call.
        perform: async function (agent, item_name, num) {
            if (agent.inventory_manager?.redundantAcquire(item_name)) {
                const msg = `Already have ${item_name} — not opening the chest.`;
                try { agent.openChat(msg); } catch {}
                return msg;
            }
            const code_return = await agent.actions.runAction(
                'action:takeFromChest',
                async () => { await skills.takeFromChest(agent.bot, item_name, num); },
                { timeout: -1, resume: false },
            );
            return code_return.interrupted && !code_return.timedout ? undefined : code_return.message;
        }
    },
    {
        name: '!viewChest',
        description: 'View the items/counts of the nearest chest.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.viewChest(agent.bot);
        })
    },
    {
        name: '!discard',
        description: 'Discard the given item from the inventory.',
        isLongRunning: true,
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to discard.' },
            'num': { type: 'int', description: 'The number of items to discard.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        // Plain async so the proprioception gate short-circuits before moving.
        perform: async function (agent, item_name, num) {
            const gate = agent.inventory_manager?.requireHeld(item_name, num, 'discard');
            if (gate && !gate.ok) {
                return `[discard blocked] ${gate.corrective}`;
            }
            return await agent.actions.runAction(
                'action:discard',
                async () => {
                    const start_loc = agent.bot.entity.position;
                    await skills.moveAway(agent.bot, 5);
                    await skills.discard(agent.bot, item_name, num);
                    await skills.goToPosition(agent.bot, start_loc.x, start_loc.y, start_loc.z, 0);
                },
                { timeout: -1, resume: false },
            ).then(cr => cr.interrupted && !cr.timedout ? undefined : cr.message);
        }
    },
    {
        name: '!makeSpace',
        description: 'Free inventory space: deposit junk into a nearby chest, else discard low-value items. Never discards tools, armor, food, or the current task item.',
        perform: runAsAction(async (agent) => {
            const im = agent.inventory_manager;
            const before = im.emptySlots();
            await im.ensureSpace({ threshold: 3 });
            skills.log(agent.bot, `Inventory: ${im.statusLine()} (freed ${im.emptySlots() - before} slots).`);
        })
    },
    {
        name: '!collectBlocks',
        description: 'Collect nearest blocks of a type. Auto-equips tool. On fail, escalate to !newAction.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to collect.' },
            'num': { type: 'int', description: 'The number of blocks to collect.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        // Phase D4: rebound to smartGather. The bare skills.collectBlock stays
        // available as a primitive for code paths that already have a target.
        perform: runAsAction(async (agent, type, num) => {
            const res = await skills.smartGather(agent.bot, type, num);
            if (res?.message) skills.log(agent.bot, res.message);
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!craftRecipe',
        description: 'Craft the given recipe a given number of times.',
        params: {
            'recipe_name': { type: 'ItemName', description: 'The name of the output item to craft.' },
            'num': { type: 'int', description: 'The number of times to craft the recipe. This is NOT the number of output items, as it may craft many more items depending on the recipe.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        // Plain async so the idempotency guard runs before the action lock:
        // never craft a second of a tool already held (resources are exempt —
        // redundantAcquire only fires for tool/equipment-class items).
        perform: async function (agent, recipe_name, num) {
            if (agent.inventory_manager?.redundantAcquire(recipe_name)) {
                const msg = `Already have a ${recipe_name} — no need to craft another.`;
                try { agent.openChat(msg); } catch {}
                return msg;
            }
            // Deterministic preflight (Claude Code-style precondition gate): never
            // attempt a craft the bot can't afford. Bounce it with a structured
            // corrective (missing materials + cheapest tool it CAN make) so the
            // planner re-plans instead of failing the craft and flailing.
            const pf = agent.inventory_manager?.craftPreflight(recipe_name, num);
            if (pf && pf.ok === false) {
                try { agent.openChat(pf.corrective); } catch {}
                return pf.corrective;
            }
            const code_return = await agent.actions.runAction(
                'action:craftRecipe',
                async () => { await skills.craftRecipe(agent.bot, recipe_name, num); },
                { timeout: -1, resume: false },
            );
            return code_return.interrupted && !code_return.timedout ? undefined : code_return.message;
        }
    },
    {
        name: '!smeltItem',
        description: 'Smelt the given item the given number of times.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the input item to smelt.' },
            'num': { type: 'int', description: 'The number of times to smelt the item.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            // Upstream mindcraft self-restarted the process here ("Safely
            // restarting to update inventory.") to work around an old
            // inventory-desync-after-smelt bug. skills.smeltItem now pulls the
            // result with furnace.takeOutput()/takeInput()/takeFuel(), so
            // bot.inventory is already in sync and the restart is unnecessary.
            // The restart WAS the disconnect loop: every successful smelt killed
            // the bot mid-mission (the "stopped right after smelting 3 iron"
            // bug) and the reboot wiped any execute-directly task. Don't kill.
            await skills.smeltItem(agent.bot, item_name, num);
        })
    },
    {
        name: '!clearFurnace',
        description: 'Take all items out of the nearest furnace.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
        {
        name: '!placeHere',
        description: 'Place a given block in the current location. Do NOT use to build structures, only use for single blocks/torches.',
        params: {'type': { type: 'BlockOrItemName', description: 'The block type to place.' }},
        perform: runAsAction(async (agent, type) => {
            let pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        name: '!attack',
        description: 'Attack and kill the nearest entity of a given type.',
        params: {'type': { type: 'string', description: 'The type of entity to attack.'}},
        // Survival action — fighting off mobs that just damaged the bot
        // cannot wait for plan approval.
        isSurvival: true,
        perform: runAsAction(async (agent, type) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!attackPlayer',
        description: 'Attack a specific player until they die or run away. Remember this is just a game and does not cause real life harm.',
        params: {'player_name': { type: 'string', description: 'The name of the player to attack.'}},
        perform: runAsAction(async (agent, player_name) => {
            // PATCH: Floodgate prefixes Bedrock players with '.' in bot.players but strips it in chat events
            let player = agent.bot.players[player_name]?.entity ?? agent.bot.players["." + player_name]?.entity;
            if (!player) {
                skills.log(agent.bot, `Could not find player ${player_name}.`);
                return false;
            }
            await skills.attackEntity(agent.bot, player, true);
        })
    },
    {
        name: '!goToBed',
        description: 'Go to your assigned bed and sleep. If no bed is assigned, asks the owner to assign one (does NOT pick a random nearest bed).',
        perform: runAsAction(async (agent) => {
            const pos = agent.memory_bank.recallPlace('bed');
            if (!pos) {
                skills.log(agent.bot, `There is no bed assigned to me yet — want to assign one? Stand by the bed you want me to use and tell me to assign it.`);
                return;
            }
            await skills.goToBed(agent.bot, pos);
        })
    },
    {
        name: '!assignBed',
        isConcurrencySafe: true,
        description: "(Re)assign my bed to the one the owner is showing me — OVERWRITES my remembered bed (persists across reboots). I determine the bed nearest the owner (the one they're standing by / pointing at) and write ITS coordinate to memory, replacing any stale bed. Use whenever the owner tells me a (different) bed is mine.",
        perform: function (agent) {
            const ref = speakerPosition(agent) ?? agent.bot.entity.position;
            const found = nearestBlockToRef(agent, (n) => n.endsWith('_bed'), 16, ref);
            if (!found) {
                return `No bed nearby to assign. Stand next to the bed you want me to use and try again.`;
            }
            const { pos, name } = found;
            agent.memory_bank.rememberPlace('bed', pos.x, pos.y, pos.z);
            const color = name?.endsWith('_bed') ? name.slice(0, -4).replace(/_/g, ' ') : 'this';
            return `Got it — overwrote my bed to the ${color} bed at (${pos.x}, ${pos.y}, ${pos.z}). I'll sleep there from now on.`;
        }
    },
    {
        name: '!assignChest',
        isConcurrencySafe: true,
        description: "(Re)assign my chest to the one the owner is showing me — OVERWRITES my remembered chest (persists across reboots). I determine the chest nearest the owner (the one they're standing on / pointing at) and write ITS coordinate to memory, replacing any stale chest. Use whenever the owner tells me a (different) chest is mine.",
        perform: function (agent) {
            const ref = speakerPosition(agent) ?? agent.bot.entity.position;
            const found = nearestBlockToRef(agent, (n) => n === 'chest' || n === 'trapped_chest', 16, ref);
            if (!found) {
                return `No chest nearby to assign. Stand on/next to the chest you want me to use and try again.`;
            }
            const { pos } = found;
            agent.memory_bank.rememberPlace('my-chest', pos.x, pos.y, pos.z);
            return `Got it — overwrote my chest to the one at (${pos.x}, ${pos.y}, ${pos.z}). I'll go there for my chest from now on.`;
        }
    },
    {
        name: '!goToChest',
        description: 'Go to my assigned chest. If no chest is assigned, asks the owner to show me one (does NOT pick a random nearest chest).',
        perform: runAsAction(async (agent) => {
            const pos = agent.memory_bank.recallPlace('my-chest');
            if (!pos) {
                skills.log(agent.bot, `There's no chest assigned to me yet — stand by the chest you want me to use and tell me to assign it.`);
                return;
            }
            await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2]);
        })
    },
    {
        name: '!stay',
        description: 'Stay in the current location no matter what. Pauses all modes.',
        params: {'type': { type: 'int', description: 'The number of seconds to stay. -1 for forever.', domain: [-1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, seconds) => {
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!setMode',
        isConcurrencySafe: true,
        description: 'Set a mode to on or off. A mode is an automatic behavior that constantly checks and responds to the environment.',
        params: {
            'mode_name': { type: 'string', description: 'The name of the mode to enable.' },
            'on': { type: 'boolean', description: 'Whether to enable or disable the mode.' }
        },
        perform: async function (agent, mode_name, on) {
            const modes = agent.bot.modes;
            if (!modes.exists(mode_name))
            return `Mode ${mode_name} does not exist.` + modes.getDocs();
            if (modes.isOn(mode_name) === on)
            return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`;
            modes.setOn(mode_name, on);
            return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`;
        }
    },
    {
        name: '!showVillagerTrades',
        description: 'Show trades of a specified villager.',
        params: {'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' }},
        perform: runAsAction(async (agent, id) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: 'Trade with a specified villager.',
        params: {
            'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' },
            'index': { type: 'int', description: 'The index of the trade you want executed (1-indexed).', domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: 'How many times that trade should be executed.', domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!startConversation',
        isConcurrencySafe: true,
        description: 'Start a conversation with a bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to send the message to.' },
            'message': { type: 'string', description: 'The message to send.' },
        },
        perform: async function (agent, player_name, message) {
            if (!convoManager.isOtherAgent(player_name))
                return player_name + ' is not a bot, cannot start conversation.';
            if (convoManager.inConversation() && !convoManager.inConversation(player_name)) 
                convoManager.forceEndCurrentConversation();
            else if (convoManager.inConversation(player_name))
                agent.history.add('system', 'You are already in conversation with ' + player_name + '. Don\'t use this command to talk to them.');
            convoManager.startConversation(player_name, message);
        }
    },
    {
        name: '!endConversation',
        isConcurrencySafe: true,
        description: 'End the conversation with the given bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to end the conversation with.' }
        },
        perform: async function (agent, player_name) {
            if (!convoManager.inConversation(player_name))
                return `Not in conversation with ${player_name}.`;
            convoManager.endConversation(player_name);
            return `Converstaion with ${player_name} ended.`;
        }
    },
    {
        name: '!lookAtPlayer',
        description: 'Look at a player or look in the same direction as the player.',
        params: {
            'player_name': { type: 'string', description: 'Name of the target player' },
            'direction': {
                type: 'string',
                description: 'How to look ("at": look at the player, "with": look in the same direction as the player)',
            }
        },
        perform: async function(agent, player_name, direction) {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPlayer(player_name, direction);
            };
            await agent.actions.runAction('action:lookAtPlayer', actionFn);
            return result;
        }
    },
    {
        name: '!digDown',
        description: 'Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.',
        params: {'distance': { type: 'int', description: 'Distance to dig down', domain: [1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.digDown(agent.bot, distance)
        })
    },
    {
        name: '!goToSurface',
        description: 'Moves the bot to the highest block above it (usually the surface).',
        params: {},
        // Survival action — escaping a cave-in / drowning / lava can't wait.
        isSurvival: true,
        perform: runAsAction(async (agent) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        name: '!useOn',
        description: 'Use (right click) the given tool on the nearest target of the given type.',
        params: {
            'tool_name': { type: 'string', description: 'Name of the tool to use, or "hand" for no tool.' },
            'target': { type: 'string', description: 'The target as an entity type, block type, or "nothing" for no target.' }
        },
        perform: runAsAction(async (agent, tool_name, target) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
    {
        name: '!addTask',
        isConcurrencySafe: true,
        description: 'Add task to own queue. end_factor required (observable completion criterion). REJECTED if description implies >200 blocks/items of work — split into smaller chunks first.',
        params: {
            'description': { type: 'string', description: 'Short description of the task (e.g. "mine 5 iron_ore", "build a 3x3 oak_planks wall"). Must be <=200 blocks/items of work per task.' },
            'end_factor': { type: 'string', description: 'Observable completion criterion (e.g. "5 iron_ore in inventory", "iron_pickaxe in inventory", "player picked up the pickaxe", "bot at coords 100,64,-50"). Required — be specific.' }
        },
        perform: async function (agent, description, end_factor) {
            // Structural gate. Any task description implying >200 blocks /
            // items of work is rejected at the command layer — no matter
            // the source (planner, slash skill, reboot resume, manual op).
            // This is the last line of defense against the cramming pattern
            // that motivated this whole decomposition push.
            const { estimateTaskSize, SIZE_DECOMP_THRESHOLD } = await import('../classify_and_gate.js');
            const est = estimateTaskSize(description);
            if (est.blocks >= SIZE_DECOMP_THRESHOLD) {
                const chunks = Math.max(2, Math.ceil(est.blocks / SIZE_DECOMP_THRESHOLD));
                return `[task rejected] Description implies ~${est.blocks} blocks/items of work (signal: ${est.signal}). HARD LIMIT: ${SIZE_DECOMP_THRESHOLD} per task. Split into ≥${chunks} smaller !addTask calls (e.g. "rows 1-10 of floor", "rows 11-20 of floor", ...). Each must have its own observable end_factor.`;
            }
            // Deterministic metric target: if the player asked for "N MORE" (a
            // delta) but the end_factor was encoded as an absolute count, rewrite
            // it to "+N item" so the bot finishes at +N from where it started,
            // not at N total. Code owns the target, not the LLM's encoding.
            const { normalizeQuantityEndFactor } = await import('../verify.js');
            end_factor = normalizeQuantityEndFactor(end_factor, agent._lastPlayerMessage);
            return agent.task_queue.addTask(description, end_factor).message;
        }
    },
    {
        name: '!startTask',
        isConcurrencySafe: true,
        description: 'Mark a task as in-progress so you and the player know what you\'re working on. Omit id to start the next pending task.',
        params: {
            'id': { type: 'int', description: 'Task id to start, or -1 to start the next pending task.', domain: [-1, Number.MAX_SAFE_INTEGER] }
        },
        perform: async function (agent, id) {
            return agent.task_queue.startTask(id === -1 ? null : id).message;
        }
    },
    {
        name: '!finishTask',
        isConcurrencySafe: true,
        description: 'Mark in-progress task done. Id -1 = current. end_factor verified against bot state; blocked if criterion unmet.',
        params: {
            'id': { type: 'int', description: 'Task id to finish, or -1 to finish whatever is in progress.', domain: [-1, Number.MAX_SAFE_INTEGER] }
        },
        perform: async function (agent, id) {
            const queue = agent.task_queue;
            if (!queue) return 'No task queue available.';
            const taskId = id === -1 ? null : id;
            // Find the same task the queue would finish, then run the verifier
            // against the live bot state. Only block when the end_factor is
            // measurable AND demonstrably unmet — fuzzy criteria pass through.
            const target = taskId != null
                ? queue.tasks.find(t => t.id === Number(taskId))
                : queue.tasks.find(t => t.status === 'in_progress');
            if (target && target.status !== 'done') {
                try {
                    const v = verifyEndFactor(agent, target);
                    if (v && v.programmatic && v.verified === false) {
                        return `[verify] Task #${target.id} not finished — ${v.reason} Keep working, or use !cancelTask if the criterion no longer applies.`;
                    }
                    // Observability: record what the end_factor check saw at finish
                    // time so a 0-ops done can be told apart from a false-done.
                    console.log(`[finishTask] #${target.id} end_factor "${target.endFactor}" — ${v && v.programmatic ? `verified (${v.observed})` : 'honor-system (unmeasurable end_factor)'}`);
                } catch (e) {
                    console.warn('verifyEndFactor threw:', e?.message || e);
                }
            }
            return queue.finishTask(taskId).message;
        }
    },
    {
        name: '!cancelTask',
        isConcurrencySafe: true,
        description: 'Remove a task from your queue (e.g. when the player tells you to skip it).',
        params: {
            'id': { type: 'int', description: 'Task id to cancel.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: async function (agent, id) {
            return agent.task_queue.cancelTask(id).message;
        }
    },
    {
        name: '!showQueue',
        isReadOnly: true,
        isConcurrencySafe: true,
        description: 'Print current task queue to chat.',
        params: {},
        perform: async function (agent) {
            const text = agent.task_queue.formatForChat({ planMode: agent.planMode === true });
            agent.openChat(text);
            return text;
        }
    },
    {
        name: '!clearDoneTasks',
        isConcurrencySafe: true,
        description: 'Remove all completed tasks from your queue to keep it tidy.',
        params: {},
        perform: async function (agent) {
            return agent.task_queue.clearDone().message;
        }
    },
    {
        name: '!enterPlanMode',
        isConcurrencySafe: true,
        description: 'Enter plan mode (body commands blocked, queue/memory/observation OK). Propose plan via !addTask, wait for "ok"/!exitPlanMode.',
        params: {},
        perform: async function (agent) {
            const entered = agent.enterPlanMode();
            return entered
                ? '[planning] Plan mode on. Add steps with !addTask(description, end_factor), post the plan to chat, then wait for the player to say "ok"/"yes"/"go". On approval, call !exitPlanMode (or the auto-trigger will).'
                : '[planning] Already in plan mode.';
        }
    },
    {
        name: '!invokeSkill',
        isConcurrencySafe: true,
        description: 'Invoke meta-skill (stuck/loop/verify) by name. Use after consecutive primitive failures.',
        params: {
            'name': { type: 'string', description: 'Skill name to invoke (stuck, loop, verify).' }
        },
        perform: async function (agent, name) {
            return await agent.invokeMetaSkill(name);
        }
    },
    {
        name: '!dispatchAgent',
        isConcurrencySafe: true,
        description: 'Hand off scoped sub-task to a role subagent (miner/builder/navigator/scout). One at a time. Returns [subagent finished] summary on its !finishTask.',
        params: {
            'role': { type: 'string', description: 'Role name: miner, builder, navigator, or scout.' },
            'description': { type: 'string', description: 'What the subagent should do, in one sentence.' },
            'end_factor': { type: 'string', description: 'Observable completion criterion, same shape as !addTask end_factor.' }
        },
        perform: async function (agent, role, description, end_factor) {
            return await agent.dispatchSubagent(role, description, end_factor);
        }
    },
    {
        name: '!setSubagentSummary',
        isConcurrencySafe: true,
        description: '(subagent-only) Set summary text for the [subagent finished] message. Call before !finishTask.',
        params: {
            'summary': { type: 'string', description: 'One-line summary of what the subagent did.' }
        },
        perform: async function (agent, summary) {
            if (!agent.activeSubagent) return 'No subagent active — !setSubagentSummary only applies during a !dispatchAgent run.';
            agent.activeSubagent.summary = String(summary || '').slice(0, 240);
            return `Subagent summary set: "${agent.activeSubagent.summary}"`;
        }
    },
    {
        name: '!setSubagentResult',
        isConcurrencySafe: true,
        description: '(subagent-only) Mark task failed (cannot meet end_factor). Call !finishTask after.',
        params: {
            'result': { type: 'string', description: 'Either "success" or "failed". Default is "success" if !setSubagentResult is never called.' }
        },
        perform: async function (agent, result) {
            if (!agent.activeSubagent) return 'No subagent active.';
            const v = String(result || '').toLowerCase();
            if (v !== 'success' && v !== 'failed') return `Invalid result "${result}" — use "success" or "failed".`;
            agent.activeSubagent.result = v;
            return `Subagent result will be reported as: ${v}.`;
        }
    },
    {
        name: '!sendMessage',
        isConcurrencySafe: true,
        description: 'One-shot message to another bot on the same mindserver. No conversation, just a signal.',
        params: {
            'target_bot': { type: 'string', description: 'Name of the bot to message.' },
            'content': { type: 'string', description: 'The message to send.' }
        },
        perform: async function (agent, target_bot, content) {
            if (!convoManager.isOtherAgent(target_bot)) return `${target_bot} is not a bot on this server.`;
            try {
                convoManager.sendToBot(target_bot, String(content), false, false);
                return `Sent to ${target_bot}: ${String(content).slice(0, 120)}`;
            } catch (e) {
                return `Send failed: ${e?.message || e}`;
            }
        }
    },
    {
        name: '!exitPlanMode',
        isConcurrencySafe: true,
        description: 'Exit plan mode and start the queued plan. Use after player approval.',
        params: {},
        perform: async function (agent) {
            const exited = agent.exitPlanMode();
            if (!exited) return '[executing] Not in plan mode.';
            // Auto-start the next pending task so the player sees motion right
            // after approval — matches blueprint §C2/§C4 ("→ first task auto-starts").
            if (agent.task_queue) {
                try {
                    const start = agent.task_queue.startTask(null);
                    return `[executing] Plan mode off. ${start?.message || ''}`.trim();
                } catch (e) {
                    return `[executing] Plan mode off. (Queue auto-start failed: ${e?.message || e})`;
                }
            }
            return '[executing] Plan mode off.';
        }
    },
    {
        name: '!remember',
        isConcurrencySafe: true,
        description: 'Save persistent fact (survives reboots). For coords use !rememberHere. Index shown in the MEMORY INDEX section; details via !recall.',
        params: {
            'topic': { type: 'string', description: 'Short kebab-case slug (e.g. "lospollos929-prefs", "village-trading-tips", "lava-near-mining-tunnel"). Reused topic name = update.' },
            'content': { type: 'string', description: 'The fact, in markdown. First line is shown as the summary in the index. Max ~4KB.' }
        },
        perform: async function (agent, topic, content) {
            return agent.memory_store.write(topic, content).message;
        }
    },
    {
        name: '!recall',
        isReadOnly: true,
        isConcurrencySafe: true,
        description: 'Read full content of saved memory topic. Use when the MEMORY INDEX shows a relevant topic.',
        params: {
            'topic': { type: 'string', description: 'Topic slug from MEMORY.md (e.g. "lospollos929-prefs").' }
        },
        perform: async function (agent, topic) {
            return agent.memory_store.read(topic).message;
        }
    },
    {
        name: '!forget',
        isConcurrencySafe: true,
        description: 'Delete a saved memory topic. Use when a memory is wrong, outdated, or the player asks you to forget it.',
        params: {
            'topic': { type: 'string', description: 'Topic slug to delete.' }
        },
        perform: async function (agent, topic) {
            return agent.memory_store.remove(topic).message;
        }
    },
    {
        name: '!listMemory',
        isReadOnly: true,
        isConcurrencySafe: true,
        description: 'Chat the list of saved memory topics to the player. Use when asked what you remember.',
        params: {},
        perform: async function (agent) {
            const text = agent.memory_store.formatForChat();
            agent.openChat(text);
            return text;
        }
    },
    {
        name: '!loadCOCFromLectern',
        isConcurrencySafe: true,
        description: 'Read nearest lectern (within 8 blocks) and overwrite CLAUDE.md from its book.',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.loadCOCFromLectern(agent.bot, 8);
        })
    },
    {
        name: '!designateRulebookLectern',
        isConcurrencySafe: true,
        description: 'Mark nearest lectern (within 8 blocks) as rulebook; auto-updates CLAUDE.md when player edits the book.',
        params: {},
        perform: async function (agent) {
            const bot = agent.bot;
            const lecternId = bot.registry?.blocksByName?.lectern?.id;
            if (lecternId == null) return 'No lectern block id in registry.';
            const positions = bot.findBlocks({matching: lecternId, maxDistance: 8, count: 1});
            if (!positions || positions.length === 0) return 'No lectern within 8 blocks. Place one and stand near it.';
            const block = bot.blockAt(positions[0]);
            const res = agent.rulebook_lectern.designate(block);
            if (res.ok) {
                // read it once immediately so CLAUDE.md is in sync from the start
                try { await skills.loadCOCFromLectern(bot, 8, agent.rulebook_lectern.position); } catch {}
            }
            return res.message;
        }
    },
];
