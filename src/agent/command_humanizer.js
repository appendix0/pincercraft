// Turn raw command syntax like `!collectBlocks("stone", 5)` into a friendly
// chat line like `*mining 5 stone*`. Used when settings.show_command_syntax
// is "natural".
//
// Templates take the parsed args array (strings) and return a snippet without
// surrounding asterisks; the caller wraps. Unknown commands fall through to a
// decamelcased fallback so new upstream commands still read OK.

const TEMPLATES = {
    followPlayer: ([p]) => `following ${p}`,
    goToPlayer: ([p]) => `coming to ${p}`,
    goToCoordinates: ([x, y, z]) => `heading to (${x}, ${y}, ${z})`,
    goToBed: () => `heading to bed`,
    goToSurface: () => `heading to the surface`,
    goToRememberedPlace: ([name]) => `heading to ${name}`,
    moveAway: ([n]) => `backing off ${n} blocks`,
    stay: () => `staying put`,
    stop: () => `stopping`,
    stfu: () => `quiet mode`,
    collectBlocks: ([type, n]) => `mining ${n ?? ''} ${type}`.trim(),
    searchForBlock: ([type]) => `searching for ${type}`,
    searchForEntity: ([type]) => `looking for ${type}`,
    digDown: ([n]) => `digging down ${n} blocks`,
    placeHere: ([type]) => `placing ${type}`,
    craftRecipe: ([item, n]) => `crafting ${n ?? ''} ${item}`.trim(),
    smeltItem: ([item, n]) => `smelting ${n ?? ''} ${item}`.trim(),
    equip: ([item]) => `equipping ${item}`,
    consume: ([food]) => `eating ${food}`,
    discard: ([item, n]) => `dropping ${n ?? ''} ${item}`.trim(),
    putInChest: ([item, n]) => `storing ${n ?? ''} ${item}`.trim(),
    takeFromChest: ([item, n]) => `taking ${n ?? ''} ${item} from chest`.trim(),
    givePlayer: ([p, item, n]) => `giving ${p} ${n ?? ''} ${item}`.trim().replace(/\s+/g, ' '),
    viewChest: () => `checking the chest`,
    attack: ([type]) => `attacking ${type}`,
    attackPlayer: ([p]) => `attacking ${p}`,
    lookAtPlayer: ([p]) => `looking at ${p}`,
    lookAtPosition: ([x, y, z]) => `looking at (${x}, ${y}, ${z})`,
    startConversation: ([p]) => `messaging ${p}`,
    endConversation: () => `ending the conversation`,
    rememberHere: ([name]) => `remembering this place as ${name}`,
    setMode: ([mode, on]) => `${on === 'true' ? 'enabling' : 'disabling'} ${mode} mode`,
    goal: ([g]) => `new goal: ${g}`,
    endGoal: () => `goal done`,
    newAction: () => `thinking…`, // user-facing summary for code-gen; details would be noise
    clearChat: () => `clearing chat`,
    clearFurnace: () => `clearing the furnace`,
    useOn: ([item, target]) => `using ${item} on ${target}`,
    help: () => `checking help`,
    savedPlaces: () => `checking saved places`,
    searchWiki: ([q]) => `looking up "${q}"`,
    showVillagerTrades: () => `looking at villager trades`,
    tradeWithVillager: () => `trading with villager`,
    getBlueprint: () => `getting blueprint`,
    getBlueprintLevel: () => `checking blueprint level`,
    checkBlueprint: () => `checking blueprint`,
    checkBlueprintLevel: () => `checking blueprint level`,
    getCraftingPlan: () => `planning craft`,
    restart: () => `restarting`,
};

// "searchForBlock" -> "search for block"
function decamel(name) {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase();
}

// Pull the command name and the raw argument string out of `!foo("a", 1, true)`.
// Returns {name, args:[str,...]} or null if it doesn't parse cleanly.
function parseCommand(text) {
    const m = text.match(/^\s*!(\w+)\s*(?:\(([\s\S]*)\))?/);
    if (!m) return null;
    const name = m[1];
    const argsRaw = (m[2] ?? '').trim();
    if (argsRaw.length === 0) return {name, args: []};

    // Lightweight CSV split that respects quoted strings; good enough for the
    // Mindcraft command grammar (no nested calls, no escaped quotes inside args).
    const args = [];
    let buf = '', inStr = null, depth = 0;
    for (const ch of argsRaw) {
        if (inStr) {
            if (ch === inStr) inStr = null;
            else buf += ch;
            continue;
        }
        if (ch === '"' || ch === "'") { inStr = ch; continue; }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        if (ch === ',' && depth === 0) {
            args.push(buf.trim());
            buf = '';
        } else {
            buf += ch;
        }
    }
    if (buf.trim().length > 0) args.push(buf.trim());
    return {name, args};
}

// Public API.
export function humanizeCommand(text) {
    const parsed = parseCommand(text);
    if (!parsed) return `*using ${text.trim()}*`;
    const {name, args} = parsed;
    const tpl = TEMPLATES[name];
    if (tpl) return `*${tpl(args).replace(/\s+/g, ' ').trim()}*`;
    return args.length > 0
        ? `*${decamel(name)} (${args.join(', ')})*`
        : `*${decamel(name)}*`;
}
