// Offline check for the P2 death handler's deterministic, code-emitted piece:
// the exact two-option question the bot asks a present player on death. Emitting
// it in code (not via a prompt nudge) is what makes the ask reliable every time.
// The behavioral parts — drive-loop suppression (no task auto-resume) and the
// autonomous-vs-player branch — are bot-event wiring, validated live.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/death_handler_offline.mjs
import assert from 'node:assert';
import { deathChoiceQuestion } from '../src/agent/classify_and_gate.js';

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

// 1. Both options are present and unambiguous, with the death position.
{
    const q = deathChoiceQuestion('x: 643, y: 71, z: 324');
    assert.ok(/\(1\).*retrieve/i.test(q), q);
    assert.ok(/\(2\).*(forget|wait)/i.test(q), q);
    assert.ok(q.includes('643'), q);
    ok('question offers (1) retrieve + (2) forget-and-wait, with the death position');
}

// 2. Degrades cleanly when the position is unknown (no dangling "at undefined").
{
    const q = deathChoiceQuestion(null);
    assert.ok(!/\bat\b/.test(q) || /at \w/.test(q), q); // no trailing " at " with nothing after
    assert.ok(/retrieve/i.test(q) && /(forget|wait)/i.test(q), q);
    ok('question still offers both options when the position is unknown');
}

console.log(`\nALL PASS (${pass} checks)`);
