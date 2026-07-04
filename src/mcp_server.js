// Phase I2: MCP server mode. Exposes a curated set of the bot's commands as
// MCP tools via JSON-RPC 2.0 over HTTP, so an external Claude Code session
// (or any MCP client) can drive the bot from outside the game.
//
// The protocol is intentionally minimal — we implement just enough of
// https://modelcontextprotocol.io/spec to interoperate with stock clients:
//   - POST /mcp accepts {jsonrpc, id, method, params}
//   - Bearer auth via settings.mcp.token (or keys.mcp_token)
//   - Methods: initialize, tools/list, tools/call, ping
//
// The actual tool implementations route into the existing executeCommand
// pipeline so plan-mode + permission gates still apply. The "outside world"
// is a player named 'mcp' for permission-check purposes — give it an entry
// in settings.permissions to control what external agents can do.
//
// Started by agent.js when settings.mcp.enabled === true. Otherwise this
// file is dormant — no side effects on import.

import express from 'express';
import { executeCommand } from './agent/commands/index.js';

// Curated tool exposure. Each entry has:
//   name        — MCP tool name (snake_case)
//   description — what the tool does (shown to MCP clients in tools/list)
//   inputSchema — JSON Schema for params
//   exec(agent, params) — async (agent, params) → string|object result
const TOOLS = [
    {
        name: 'say',
        description: 'Make the bot speak in the game chat. Use to announce status, ask the player a question, or just talk.',
        inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'Chat message to send.' } },
            required: ['text'],
        },
        async exec(agent, p) {
            agent.openChat(String(p.text || '').slice(0, 256));
            return `chatted: ${String(p.text || '').slice(0, 100)}`;
        },
    },
    {
        name: 'read_stats',
        description: 'Get the bot\'s current position, health, hunger, biome, weather, time of day, current action, and nearby players/bots.',
        inputSchema: { type: 'object', properties: {} },
        async exec(agent, p) {
            return await executeCommand(agent, '!stats');
        },
    },
    {
        name: 'read_inventory',
        description: 'Get the bot\'s inventory contents and equipped armor.',
        inputSchema: { type: 'object', properties: {} },
        async exec(agent, p) {
            return await executeCommand(agent, '!inventory');
        },
    },
    {
        name: 'read_inventory_json',
        description: 'Machine-readable inventory: JSON object of {item_name: total_count} summed across stacks. For scripts (e.g. the eval referee) — humans should prefer read_inventory.',
        inputSchema: { type: 'object', properties: {} },
        async exec(agent, p) {
            const items = agent.bot?.inventory?.items?.() || [];
            const counts = {};
            for (const i of items) counts[i.name] = (counts[i.name] || 0) + (i.count || 0);
            return counts;
        },
    },
    {
        name: 'read_nearby_blocks',
        description: 'Get the block types near the bot, including the first solid block above its head.',
        inputSchema: { type: 'object', properties: {} },
        async exec(agent, p) {
            return await executeCommand(agent, '!nearbyBlocks');
        },
    },
    {
        name: 'mine_block',
        description: 'Mine N blocks of a given type. Uses smartGather under the hood — auto-equips the right tool and retries up to 8 times.',
        inputSchema: {
            type: 'object',
            properties: {
                type: { type: 'string', description: 'Block name (e.g. "iron_ore", "oak_log").' },
                count: { type: 'integer', minimum: 1, description: 'How many to collect.' },
            },
            required: ['type', 'count'],
        },
        async exec(agent, p) {
            return await executeCommand(agent, `!collectBlocks("${p.type}", ${p.count})`);
        },
    },
    {
        name: 'go_to_coords',
        description: 'Move the bot to the given world coordinates. Uses smartGoTo (default → canDig → towers/bridges escalation).',
        inputSchema: {
            type: 'object',
            properties: {
                x: { type: 'number' },
                y: { type: 'number' },
                z: { type: 'number' },
                closeness: { type: 'number', minimum: 0, default: 2 },
            },
            required: ['x', 'y', 'z'],
        },
        async exec(agent, p) {
            const cl = p.closeness ?? 2;
            return await executeCommand(agent, `!goToCoordinates(${p.x}, ${p.y}, ${p.z}, ${cl})`);
        },
    },
    {
        name: 'go_to_player',
        description: 'Move the bot to a named player.',
        inputSchema: {
            type: 'object',
            properties: {
                player_name: { type: 'string' },
                closeness: { type: 'number', minimum: 0, default: 3 },
            },
            required: ['player_name'],
        },
        async exec(agent, p) {
            return await executeCommand(agent, `!goToPlayer("${p.player_name}", ${p.closeness ?? 3})`);
        },
    },
    {
        name: 'add_task',
        description: 'Queue a task on the bot. Requires an observable end_factor (e.g. "5 iron_ore in inventory").',
        inputSchema: {
            type: 'object',
            properties: {
                description: { type: 'string' },
                end_factor: { type: 'string' },
            },
            required: ['description', 'end_factor'],
        },
        async exec(agent, p) {
            return await executeCommand(agent, `!addTask("${p.description.replace(/"/g, '\\"')}", "${p.end_factor.replace(/"/g, '\\"')}")`);
        },
    },
    {
        name: 'show_queue',
        description: 'Read the current task queue (including plan-mode state).',
        inputSchema: { type: 'object', properties: {} },
        async exec(agent, p) {
            return await executeCommand(agent, '!showQueue');
        },
    },
    {
        name: 'invoke_skill',
        description: 'Invoke a bot-side meta-skill (stuck, loop, verify).',
        inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
        },
        async exec(agent, p) {
            return await executeCommand(agent, `!invokeSkill("${p.name}")`);
        },
    },
    {
        name: 'dispatch_agent',
        description: 'Hand a focused unit of work to a role-specific subagent (miner, builder, navigator, scout).',
        inputSchema: {
            type: 'object',
            properties: {
                role: { type: 'string', enum: ['miner', 'builder', 'navigator', 'scout'] },
                description: { type: 'string' },
                end_factor: { type: 'string' },
            },
            required: ['role', 'description', 'end_factor'],
        },
        async exec(agent, p) {
            const desc = String(p.description).replace(/"/g, '\\"');
            const ef = String(p.end_factor).replace(/"/g, '\\"');
            return await executeCommand(agent, `!dispatchAgent("${p.role}", "${desc}", "${ef}")`);
        },
    },
    {
        name: 'run_raw_command',
        description: 'Escape hatch — execute any bot !command string verbatim. The same permission + plan-mode gates that apply to in-game commands apply here.',
        inputSchema: {
            type: 'object',
            properties: { command: { type: 'string', description: 'The full !command(...) string.' } },
            required: ['command'],
        },
        async exec(agent, p) {
            return await executeCommand(agent, String(p.command));
        },
    },
];

function rpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message, data) {
    return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

export function startMcpServer(agent, { port = 8765, token = null, host = '127.0.0.1' } = {}) {
    const app = express();
    app.use(express.json({ limit: '256kb' }));

    function authOk(req) {
        if (!token) return true; // open mode — only safe on localhost / closed networks
        const auth = req.headers['authorization'];
        if (!auth) return false;
        const [scheme, t] = auth.split(' ');
        return scheme === 'Bearer' && t === token;
    }

    // MCP is normally over stdio; we serve a minimal HTTP variant for ease of
    // use with Claude Code / external scripts. One POST per request, no SSE.
    app.post('/mcp', async (req, res) => {
        if (!authOk(req)) {
            res.status(401).json(rpcError(null, -32001, 'Unauthorized — provide Bearer token.'));
            return;
        }
        const { id = null, method, params = {} } = req.body || {};
        try {
            if (method === 'initialize') {
                return res.json(rpcResult(id, {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: `pincercraft-mcp-${agent.name}`, version: '0.1.0' },
                }));
            }
            if (method === 'ping') return res.json(rpcResult(id, {}));
            if (method === 'tools/list') {
                const tools = TOOLS.map(t => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema,
                }));
                return res.json(rpcResult(id, { tools }));
            }
            if (method === 'tools/call') {
                const { name, arguments: args = {} } = params;
                const tool = TOOLS.find(t => t.name === name);
                if (!tool) return res.json(rpcError(id, -32601, `Unknown tool: ${name}`));
                // Spoof the source so the permission system can rule on it.
                // External agents are seen as a synthetic 'mcp' player.
                const prevSender = agent.last_sender;
                agent.last_sender = 'mcp';
                try {
                    const out = await tool.exec(agent, args);
                    const text = typeof out === 'string' ? out : JSON.stringify(out);
                    return res.json(rpcResult(id, { content: [{ type: 'text', text }] }));
                } finally {
                    agent.last_sender = prevSender;
                }
            }
            // Unknown method.
            return res.json(rpcError(id, -32601, `Unknown method: ${method}`));
        } catch (e) {
            console.warn('[mcp] handler threw:', e?.message || e);
            return res.json(rpcError(id, -32603, `Internal error: ${e?.message || e}`));
        }
    });

    app.get('/mcp/healthz', (req, res) => res.json({ ok: true, agent: agent.name, tools: TOOLS.length }));

    const server = app.listen(port, host, () => {
        console.log(`[mcp] server listening on ${host}:${port} (tools=${TOOLS.length}, auth=${token ? 'bearer' : 'open'})`);
    });
    server.on('error', e => console.warn('[mcp] server error:', e?.message || e));
    return server;
}
