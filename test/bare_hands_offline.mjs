// Offline checks for wantsBareHands — the deterministic "unarmed attack" detector
// behind the pickaxe-genocide fix (bot used an iron_pickaxe to kill llamas/a
// merchant despite "use your bare hands"). attackEntity reads a window set from
// this so it unequips instead of equipHighestAttack — for !attack and custom code.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/bare_hands_offline.mjs
import assert from 'node:assert';
import { wantsBareHands } from '../src/agent/classify_and_gate.js';

let pass = 0;
const ok = (l) => { console.log('  ok -', l); pass++; };

// Positives — the orders that must trigger an unarmed attack.
for (const m of [
    'another one! kill this wierd merchant too. use your bare hands to kill them',
    'kill it with your bare hands',
    'barehanded only',
    'punch them to death',
    'use your fists',
    'kill it unarmed',
    'no weapon, just hit it',
    'kill the cow without a weapon',
]) assert.strictEqual(wantsBareHands(m), true, m);
ok('bare hands / fists / punch / unarmed / no weapon → true');

// Negatives — normal kill orders keep a weapon; don't over-match.
for (const m of [
    'kill the lama!!!',
    'attack the zombie',
    'use your sword on it',
    'mine 30 raw iron',
    'give them to me',
    '',
    null,
]) assert.strictEqual(wantsBareHands(m), false, String(m));
ok('plain kill orders / unrelated / empty → false (no over-match)');

console.log(`\nALL PASS (${pass} checks)`);
