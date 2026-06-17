// Offline check for the real fix behind the bed/chest failures: when the owner
// re-designates a spot ("this bed/chest is yours"), the bot must DETERMINE the
// coordinate of the thing the owner is pointing at — the matching block nearest
// the OWNER, not nearest the bot — and OVERWRITE its remembered place with it,
// rather than keeping a stale memory or grabbing whatever's nearest itself.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/assign_place_offline.mjs
import assert from 'node:assert';
import Vec3 from 'vec3';
import { commandList } from '../src/agent/commands/index.js'; // via index to satisfy the load-order cycle
import { MemoryBank } from '../src/agent/memory_bank.js';

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };
const cmd = (name) => commandList.find(a => a.name === name);
const key = (p) => `${p.x},${p.y},${p.z}`;

function makeAgent({ blocks, botPos, ownerPos, sender = 'LosPollos929', preset = {} }) {
    const mb = new MemoryBank();
    for (const [k, v] of Object.entries(preset)) mb.rememberPlace(k, v[0], v[1], v[2]);
    const byPos = new Map(blocks.map(b => [key(b.pos), b]));
    return {
        last_sender: sender,
        memory_bank: mb,
        bot: {
            entity: { position: botPos },
            players: ownerPos ? { [sender]: { entity: { position: ownerPos } } } : {},
            findBlocks: ({ matching }) => blocks.filter(b => matching({ name: b.name })).map(b => b.pos),
            blockAt: (p) => (byPos.get(key(p)) ? { name: byPos.get(key(p)).name } : null),
        },
    };
}

// 1. Bed: owner points at the red bed (far from bot); overwrite the stale memory.
{
    const agent = makeAgent({
        botPos: new Vec3(0, 64, 0),
        ownerPos: new Vec3(10, 64, 10),
        blocks: [
            { name: 'black_bed', pos: new Vec3(1, 64, 0) },    // nearest the BOT
            { name: 'red_bed', pos: new Vec3(11, 64, 10) },    // nearest the OWNER
        ],
        preset: { bed: [99, 64, 99] },                          // stale assignment
    });
    const msg = cmd('!assignBed').perform(agent);
    assert.deepStrictEqual(agent.memory_bank.recallPlace('bed'), [11, 64, 10], msg);
    assert.ok(/red/i.test(msg), msg);
    ok('assignBed determines the bed nearest the OWNER (red) and overwrites stale memory');
}

// 2. Chest: owner stands on the new chest; overwrite the stale my-chest.
{
    const agent = makeAgent({
        botPos: new Vec3(0, 64, 0),
        ownerPos: new Vec3(20, 64, 20),
        blocks: [
            { name: 'chest', pos: new Vec3(2, 64, 0) },        // old, nearest the BOT
            { name: 'chest', pos: new Vec3(21, 64, 20) },      // new, nearest the OWNER
        ],
        preset: { 'my-chest': [2, 64, 0] },                     // stale = the old chest
    });
    const msg = cmd('!assignChest').perform(agent);
    assert.deepStrictEqual(agent.memory_bank.recallPlace('my-chest'), [21, 64, 20], msg);
    ok('assignChest determines the chest nearest the OWNER (new) and overwrites stale my-chest');
}

// 3. No owner tracked -> fall back to nearest-the-bot, but STILL overwrite.
{
    const agent = makeAgent({
        botPos: new Vec3(0, 64, 0),
        ownerPos: null,
        blocks: [{ name: 'white_bed', pos: new Vec3(3, 64, 0) }],
        preset: { bed: [99, 64, 99] },
    });
    const msg = cmd('!assignBed').perform(agent);
    assert.deepStrictEqual(agent.memory_bank.recallPlace('bed'), [3, 64, 0], msg);
    ok('assignBed falls back to nearest-the-bot when the owner is untracked, still overwrites');
}

// 4. 'bedrock' must NOT count as a bed (the old includes('bed') matched it).
{
    const agent = makeAgent({
        botPos: new Vec3(0, 64, 0),
        ownerPos: new Vec3(5, 64, 5),
        blocks: [
            { name: 'bedrock', pos: new Vec3(5, 63, 5) },      // closest to owner, but not a bed
            { name: 'red_bed', pos: new Vec3(6, 64, 5) },
        ],
    });
    const msg = cmd('!assignBed').perform(agent);
    assert.deepStrictEqual(agent.memory_bank.recallPlace('bed'), [6, 64, 5], msg);
    ok('assignBed ignores bedrock (endsWith _bed), picks the real bed');
}

// 5. Nothing to assign -> corrective, and memory is left untouched.
{
    const agent = makeAgent({
        botPos: new Vec3(0, 64, 0),
        ownerPos: new Vec3(5, 64, 5),
        blocks: [],
        preset: { bed: [7, 64, 7] },
    });
    const msg = cmd('!assignBed').perform(agent);
    assert.ok(/no bed nearby/i.test(msg), msg);
    assert.deepStrictEqual(agent.memory_bank.recallPlace('bed'), [7, 64, 7], msg);
    ok('assignBed with no bed nearby returns a corrective and leaves memory unchanged');
}

console.log(`\nALL PASS (${pass} checks)`);
