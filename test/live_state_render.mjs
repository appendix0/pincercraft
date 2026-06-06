// Render smoke test: exercises the full buildLiveStateBlock with a mock bot, so
// the assembled structure is visible without connecting to a server.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/live_state_render.mjs
import * as mc from '../src/utils/mcdata.js';
import { InventoryManager } from '../src/agent/inventory_manager.js';
import { buildLiveStateBlock } from '../src/agent/live_state.js';

mc.ensureMcData('1.21.11');

const pos = { x: 656.4, y: 36, z: 361.4, distanceTo: () => 5 };
const slot = (name, count) => ({ name, count });
const slots = [];
slots[9] = slot('oak_log', 4);
slots[10] = slot('stick', 2);
slots[11] = slot('crafting_table', 1);

const bot = {
    entity: { position: pos },
    health: 14, food: 8,
    time: { timeOfDay: 13000 }, // Night
    heldItem: null,
    inventory: { slots, emptySlotCount: () => 33, items: () => slots.filter(Boolean) },
    entities: {},
    world: { getBiome: () => 1 },
    findBlocks: () => [],
};

const agent = {
    bot,
    isIdle: () => true,
    actions: { currentActionLabel: 'Idle' },
    task_queue: { tasks: [{ id: 230, status: 'in_progress',
        description: 'make iron pickaxe', endFactor: 'iron_pickaxe in inventory' }] },
};
agent.inventory_manager = new InventoryManager(agent);

console.log('----- rendered dynamic block (uncached, every turn) -----');
console.log(buildLiveStateBlock(agent));
console.log('--------------------------------------------------------');
