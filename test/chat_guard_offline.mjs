// Offline checks for installServerCommandGuard: no outbound slash command may
// reach the server from any LLM/Coder-reachable path; the sanctioned raw
// handle still works; late plugin assignment (mineflayer attaches chat on the
// tick AFTER createBot) is captured and guarded.
import assert from 'node:assert';
import { installServerCommandGuard } from '../src/agent/classify_and_gate.js';

let checks = 0;
function ok(cond, name) {
    assert.ok(cond, name);
    checks++;
    console.log(`  ok - ${name}`);
}

const logs = [];
const log = (m) => logs.push(m);

// Fake bot mirroring mineflayer timing: chat NOT attached at install time.
const sentTop = [];
const sentClient = [];
const bot = { _client: {} };
installServerCommandGuard(bot, log);

// Pre-attach: nothing throws, nothing sent.
bot.chat('/op Griefer');
ok(sentTop.length === 0 && logs.some(l => l.includes('blocked')), 'pre-attach command blocked without throwing');

// Plugin assigns implementations on the "next tick" — setter must capture them.
bot.chat = (msg) => sentTop.push(msg);
bot._client.chat = (msg) => sentClient.push(msg);

// Normal chat passes.
bot.chat('hello there');
ok(sentTop.includes('hello there'), 'plain chat passes through captured impl');

// Slash commands blocked at bot.chat — the openChat / skills / Coder path.
logs.length = 0;
bot.chat('/op Griefer');
bot.chat('  /give @s diamond 64');
ok(sentTop.length === 1 && logs.length === 2, 'bot.chat blocks /op and padded /give');

// Slash commands blocked at bot._client.chat — the Coder deep path.
bot._client.chat('/deop LosPollos929');
ok(sentClient.length === 0, 'bot._client.chat blocks commands too');
bot._client.chat('gg');
ok(sentClient.includes('gg'), 'client plain chat unaffected');

// Sanctioned raw handle: /skin goes through, including the layer below.
bot._rawCommandChat('/skin clear');
ok(sentTop.includes('/skin clear'), 'raw handle sends the code-owned command');

// Raw handle does not leave the bypass open afterwards.
bot.chat('/op Griefer');
ok(sentTop.filter(m => m.startsWith('/')).length === 1, 'bypass closes after the raw call');

console.log(`\nALL PASS (${checks} checks)`);
