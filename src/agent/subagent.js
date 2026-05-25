// Phase G1+G2: subagent runtime. !dispatchAgent(role, task_description,
// end_factor) routes a focused unit of work to a role-specific subagent.
// The "subagent" runs in the same process — there's no real fork; what
// changes is the system-prompt overlay the planner sees and (Phase G3) the
// model it's routed to. The role's tight, narrow prompt biases the LLM
// toward staying inside its lane (mine / build / navigate / scout).
//
// Lifecycle:
//   1. !dispatchAgent loads the role profile from profiles/roles/<role>.json,
//      sets agent.activeSubagent = { role, taskId, prompt, model, startedAt },
//      queues the task + auto-starts it. The role's system_prompt is
//      injected into history as a system message so the LLM internalizes it.
//   2. The bot works through the task using the role's mindset.
//   3. When !finishTask is called on the subagent's task, finalizeSubagent()
//      clears activeSubagent and posts a [subagent finished] system message
//      with role + result + summary (Phase G4 wires the structured payload).
//   4. Concurrent dispatch is rejected — one subagent at a time.

import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import settings from '../../settings.js';

const ROLE_DIR = path.resolve(process.cwd(), 'profiles/roles');
const ROLE_CACHE = new Map();

export function loadRoleProfile(role) {
    const r = String(role || '').toLowerCase();
    if (ROLE_CACHE.has(r)) return ROLE_CACHE.get(r);
    const file = path.join(ROLE_DIR, `${r}.json`);
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
        throw new Error(`Role profile not found or invalid: ${file} (${e?.message || e})`);
    }
    ROLE_CACHE.set(r, parsed);
    return parsed;
}

export function listRoles() {
    try {
        return readdirSync(ROLE_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => f.slice(0, -5));
    } catch {
        return ['miner', 'builder', 'navigator', 'scout'];
    }
}

// Dispatch entry point used by !dispatchAgent. Returns the chat-bound
// result string the command surfaces back to the LLM.
export async function dispatchSubagent(agent, role, description, endFactor) {
    if (agent.activeSubagent) {
        return `[dispatch rejected] subagent already active (role=${agent.activeSubagent.role}, task #${agent.activeSubagent.taskId}). Wait for it to !finishTask before dispatching another.`;
    }
    let profile;
    try {
        profile = loadRoleProfile(role);
    } catch (e) {
        return `[dispatch rejected] ${e.message}`;
    }
    if (!agent.task_queue) return '[dispatch rejected] no task_queue on agent.';
    const add = agent.task_queue.addTask(description, endFactor);
    // TaskQueue.addTask returns { ok, message, task? } in the existing code —
    // we tolerate either shape since older callsites just read .message.
    const taskId = add?.task?.id ?? (() => {
        // Best-effort: pull the just-queued task by description match.
        const pending = agent.task_queue.tasks.filter(t => t.status === 'pending');
        return pending.length ? pending[pending.length - 1].id : null;
    })();
    if (taskId == null) return `[dispatch rejected] couldn't queue task: ${add?.message || 'unknown error'}`;
    agent.activeSubagent = {
        role: profile.role || String(role).toLowerCase(),
        taskId,
        model: profile.model || null,
        systemPrompt: profile.system_prompt || '',
        startedAt: Date.now(),
        inventorySnapshot: snapshotInventory(agent),
        positionSnapshot: snapshotPosition(agent),
        // v2 Step 6: when use_subagent_isolation is on, the orchestrator's
        // activeTools() narrows the tool surface to the role's tools_filter.
        // Without the flag this field is ignored and the subagent sees the
        // full registry (legacy behavior).
        toolsFilter: settings.use_subagent_isolation ? (profile.tools_filter || null) : null,
    };
    // Inject the role prompt + dispatch marker as system messages so the
    // very next LLM turn enters the role's mindset.
    try {
        await agent.history.add('system', `[subagent dispatched] role=${agent.activeSubagent.role}, task #${taskId}, end_factor="${endFactor}". You now operate as the role described below. Stay inside its lane — when end_factor is met, !invokeSkill("verify") then !finishTask to return control to the planner.`);
        if (agent.activeSubagent.systemPrompt) {
            await agent.history.add('system', agent.activeSubagent.systemPrompt);
        }
    } catch (e) {
        console.warn('subagent prompt injection failed:', e?.message || e);
    }
    // Auto-start the queued task so the role gets to work immediately.
    try { agent.task_queue.startTask(taskId); } catch (e) {
        console.warn('subagent auto-start failed:', e?.message || e);
    }
    return `[subagent dispatched] role=${agent.activeSubagent.role}, task #${taskId} started. End_factor: ${endFactor}`;
}

// Called by TaskQueue / !finishTask hook when the subagent's task closes.
// Returns the [subagent finished] system message to inject into history so
// the planner sees the result on its next turn.
export function finalizeSubagent(agent, completedTaskId, { success = true, summary = '' } = {}) {
    const sub = agent.activeSubagent;
    if (!sub || sub.taskId !== completedTaskId) return null;
    // Phase G4: prefer the subagent's own summary (set via !setSubagentSummary)
    // over the caller-supplied one over '(none)'. The result field can also be
    // explicitly set by the LLM via !setSubagentResult before !finishTask.
    const finalSummary = sub.summary || summary || '(none)';
    const finalSuccess = (sub.result === 'failed') ? false : success;
    const result = finalSuccess ? 'success' : 'failed';
    const elapsedSec = Math.round((Date.now() - sub.startedAt) / 1000);
    const deltas = inventoryDelta(sub.inventorySnapshot, snapshotInventory(agent));
    const deltaStr = deltas.length ? deltas.map(d => `${d.delta > 0 ? '+' : ''}${d.delta} ${d.name}`).join(', ') : 'no inventory change';
    const pos = snapshotPosition(agent);
    const role = sub.role;
    agent.activeSubagent = null;
    return `[subagent finished] role=${role} result=${result} elapsed=${elapsedSec}s inventory_delta=[${deltaStr}] position=${pos ? `(${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)})` : '?'} summary="${finalSummary.replace(/"/g, '\\"')}"`;
}

function snapshotInventory(agent) {
    const map = {};
    try {
        const items = agent.bot?.inventory?.items?.() || [];
        for (const it of items) map[it.name] = (map[it.name] || 0) + it.count;
    } catch {}
    return map;
}

function snapshotPosition(agent) {
    try {
        const p = agent.bot?.entity?.position;
        if (!p) return null;
        return { x: p.x, y: p.y, z: p.z };
    } catch { return null; }
}

function inventoryDelta(before, after) {
    const names = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    const out = [];
    for (const n of names) {
        const delta = (after?.[n] || 0) - (before?.[n] || 0);
        if (delta !== 0) out.push({ name: n, delta });
    }
    return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}
