// v2 Step 6 — Subagent context isolation + child task queue.
//
// Today's subagent.js shares the parent's history + task_queue. That's
// the confabulation source called out in the 2026-05-20 diagnosis (a
// !recall on parent context bleeds into subagent reasoning).
//
// v2 design (per docs/agent-blueprint.md §3 Step 6 rev-2 + user decision
// on the child task queue running in background):
//
//   - Subagent gets an EPHEMERAL TaskQueue scoped to the dispatch.
//     persist=false so tasks.json + queue.log untouched. Parent's
//     queue is unmodified; planner sees only the parent task.
//   - Subagent gets a FRESH history array. No parent $MEMORY view,
//     no parent task queue text, no parent conversation history.
//   - Subagent's tool surface filtered by role.tools_filter (glob
//     patterns against tool names — e.g. miner: ['mine*', 'goTo*',
//     'inventory*', 'invokeSkill', 'finishTask']).
//   - On finalize: roll up summary + inventory delta + position into
//     ONE tool_result that the parent dispatcher threads into the
//     parent's history.
//   - Shared (no choice): bot body, Mineflayer instance, persistent
//     $MEMORY files on disk, in-game world state.
//
// This module exports the helpers; the orchestrator integration phase
// wires them into the dispatch flow. The existing src/agent/subagent.js
// remains the active dispatcher today; v2 swaps in when
// use_subagent_isolation is on AND the orchestrator is live.

import { readFileSync } from 'fs';
import path from 'path';
import { TaskQueue } from './task_queue.js';

const ROLE_DIR = path.resolve(process.cwd(), 'profiles/roles');
const ROLE_CACHE = new Map();

export function loadRoleProfile(role) {
    const r = String(role || '').toLowerCase();
    if (ROLE_CACHE.has(r)) return ROLE_CACHE.get(r);
    const file = path.join(ROLE_DIR, `${r}.json`);
    let parsed;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { throw new Error(`Role profile not found or invalid: ${file} (${e?.message || e})`); }
    ROLE_CACHE.set(r, parsed);
    return parsed;
}

// Glob matcher for tools_filter. Supports:
//   '*'           — match anything (whole-tool wildcard)
//   'prefix*'     — prefix match (e.g. 'mine*' matches 'mineBlocks', 'mineMany')
//   'literal'     — exact match (e.g. 'finishTask')
// Returns true if any pattern matches. Empty / missing patterns → match all
// (no filter applied, all tools available).
export function matchesToolFilter(toolName, patterns) {
    if (!Array.isArray(patterns) || patterns.length === 0) return true;
    const name = String(toolName || '');
    for (const p of patterns) {
        if (typeof p !== 'string' || p.length === 0) continue;
        if (p === '*') return true;
        if (p.endsWith('*')) {
            const prefix = p.slice(0, -1);
            if (name.startsWith(prefix)) return true;
        } else if (p === name) {
            return true;
        }
    }
    return false;
}

// Filter a list of tool descriptors (from tool_registry.toolDescriptorsForLLM)
// down to those allowed by the role's tools_filter.
export function filterDescriptorsByRole(descriptors, role) {
    const patterns = role?.tools_filter;
    if (!Array.isArray(patterns) || patterns.length === 0) return descriptors;
    return descriptors.filter(d => matchesToolFilter(d.name, patterns));
}

// Snapshot helpers for diff reporting. Tolerate missing bot (tests).
function snapshotInventory(agent) {
    const map = {};
    try {
        const items = agent?.bot?.inventory?.items?.() || [];
        for (const it of items) map[it.name] = (map[it.name] || 0) + it.count;
    } catch {}
    return map;
}

function snapshotPosition(agent) {
    try {
        const p = agent?.bot?.entity?.position;
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

// Build the context object the orchestrator integration consumes when
// dispatching a subagent. The orchestrator instantiates an OrchestratorV2
// against this context's history + a registry view filtered through
// filterDescriptorsByRole(role).
export function createChildSubagentContext(parentAgent, roleName, description, endFactor) {
    if (!roleName) throw new Error('createChildSubagentContext: role is required');
    if (!description) throw new Error('createChildSubagentContext: description is required');
    if (!endFactor) throw new Error('createChildSubagentContext: end_factor is required');
    const profile = loadRoleProfile(roleName);
    const role = profile.role || String(roleName).toLowerCase();

    // Ephemeral child queue — no disk persistence, no queue.log
    const childQueueName = `${parentAgent?.name || 'agent'}-${role}-${Date.now()}`;
    const childQueue = new TaskQueue(childQueueName, null, null, { persist: false });

    // Seed with the dispatch's root task; auto-promote (no plan mode in child)
    childQueue.addTask(description, endFactor);

    // Fresh history — no parent turns, no parent $MEMORY rendering. Just
    // the role system prompt + the dispatch marker.
    const history = [{
        role: 'user',
        content: `[subagent dispatch]\nrole: ${role}\ntask: ${description}\nend_factor: ${endFactor}\nWhen end_factor is met, call finishTask. Use only tools available to your role.`,
    }];

    return {
        role,
        model: profile.model || null,
        systemPrompt: profile.system_prompt || '',
        toolsFilter: profile.tools_filter || null,
        taskQueue: childQueue,
        history,
        dispatchedAt: Date.now(),
        inventorySnapshot: snapshotInventory(parentAgent),
        positionSnapshot: snapshotPosition(parentAgent),
        // For .startTask() picking up the first pending task
        rootTaskDescription: description,
        rootEndFactor: endFactor,
    };
}

// Roll up the dispatch's outcome into one tool_result for the parent.
// `result` is one of 'success' | 'failed' | 'cancelled'; `summary` is the
// LLM-provided one-liner (or '(none)' if not set).
export function finalizeChildSubagent(parentAgent, ctx, { result = 'success', summary = '' } = {}) {
    if (!ctx) return null;
    const finalSummary = summary || '(none)';
    const elapsedSec = Math.round((Date.now() - ctx.dispatchedAt) / 1000);
    const deltas = inventoryDelta(ctx.inventorySnapshot, snapshotInventory(parentAgent));
    const deltaStr = deltas.length ? deltas.map(d => `${d.delta > 0 ? '+' : ''}${d.delta} ${d.name}`).join(', ') : 'no inventory change';
    const pos = snapshotPosition(parentAgent);
    const posStr = pos ? `(${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)})` : '?';
    const childDone = ctx.taskQueue.tasks.filter(t => t.status === 'done').length;
    const childLive = ctx.taskQueue.tasks.filter(t => t.status !== 'done').length;

    return {
        // Shape matches an orchestrator tool_result so the parent can append directly.
        content: `[subagent ${ctx.role} ${result}] elapsed=${elapsedSec}s inventory_delta=[${deltaStr}] position=${posStr} child_tasks=${childDone} done, ${childLive} pending. summary="${finalSummary.replace(/"/g, '\\"')}"`,
        result,
        elapsedSec,
        inventoryDelta: deltas,
        position: pos,
        childTasksDone: childDone,
        childTasksLive: childLive,
        summary: finalSummary,
    };
}

// Test-only.
export function _resetRoleCache() { ROLE_CACHE.clear(); }
