// Offline check for read-on-write memory dedup (MemoryStore.write surfacing
// overlapping topics). The bot was accumulating contradictory facts — e.g. two
// "chest" memories with disagreeing coords — because write() never showed the
// model the related existing topics. Now it does, deterministically, and the
// model reconciles. Key subtlety: nearly every slug starts with the owner name
// ("lospollos929-"), so a naive overlap matches everything; a document-frequency
// filter drops tokens common to >half the topics. This test pins both.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/memory_dedup_offline.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import { MemoryStore } from '../src/agent/memory_store.js';

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

const TEST_AGENT = '__test_dedup__';
const TEST_DIR = `./bots/${TEST_AGENT}`;
fs.rmSync(TEST_DIR, { recursive: true, force: true });

try {
    const store = new MemoryStore(TEST_AGENT);

    // A realistic corpus: chest topics are a MINORITY (so DF keeps "chest"
    // distinctive), and the owner name "lospollos929" is on most slugs (so DF
    // must drop it). Mirrors the real Daedelus404 memory shape.
    const seed = {
        'lospollos929-personal-chest': "Daedelus404's personal chest at LosPollos929's base, located at x:643, y:71, z:324.",
        'lospollos929-personal-chest-contents': 'The chest at x:643, y:71, z:323 is a general storage chest with spare tools.',
        'crafting-area': 'Crafting area at the new base. Contains a chest, crafting table, and furnace.',
        'lospollos929-prefs': 'LosPollos929 prefers diamond tools over iron tools.',
        'lospollos929-water-avoidance': 'LosPollos929 told me NOT to go in water. Avoid water blocks.',
        'lospollos929-wheat-harvest': 'Always break ripe wheat to get wheat when asked.',
        'lospollos929-tp-op': 'LosPollos929 gave me OP and wants me to use teleport.',
        'lospollos929-bed-location': 'LosPollos929 designated a bed in front of them as my sleeping spot.',
        'lospollos929-staple-kit': 'Always carry iron_axe, iron_pickaxe, iron_sword, 20 coal, 10 food.',
        'warehouse-site': 'Warehouse construction site at x:676, y:68, z:297. A big cobblestone floor.',
    };
    for (const [topic, content] of Object.entries(seed)) {
        const r = store.write(topic, content);
        assert.ok(r.ok, r.message);
    }

    // 1. Writing a NEW chest memory surfaces the other chest topics — and ONLY those.
    {
        const r = store.write('my-storage-chest', 'A chest I use for general storage over at the base.');
        assert.ok(r.ok, r.message);
        const rel = new Set(r.related);
        assert.ok(rel.has('lospollos929-personal-chest'), `expected personal-chest, got ${[...rel]}`);
        assert.ok(rel.has('lospollos929-personal-chest-contents'), `expected chest-contents, got ${[...rel]}`);
        assert.ok(rel.has('crafting-area'), `expected crafting-area (has a chest), got ${[...rel]}`);
        assert.ok(!rel.has('lospollos929-prefs') && !rel.has('lospollos929-water-avoidance'),
            `unrelated topics leaked in: ${[...rel]}`);
        assert.ok(/may overlap existing memories/i.test(r.message) && /ask the player/i.test(r.message), r.message);
        ok('new chest memory surfaces the chest cluster (incl. crafting-area), excludes unrelated topics');
    }

    // 2. The ubiquitous owner-name token alone must NOT match everything.
    {
        const r = store.write('lospollos929-greeting', 'LosPollos929 likes a friendly hello back.');
        assert.deepStrictEqual(r.related, [],
            `owner-name token over-matched — surfaced ${JSON.stringify(r.related)}`);
        assert.ok(!/may overlap/i.test(r.message), r.message);
        ok('shared owner-name prefix (lospollos929) does NOT trigger false overlaps (DF filter works)');
    }

    // 3. A genuinely unrelated topic surfaces nothing — clean save, no warning.
    {
        const r = store.write('lava-tunnel-hazard', 'Lava pocket beside the deep mining tunnel around y 11.');
        assert.deepStrictEqual(r.related, [], `unexpected overlaps: ${JSON.stringify(r.related)}`);
        assert.ok(/^Saved memory/.test(r.message) && !/⚠/.test(r.message), r.message);
        ok('unrelated new topic surfaces nothing — clean save, no warning');
    }

    // 4. Updating an existing topic still flags overlap with the OTHER chest topics.
    {
        const r = store.write('lospollos929-personal-chest', 'Personal chest moved — now x:644, y:71, z:324. Holds the spare chest tools.');
        assert.ok(r.ok && r.related.includes('lospollos929-personal-chest-contents'),
            `update should still flag the sibling chest topic; got ${JSON.stringify(r.related)}`);
        assert.ok(!r.related.includes('lospollos929-personal-chest'), 'must not flag itself');
        ok('updating a topic still surfaces overlapping siblings (and never itself)');
    }

    console.log(`\nALL PASS (${pass} checks)`);
} finally {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
