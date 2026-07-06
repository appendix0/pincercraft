// Per-episode flight recorder — one JSONL file per task, with the recording
// start/end managed by the task lifecycle (no manual control):
//
//   bots/<name>/episodes/<task_id>.jsonl
//     { type: 'episode_start', ts, task_id, description, end_factor, inventory }
//     { type: 'tool_call', ts, task_id, source, name, args, outcome, ms, result }
//     ...
//     { type: 'episode_end', ts, task_id, outcome, duration_ms, inventory }
//
// Tool calls with no active task (player-typed one-offs, idle chatter) land in
// episodes/adhoc.jsonl so nothing is ever dropped.
//
// Why it exists: bot.log records each LLM turn as "executing code..." without
// naming the call, and the v2 orchestrator's own history gets auto-compacted
// mid-task — so a finished task's middle steps were unrecoverable (2026-07-06
// iron-pickaxe run). Each episode file is a self-contained receipt: the ask,
// every command in order, and the start/end inventory delta.
//
// Same durability pattern as play_logger.js: synchronous append in-process,
// all failures swallowed — recording must never disturb the bot.
//
// Read one back with e.g.:
//   python3 -c "import json,sys; [print(json.dumps(json.loads(l))) for l in open('bots/Daedelus404/episodes/282.jsonl')]"

import fs from 'fs';
import path from 'path';
import * as world from './library/world.js';

const MAX_RESULT_CHARS = 300;

function activeTask(agent) {
    try {
        return (agent?.task_queue?.tasks || []).find(t => String(t.status).includes('progress')) ?? null;
    } catch { return null; }
}

function inventorySnapshot(agent) {
    try { return world.getInventoryCounts(agent.bot); } catch { return null; }
}

function append(agent, taskId, row) {
    try {
        const dir = path.resolve(`./bots/${agent.name}/episodes`);
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, `${taskId ?? 'adhoc'}.jsonl`), JSON.stringify(row) + '\n');
    } catch { /* never disturb the bot */ }
}

// Called from agent._onQueueChange on 'start' — opens the episode recording.
export function episodeStart(agent, task) {
    if (!task) return;
    append(agent, task.id, {
        type: 'episode_start',
        ts: new Date().toISOString(),
        task_id: task.id,
        description: task.description,
        end_factor: task.endFactor ?? null,
        inventory: inventorySnapshot(agent),
    });
}

// Called from agent._onQueueChange on 'finish'/'cancel' — closes the recording.
export function episodeEnd(agent, task, outcome) {
    if (!task) return;
    append(agent, task.id, {
        type: 'episode_end',
        ts: new Date().toISOString(),
        task_id: task.id,
        outcome, // 'done' | 'cancelled'
        duration_ms: Date.now() - (task.createdAt || Date.now()),
        inventory: inventorySnapshot(agent),
    });
}

// row: { source: 'llm'|'text', name, args, outcome: 'ok'|'error'|'blocked', ms, result }
export function traceToolCall(agent, { source, name, args, outcome, ms, result }) {
    const t = activeTask(agent);
    append(agent, t?.id ?? null, {
        type: 'tool_call',
        ts: new Date().toISOString(),
        task_id: t?.id ?? null,
        source,
        name,
        args: args ?? null,
        outcome,
        ms,
        result: result == null ? null : String(result).slice(0, MAX_RESULT_CHARS),
    });
}
