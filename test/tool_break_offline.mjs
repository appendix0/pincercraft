// Offline checks for the tool_break_guard deterministic reflex predicate.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/tool_break_offline.mjs
import assert from 'node:assert';
import { pickaxeJustBrokeMining } from '../src/agent/modes.js';

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

// The one case it MUST fire: last pickaxe vanished right after a dig, mid-action.
assert(pickaxeJustBrokeMining({ hadPickaxe: true, pickaxeCount: 0, msSinceDig: 200, idle: false }) === true);
ok('fires: last pickaxe broke while mining');

// Spare pickaxe still held → not a break (count only hits 0 on the last one).
assert(pickaxeJustBrokeMining({ hadPickaxe: true, pickaxeCount: 1, msSinceDig: 200, idle: false }) === false);
ok('no fire: a spare pickaxe remains');

// Gave/deposited the pickaxe (no recent dig) → not a break. The key false-positive guard.
assert(pickaxeJustBrokeMining({ hadPickaxe: true, pickaxeCount: 0, msSinceDig: 5000, idle: false }) === false);
ok('no fire: pickaxe left inventory but no recent dig (give/deposit, not break)');

// Idle (not in an action) → don't interrupt nothing.
assert(pickaxeJustBrokeMining({ hadPickaxe: true, pickaxeCount: 0, msSinceDig: 200, idle: true }) === false);
ok('no fire: bot is idle');

// Never had a pickaxe this run → nothing broke.
assert(pickaxeJustBrokeMining({ hadPickaxe: false, pickaxeCount: 0, msSinceDig: 200, idle: false }) === false);
ok('no fire: never held a pickaxe (nothing to break)');

console.log(`\nALL PASS (${pass} checks)`);
