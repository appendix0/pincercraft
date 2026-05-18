// Phase I1: per-player command permission system. Mirrors Claude Code's
// permission map shape — each player gets an { allow, deny } list of glob-
// style patterns. The check runs inside executeCommand before .perform()
// so the same gate covers both player-typed commands and LLM-issued ones.
//
// Rules live in settings.permissions:
//
//   "permissions": {
//     "LosPollos929": { "allow": ["!*"] },                     // owner: all
//     "Khauling":     { "allow": ["!showQueue", "!stats"] },  // trusted ally
//     "*":            { "allow": ["!showQueue", "!stats"] }   // anyone else
//   }
//
// Pattern syntax: '!exact' exact match, '!prefix*' suffix wildcard, '!*' or
// '*' all-commands. Deny wins over allow. Missing player + missing '*' →
// default deny. System / bot-self / self-prompt invocations bypass entirely
// (they're not coming from a human player and have no permission gate).

import settings from './settings.js';

function matchPattern(pattern, cmdName) {
    if (!pattern || !cmdName) return false;
    if (pattern === '*' || pattern === '!*') return true;
    if (pattern === cmdName) return true;
    if (pattern.endsWith('*')) return cmdName.startsWith(pattern.slice(0, -1));
    return false;
}

function normalizePlayer(name) {
    return String(name || '').replace(/^\./, '').toLowerCase();
}

// Returns { allow: boolean, message?: string }.
// `allow: true` means the command may proceed; `allow: false` means
// executeCommand should return the message string verbatim to the caller.
export function checkPlayerPermission(agent, cmdName, ctx = {}) {
    const rules = settings.permissions;
    // No rules configured → behave like the pre-Phase-I world: allow.
    if (!rules || typeof rules !== 'object' || Object.keys(rules).length === 0) {
        return { allow: true };
    }
    const source = ctx.source || agent?.last_sender;
    // System inputs / self-prompts / other bots — no human at the wheel, no gate.
    if (!source || source === agent?.name) return { allow: true };
    const s = String(source);
    if (s === 'system' || s.startsWith('bot:') || s === 'self') return { allow: true };

    const norm = normalizePlayer(source);
    const playerKey = Object.keys(rules).find(k => k !== '*' && normalizePlayer(k) === norm);
    const playerRules = playerKey ? rules[playerKey] : (rules['*'] || null);
    if (!playerRules) {
        return {
            allow: false,
            message: `[permission denied] ${source} has no permission rules and no '*' fallback configured — cannot use ${cmdName}. Owner: add an entry to settings.permissions if this is intentional.`,
        };
    }
    const allow = Array.isArray(playerRules.allow) ? playerRules.allow : [];
    const deny = Array.isArray(playerRules.deny) ? playerRules.deny : [];
    if (deny.some(p => matchPattern(p, cmdName))) {
        return { allow: false, message: `[permission denied] ${source} is blocked from ${cmdName} by a deny rule.` };
    }
    if (allow.some(p => matchPattern(p, cmdName))) return { allow: true };
    return {
        allow: false,
        message: `[permission denied] ${source} is not authorized for ${cmdName}. Their permission rule allows only: ${allow.join(', ') || '(nothing)'}.`,
    };
}

// Convenience: enumerate the effective allowlist for a given player, used
// by future help/introspection commands. Returns an array of pattern strings.
export function effectiveAllowlist(player) {
    const rules = settings?.permissions;
    if (!rules) return ['*']; // open-server fallback
    const norm = normalizePlayer(player);
    const key = Object.keys(rules).find(k => k !== '*' && normalizePlayer(k) === norm);
    const playerRules = key ? rules[key] : rules['*'];
    return playerRules?.allow || [];
}
