// Offline checks for the per-layer ablation switch. This logic decides what
// each B arm of the campaign actually measures: if a flag silently fails to
// take, the arm looks like a null result rather than a broken run, and nothing
// downstream would catch it (docs/paper/preregistration.md §4).
//
// Runs in a temp cwd, never against the live .runtime — a leaked harness_off
// flag would ablate the real bot.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/harness_layers_offline.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-layers-'));
fs.mkdirSync(path.join(tmp, '.runtime'));
process.chdir(tmp);

const { layerOn, LAYERS } = await import('../src/agent/harness_mode.js');

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };
const flag = (name) => fs.writeFileSync(path.join(tmp, '.runtime', name), '');
const clear = () => {
    for (const f of fs.readdirSync(path.join(tmp, '.runtime'))) {
        fs.rmSync(path.join(tmp, '.runtime', f));
    }
};

// 1. No flags: the shipped configuration. Every layer on.
{
    clear();
    for (const l of LAYERS) assert.strictEqual(layerOn(l), true, l);
    ok('no flags -> every layer on (the A-ON arm)');
}

// 2. harness_off ablates everything — the A-OFF arm keeps working unchanged
//    now that the coarse switch is expressed through layerOn.
{
    clear();
    flag('harness_off');
    for (const l of LAYERS) assert.strictEqual(layerOn(l), false, l);
    ok('harness_off -> every layer off (the A-OFF arm)');
}

// 3. A per-layer flag ablates ONLY that layer. This is the whole point of the
//    B arms: bleed into a neighbouring layer and the attribution is wrong.
for (const target of LAYERS) {
    clear();
    flag(`harness_off_${target}`);
    assert.strictEqual(layerOn(target), false, `${target} should be off`);
    for (const other of LAYERS.filter(l => l !== target)) {
        assert.strictEqual(layerOn(other), true, `${other} should stay on while ${target} is off`);
    }
}
ok('each harness_off_<layer> ablates that layer alone, leaving the others on');

// 3b. The `measurement` compound. Seeds 1-2 ran it as a single layer; it is now
//     verify + autofinish. The flag must still ablate BOTH, or the published
//     seeds-1-2 arm is no longer reproducible from this code — and, worse, it
//     would read as fully-ON and report an ablation that never happened.
{
    clear();
    flag('harness_off_measurement');
    assert.strictEqual(layerOn('verify'), false, 'verify should be off');
    assert.strictEqual(layerOn('autofinish'), false, 'autofinish should be off');
    for (const other of ['perception', 'gates', 'reflexes']) {
        assert.strictEqual(layerOn(other), true, `${other} should stay on`);
    }
    ok('harness_off_measurement ablates verify+autofinish only (seeds 1-2 reproducible)');
}

// 3c. The halves are independently ablatable — the entire point of the split.
{
    clear();
    flag('harness_off_verify');
    assert.strictEqual(layerOn('verify'), false);
    assert.strictEqual(layerOn('autofinish'), true, 'autofinish must survive a verify ablation');
    clear();
    flag('harness_off_autofinish');
    assert.strictEqual(layerOn('autofinish'), false);
    assert.strictEqual(layerOn('verify'), true, 'verify must survive an autofinish ablation');
    ok('verify and autofinish ablate independently');
}

// 4. Global ablation beats a per-layer flag rather than the two interacting.
{
    clear();
    flag('harness_off');
    flag('harness_off_gates');
    for (const l of LAYERS) assert.strictEqual(layerOn(l), false, l);
    ok('harness_off wins when combined with a per-layer flag');
}

// 5. A misspelled layer throws. Returning "on" would quietly run an arm with
//    nothing ablated and report it as a null result — the expensive failure.
{
    clear();
    assert.throws(() => layerOn('measurment'), /unknown harness layer/);
    assert.throws(() => layerOn('referee'), /unknown harness layer/);
    // `measurement` is a valid FLAG but no longer a layer: code asking whether
    // it is on is code that missed the split.
    assert.throws(() => layerOn('measurement'), /unknown harness layer/);
    ok('unknown layer name throws (a typo must not silently disable an ablation)');
}

// 6. The referee is not a layer. It scores every arm from outside the bot, so
//    it must not be reachable through the ablation switch at all.
{
    assert.ok(!LAYERS.includes('referee'), 'referee must not be an ablatable layer');
    ok('referee is not in LAYERS — the scorer is never ablated');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} checks passed`);
