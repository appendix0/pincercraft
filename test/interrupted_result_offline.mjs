// Offline checks for interruptedAware: an interrupted action must return its
// accumulated output marked [interrupted] — never undefined, which the v2
// orchestrator rendered as a fake "<cmd> ok" (live: two 256-block "Could not
// find any..." results swallowed by the stuck-watchdog's self-unstick).
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/interrupted_result_offline.mjs
import assert from 'node:assert';
import * as mc from '../src/utils/mcdata.js';
// orchestrator (→ tool_registry → commands/index.js) must evaluate before
// actions.js or the commands/index ↔ actions circular import trips on
// actionsList — same order every other offline test uses implicitly.
import { OrchestratorV2 } from '../src/agent/orchestrator_v2.js';
import { interruptedAware } from '../src/agent/commands/actions.js';

mc.ensureMcData('1.21.11');

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

{
    const r = interruptedAware({ interrupted: true, timedout: false, message: 'Action output:\nCould not find any cobweb in 256 blocks.\n' });
    assert(r.startsWith('[interrupted] ') && r.includes('Could not find any cobweb in 256 blocks.'),
        `interrupted must keep the output, got ${JSON.stringify(r)}`);
    ok('interrupted + output → "[interrupted] <output>" (nothing swallowed)');

    assert(interruptedAware({ interrupted: true, timedout: false, message: '' })
        === '[interrupted] Action was interrupted before producing output.', 'empty output gets the placeholder');
    ok('interrupted + no output → honest placeholder, never undefined');

    assert(interruptedAware({ interrupted: false, timedout: false, message: 'Done.' }) === 'Done.', 'normal path unchanged');
    assert(interruptedAware({ interrupted: true, timedout: true, message: 'Timed out.' }) === 'Timed out.', 'timeout keeps its own message');
    ok('normal and timeout results pass through unchanged');
}

// The search-miss reflex must still fire on an [interrupted]-prefixed miss —
// the live case: search logged the miss, THEN the unstick interrupt killed it.
{
    const agent = {
        bot: { inventory: { items: () => [], get slots() { return []; } } },
        task_queue: {
            tasks: [{ id: 1, description: 'Get string', endFactor: '2 string in inventory', status: 'in_progress' }],
            demoteActive() { this.tasks[0].status = 'pending'; return this.tasks[0]; },
        },
        openChat: () => {},
    };
    const orch = new OrchestratorV2(agent, { promptWithTools: async () => ({}), getSystemPrompt: async () => '', registry: { byName: () => null } });
    const res = { id: 'x', name: 'searchForBlock', isError: false,
        content: '[interrupted] Action output:\nCould not find any cobweb in 256 blocks.\n' };
    orch._searchMissReflex(res);
    assert(agent.task_queue.tasks[0].status === 'pending' && orch._parkRequested, 'reflex must fire through the [interrupted] prefix');
    ok('search-miss reflex fires on an [interrupted]-prefixed wide miss');
}

console.log(`\ninterrupted_result_offline: ${pass} checks passed`);
