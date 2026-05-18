// Phase H1: slash-command dispatcher. Maps player /commands to small skill
// functions that build the right !addTask + !newAction chain — same shape as
// Claude Code's /init, /review, /explore, etc. Each skill is a tiny JS
// function that knows the right task decomposition.
//
// Bedrock note: vanilla Minecraft reserves the / prefix for built-in
// commands, so Bedrock players can use !! (double-bang) as an alias.
// Both /init and !!init dispatch to the same skill. Per blueprint §8
// (Bedrock chat ergonomics open question).
//
// H2-H6 register the actual player-facing skills (init/review/explore/sleep/
// restock). H7-H9 register meta-skills the bot self-invokes (stuck/loop/
// verify). This module owns only the registry + dispatcher; skill bodies
// live alongside their registrations.

import settings from './settings.js';
import { executeCommand } from './commands/index.js';

const skills = new Map();

export function registerSlashSkill(name, def) {
    if (!name || typeof name !== 'string') throw new Error('slash-skill name required');
    if (!def || typeof def.run !== 'function') throw new Error(`slash-skill /${name} needs a run(agent, args, ctx) function`);
    skills.set(name.toLowerCase(), {
        name: name.toLowerCase(),
        description: def.description || '',
        run: def.run,
        // Meta-skills are self-invokable by the bot via !invokeSkill — they
        // skip the player-authorization check. Default: player-only.
        meta: !!def.meta,
    });
}

export function getSlashSkill(name) {
    return skills.get(String(name || '').toLowerCase());
}

export function listSlashSkills() {
    return Array.from(skills.values()).map(s => ({ name: s.name, description: s.description, meta: s.meta }));
}

// `/init`, `/init arg1 arg2`, `!!init arg1` all match.
const SLASH_RE = /^\s*(?:\/|!!)([a-z][a-z0-9_-]*)(?:\s+(.*))?$/i;

export function parseSlashCommand(message) {
    if (!message) return null;
    const m = String(message).match(SLASH_RE);
    if (!m) return null;
    return { name: m[1].toLowerCase(), args: (m[2] || '').trim() };
}

function normalizeName(n) {
    return String(n || '').replace(/^\./, '').toLowerCase();
}

function isAuthorized(source) {
    if (!source) return false;
    const trusted = settings.only_chat_with;
    if (Array.isArray(trusted) && trusted.length > 0) {
        const norm = normalizeName(source);
        return trusted.some(p => normalizeName(p) === norm);
    }
    return true; // open-server fallback
}

// Dispatcher called by agent.js _processInput before the LLM turn. Returns:
//   undefined → not a slash command, fall through to normal handling
//   string    → reply text to route back to the player
//   null      → skill ran silently (no chat reply)
export async function dispatchSlashCommand(agent, source, message) {
    const parsed = parseSlashCommand(message);
    if (!parsed) return undefined;
    if (!isAuthorized(source)) {
        return `Slash commands are restricted. Ask the owner to add you to only_chat_with.`;
    }
    const skill = skills.get(parsed.name);
    if (!skill) {
        const names = Array.from(skills.values())
            .filter(s => !s.meta)
            .map(s => '/' + s.name)
            .sort();
        return `Unknown slash skill /${parsed.name}. Available: ${names.join(', ') || '(none registered)'}.`;
    }
    try {
        const out = await skill.run(agent, parsed.args, { source });
        return out ?? null;
    } catch (e) {
        console.warn(`slash-skill /${parsed.name} threw:`, e?.message || e);
        return `/${parsed.name} failed: ${e?.message || e}`;
    }
}

// Bot-side invocation. Phase E/H7's `stuck` meta-skill (and H8/H9's loop/verify)
// call this directly via the !invokeSkill command — same registry, no player
// auth, returns the skill's result string so the orchestrator can feed it back
// to the LLM as a system message.
export async function invokeMetaSkill(agent, name, args = '') {
    const skill = skills.get(String(name || '').toLowerCase());
    if (!skill) return `Unknown skill: ${name}.`;
    if (!skill.meta) return `Skill /${name} is player-only — the bot cannot self-invoke it.`;
    try {
        const out = await skill.run(agent, args, { source: 'bot:self' });
        return out ?? `(${name} ran silently)`;
    } catch (e) {
        console.warn(`meta-skill ${name} threw:`, e?.message || e);
        return `Skill ${name} failed: ${e?.message || e}`;
    }
}

// Helper for skill implementations: queue + start a single task via the
// existing !addTask + !startTask plumbing. Centralizes the format so each
// skill doesn't reinvent the chain.
export async function queueTask(agent, description, end_factor, { autostart = false } = {}) {
    if (!agent.task_queue) return { ok: false, message: 'No task_queue available' };
    const add = agent.task_queue.addTask(description, end_factor);
    if (autostart && add?.ok !== false && agent.planMode !== true) {
        agent.task_queue.startTask(null);
    }
    return add;
}

// Helper: execute a bare !command string through the normal executeCommand
// path so the plan-mode + permission gates still apply.
export async function runCommand(agent, commandText) {
    return await executeCommand(agent, commandText);
}
