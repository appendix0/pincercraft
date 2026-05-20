// v2 Step 2 — Smoke test for tool_registry. Run: node scripts/test_tool_registry.js

import { getRegistry, jsonSchemaFor, isLongRunning } from '../src/agent/tool_registry.js';

let failures = 0;
function assert(cond, label, info) {
    if (cond) {
        console.log(`  ✓ ${label}`);
    } else {
        console.log(`  ✗ ${label}`, info ?? '');
        failures++;
    }
}

const reg = getRegistry();

// 1. Registry built without crashing, contains expected counts
console.log('test_registry_count');
const all = reg.all();
assert(all.length >= 40 && all.length <= 70, `total commands in expected range (got ${all.length})`);
const forLLM = reg.forLLM([]);
assert(forLLM.length <= all.length, `forLLM ≤ total (${forLLM.length} ≤ ${all.length})`);

// 2. Pruned commands really gone
console.log('test_pruned');
const goneNames = ['!stfu', '!restart', '!clearChat', '!goal', '!endGoal', '!lookAtPosition',
                   '!checkBlueprint', '!checkBlueprintLevel', '!getBlueprint', '!getBlueprintLevel'];
for (const n of goneNames) {
    assert(reg.byName(n) === undefined, `${n} removed`);
}

// 3. Critical commands still present
console.log('test_critical');
const keep = ['!newAction', '!collectBlocks', '!goToCoordinates', '!stats', '!inventory',
              '!addTask', '!finishTask', '!cancelTask', '!showQueue',
              '!remember', '!recall', '!enterPlanMode', '!exitPlanMode',
              '!dispatchAgent', '!invokeSkill', '!loadCOCFromLectern', '!designateRulebookLectern'];
for (const n of keep) {
    assert(reg.byName(n) !== undefined, `${n} kept`);
}

// 4. byName accepts both '!cmd' and 'cmd'
console.log('test_byname_strip');
assert(reg.byName('inventory') === reg.byName('!inventory'), 'strip prefix lookup matches');

// 5. isLongRunning derived for runAsAction-wrapped perform
console.log('test_is_long_running');
const collectBlocks = reg.byName('!collectBlocks');
assert(isLongRunning(collectBlocks), '!collectBlocks long-running (runAsAction wrapped)');
const inv = reg.byName('!inventory');
assert(!isLongRunning(inv), '!inventory NOT long-running (sync query)');
const addTask = reg.byName('!addTask');
assert(!isLongRunning(addTask), '!addTask NOT long-running (sync queue mutation)');

// 6. JSON Schema generation
console.log('test_json_schema');
const schema = jsonSchemaFor(collectBlocks);
assert(schema.type === 'object', 'object root');
assert(Array.isArray(schema.required), 'required array');
assert(schema.required.includes('type'), 'type required');
assert(schema.required.includes('num'), 'num required');
assert(schema.properties.type.type === 'string', 'type is string (BlockName degrades)');
assert(schema.properties.num.type === 'integer', 'num is integer');
assert(schema.properties.num.minimum === 1, 'num has minimum 1 from domain');
// num's domain upper is MAX_SAFE_INTEGER → should NOT emit a maximum
assert(schema.properties.num.maximum === undefined, 'num skips infinite maximum');
assert(schema.additionalProperties === false, 'additionalProperties false');

// 7. forLLM skips internal:true entries (none today, but smoke the filter)
console.log('test_internal_filter');
let beforeInternal = reg.forLLM([]).length;
const inv2 = reg.byName('!inventory');
inv2.internal = true;
let afterInternal = reg.forLLM([]).length;
assert(afterInternal === beforeInternal - 1, `internal filter removes 1 (was ${beforeInternal}, now ${afterInternal})`);
delete inv2.internal;

// 8. forLLM honors blockedNames
console.log('test_blocked_filter');
const beforeBlocked = reg.forLLM([]).length;
const afterBlocked = reg.forLLM(['!stats', '!inventory']).length;
assert(afterBlocked === beforeBlocked - 2, `blocked filter removes 2 (was ${beforeBlocked}, now ${afterBlocked})`);

// 9. forPlanMode filters to read-only OR concurrency-safe only
console.log('test_plan_mode_filter');
const planMode = reg.forPlanMode([]);
const allBodyTouching = planMode.every(c => c.isReadOnly === true || c.isConcurrencySafe === true);
assert(allBodyTouching, 'plan mode = readOnly || concurrencySafe only');
assert(planMode.length < reg.all().length, `plan mode subset is smaller (${planMode.length} < ${reg.all().length})`);

// 10. Tool descriptors are LLM-ready
console.log('test_tool_descriptors');
const descs = reg.toolDescriptorsForLLM([]);
assert(descs.length === reg.forLLM([]).length, 'descriptor count matches forLLM');
const collectDesc = descs.find(d => d.name === 'collectBlocks');
assert(collectDesc !== undefined, 'collectBlocks descriptor present');
assert(collectDesc.name === 'collectBlocks', 'name stripped of !');
assert(collectDesc.isLongRunning === true, 'isLongRunning surfaced in descriptor');
assert(collectDesc.input_schema?.type === 'object', 'schema attached');
assert(collectDesc._raw !== undefined, '_raw back-reference present');

if (failures > 0) {
    console.log(`\nFAIL — ${failures} assertion(s) failed`);
    process.exit(1);
}
console.log('\nPASS — all registry tests green');
process.exit(0);
