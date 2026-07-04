// Offline guard against prompt-assembly bloat (found 2026-07-04).
//
// Two failure classes this pins:
//  1. replaceAll duplication — a payload placeholder ($WORLD_KNOWLEDGE, $MEMORY,
//     $COC, …) mentioned a SECOND time in rule prose injects the whole payload
//     again. knowledge.md was going in 3x (~13KB of duplicate static prompt).
//  2. Tokens inside injected FILES — knowledge.md saying "$INVENTORY" pulled
//     the live inventory dump into the static cache_control block (knowledge is
//     substituted before $STATS/$INVENTORY processing), making the "static"
//     prefix byte-different every turn: the prompt cache never hit.
// Prose that refers to an injected section must name it in plain words
// ("see WORLD KNOWLEDGE"), never by its $TOKEN.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/prompt_hygiene_offline.mjs
import assert from 'node:assert';
import fs from 'node:fs';

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

// $NAME legitimately repeats; every other placeholder is a one-shot payload.
const REPEATABLE = new Set(['$NAME']);

// The profiles the bot actually loads (individual + _default fill-in; the
// assistant base profile only sets modes).
const PROFILES = ['profiles/daedelus404.claude.json', 'profiles/defaults/_default.json'];
const TEMPLATE_KEYS = ['conversing', 'coding', 'saving_memory', 'bot_responder', 'image_analysis'];

for (const file of PROFILES) {
    const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of TEMPLATE_KEYS) {
        if (!profile[key]) continue;
        const counts = {};
        for (const t of profile[key].match(/\$[A-Z_]+/g) || []) counts[t] = (counts[t] || 0) + 1;
        const dups = Object.entries(counts).filter(([t, c]) => c > 1 && !REPEATABLE.has(t));
        assert.deepStrictEqual(dups, [], `${file} ${key}: payload placeholder repeated — ${JSON.stringify(dups)}`);
    }
    ok(`${file}: no repeated payload placeholders`);
}

// Files whose CONTENT is substituted into the prompt must not contain
// placeholder tokens themselves — they'd be expanded into the static block.
for (const file of ['bots/knowledge.md', 'CLAUDE.md']) {
    const tokens = fs.readFileSync(file, 'utf8').match(/\$[A-Z_]+/g) || [];
    assert.deepStrictEqual(tokens, [], `${file} contains placeholder tokens: ${tokens.join(', ')}`);
    ok(`${file}: no placeholder tokens in injected content`);
}

console.log(`\nprompt_hygiene_offline: ${pass} checks passed`);
