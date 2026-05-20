// v2 Step 2 — Tool registry.
//
// Single source of truth for command metadata. Wraps the existing
// queryList + actionsList without rewriting them in place (pragmatic
// — full migration would be ~1500 lines of churn for no near-term
// behavior gain). Step 3 consumes this to build per-provider tools[]
// arrays; Step 4 consumes the metadata for parallelism / plan-mode
// filtering; Step 5 consumes isLongRunning to decide bg handles.
//
// Derived facts (no per-command declaration needed):
//   - isLongRunning: true when perform() was wrapped via runAsAction
//     (which tags its return with .isLongRunning = true). Holds for
//     ~25 actions today; correct by construction.
//
// Declared facts (read from each command entry):
//   - isReadOnly, isConcurrencySafe — Phase B metadata
//   - isDangerous — Phase B (currently unused; reserved)
//   - internal — Step 2 prune flag, skipped in $COMMAND_DOCS and from
//     tools[] advertisement
//   - prompt(ctx), checkPermissions(args, ctx) — per-tool hooks
//
// Schemas:
//   - jsonSchemaFor(cmd) maps the existing params{type, domain} shape
//     to a JSON Schema object suitable for Anthropic / OpenAI tools[].
//     BlockName / ItemName / BlockOrItemName degrade to plain string
//     (full enums would balloon system prompts past the Mindcraft
//     registry of thousands of names).
//
// See docs/agent-blueprint.md §3 Step 2 and Appendix B.2.

// Import the merged list via commands/index.js (not queries/actions directly)
// to avoid a queries ↔ index circular-import TDZ when tool_registry is the
// first thing in the load order (e.g. unit tests).
import { commandList } from './commands/index.js';

const TYPE_TO_JSONSCHEMA = {
    'int':             { type: 'integer' },
    'float':           { type: 'number' },
    'boolean':         { type: 'boolean' },
    'string':          { type: 'string' },
    'BlockName':       { type: 'string' },
    'ItemName':        { type: 'string' },
    'BlockOrItemName': { type: 'string' },
};

function stripPrefix(name) {
    return name && name.startsWith('!') ? name.slice(1) : name;
}

// Translate a single params entry into a JSON Schema property object.
// Numeric domain becomes { minimum, maximum } when both bounds finite;
// infinite bounds drop silently (Anthropic rejects null bounds).
function paramToJsonSchema(p) {
    const base = TYPE_TO_JSONSCHEMA[p?.type] || { type: 'string' };
    const out = { ...base };
    if (p?.description) out.description = p.description;
    if (Array.isArray(p?.domain) && (base.type === 'integer' || base.type === 'number')) {
        const [lo, hi] = p.domain;
        if (Number.isFinite(lo)) out.minimum = lo;
        if (Number.isFinite(hi) && hi !== Number.MAX_SAFE_INTEGER) out.maximum = hi;
    }
    return out;
}

export function jsonSchemaFor(cmd) {
    const params = cmd?.params || {};
    const properties = {};
    const required = [];
    for (const [name, p] of Object.entries(params)) {
        properties[name] = paramToJsonSchema(p);
        if (!p?.optional) required.push(name);
    }
    return {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
    };
}

// Derived. perform() tagged by runAsAction → block on physical motion.
// Step 5 routes these through background handles when use_background_handles
// flag is on.
export function isLongRunning(cmd) {
    if (cmd?.isLongRunning === true) return true;
    if (typeof cmd?.perform === 'function' && cmd.perform.isLongRunning === true) return true;
    return false;
}

class ToolRegistry {
    constructor() {
        this._all = [...commandList];
        this._byName = new Map();
        for (const c of this._all) {
            this._byName.set(c.name, c);
            this._byName.set(stripPrefix(c.name), c);
        }
    }

    all() { return this._all; }

    // What the LLM sees / what tools[] gets advertised with. Skips internal
    // (e.g. lectern bookkeeping invoked programmatically), skips blocked.
    forLLM(blockedNames = []) {
        const blocked = new Set(blockedNames);
        return this._all.filter(c => !c.internal && !blocked.has(c.name));
    }

    byName(name) {
        return this._byName.get(name);
    }

    // For Step 3. Produces provider-neutral tool descriptors; per-provider
    // wrappers can shape these into Anthropic { name, description, input_schema }
    // or OpenAI { type: 'function', function: { name, description, parameters } }.
    toolDescriptorsForLLM(blockedNames = []) {
        return this.forLLM(blockedNames).map(c => ({
            name: stripPrefix(c.name),
            description: c.description || '',
            input_schema: jsonSchemaFor(c),
            isReadOnly: !!c.isReadOnly,
            isConcurrencySafe: !!c.isConcurrencySafe,
            isLongRunning: isLongRunning(c),
            // Carry the raw command back so the orchestrator can invoke perform()
            // without a second lookup.
            _raw: c,
        }));
    }

    // For plan-mode tool filtering in v2 (single-channel decision —
    // see docs/agent-blueprint.md §3 Step 3 rev-2). Filters down to
    // tools the planner can use while waiting for player approval.
    forPlanMode(blockedNames = []) {
        return this.forLLM(blockedNames).filter(c =>
            c.isReadOnly === true || c.isConcurrencySafe === true,
        );
    }
}

let _singleton = null;
export function getRegistry() {
    if (_singleton === null) _singleton = new ToolRegistry();
    return _singleton;
}

// Test-only: drop the cached singleton so unit tests can re-import after a
// hypothetical mutation. Not used at runtime.
export function _resetRegistry() {
    _singleton = null;
}
