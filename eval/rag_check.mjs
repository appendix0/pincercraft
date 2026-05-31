#!/usr/bin/env node
// Backtest stick for the coder's skill-doc retriever (word-overlap path).
// Verifies the RIGHT docs surface per task FAMILY — not just the hardcoded
// always-show set. Deterministic, no live bot, no embedding model.
//   run: ~/.nvm/versions/node/v20.20.2/bin/node eval/rag_check.mjs
import { SkillLibrary } from '../src/agent/library/skill_library.js';

const lib = new SkillLibrary(null, null); // no agent, no embedding model -> word-overlap path
await lib.initSkillLibrary();

const tasks = [
    'mine 5 stone with a pickaxe',
    'chop down oak logs',
    'craft a stone pickaxe',
    'smelt 5 raw iron into iron ingots',
    'build a 3x3 cobblestone platform',
    'go to coordinates 100 64 -50',
    'attack the nearest zombie',
    'collect dirt from the surface',
];

for (const t of tasks) {
    console.log(`\n=== TASK: ${t} ===`);
    await lib.getRelevantSkillDocs(t, 5); // logs "Selected skill docs: [...]"
}
