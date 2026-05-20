import { getBlockId, getItemId } from "../../utils/mcdata.js";
import { actionsList } from './actions.js';
import { queryList } from './queries.js';
import { checkPlayerPermission } from '../permissions.js';

let suppressNoDomainWarning = true;

// Exported so src/agent/tool_registry.js can import the merged list without
// pulling queries.js / actions.js directly (which would trigger a
// queries ↔ index circular import — queries.js imports getCommandDocs
// from this file). Routing through here forces the index→queries load
// order that keeps the cycle innocuous.
export const commandList = queryList.concat(actionsList);
const commandMap = {};
for (let command of commandList) {
    commandMap[command.name] = command;
}

export function getCommand(name) {
    return commandMap[name];
}

export function blacklistCommands(commands) {
    const unblockable = ['!stop', '!stats', '!inventory', '!goal'];
    for (let command_name of commands) {
        if (unblockable.includes(command_name)){
            console.warn(`Command ${command_name} is unblockable`);
            continue;
        }
        delete commandMap[command_name];
        delete commandList.find(command => command.name === command_name);
    }
}

const commandRegex = /!(\w+)(?:\(((?:-?\d+(?:\.\d+)?|true|false|"[^"]*")(?:\s*,\s*(?:-?\d+(?:\.\d+)?|true|false|"[^"]*"))*)\))?/
const argRegex = /-?\d+(?:\.\d+)?|true|false|"[^"]*"/g;

export function containsCommand(message) {
    const commandMatch = message.match(commandRegex);
    if (commandMatch)
        return "!" + commandMatch[1];
    return null;
}

export function commandExists(commandName) {
    if (!commandName.startsWith("!"))
        commandName = "!" + commandName;
    return commandMap[commandName] !== undefined;
}

/**
 * Converts a string into a boolean.
 * @param {string} input
 * @returns {boolean | null} the boolean or `null` if it could not be parsed.
 * */
function parseBoolean(input) {
    switch(input.toLowerCase()) {
        case 'false': //These are interpreted as flase;
        case 'f':
        case '0':
        case 'off':
            return false;
        case 'true': //These are interpreted as true;
        case 't':
        case '1':
        case 'on':
            return true;
        default:
            return null;
    }
}

/**
 * @param {number} value - the value to check
 * @param {number} lowerBound
 * @param {number} upperBound
 * @param {string} endpointType - The type of the endpoints represented as a two character string. `'[)'` `'()'` 
 */
function checkInInterval(number, lowerBound, upperBound, endpointType) {
    switch (endpointType) {
        case '[)':
            return lowerBound <= number && number < upperBound;
        case '()':
            return lowerBound < number && number < upperBound;
        case '(]':
            return lowerBound < number && number <= upperBound;
        case '[]':
            return lowerBound <= number && number <= upperBound;
        default:
            throw new Error('Unknown endpoint type:', endpointType)
    }
}



// todo: handle arrays?
/**
 * Returns an object containing the command, the command name, and the comand parameters.
 * If parsing unsuccessful, returns an error message as a string.
 * @param {string} message - A message from a player or language model containing a command.
 * @returns {string | Object}
 */
export function parseCommandMessage(message) {
    const commandMatch = message.match(commandRegex);
    if (!commandMatch) return `Command is incorrectly formatted`;

    const commandName = "!"+commandMatch[1];

    let args;
    if (commandMatch[2]) args = commandMatch[2].match(argRegex);
    else args = [];

    const command = getCommand(commandName);
    if(!command) return `${commandName} is not a command.`

    const params = commandParams(command);
    const paramNames = commandParamNames(command);
    
    if (args.length !== params.length)
        return `Command ${command.name} was given ${args.length} args, but requires ${params.length} args.`;

    
    for (let i = 0; i < args.length; i++) {
        const param = params[i];
        //Remove any extra characters
        let arg = args[i].trim();
        if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
            arg = arg.substring(1, arg.length-1);
            // Phase F2: interpret JSON-style escape sequences so multi-line
            // content (especially !remember) isn't stored as literal "\n".
            // Conservative — only the standard escapes; unknown escapes pass
            // through as the literal char to avoid surprising the LLM.
            arg = arg.replace(/\\([nrt"\\'/])/g, (_, ch) => {
                switch (ch) {
                    case 'n': return '\n';
                    case 'r': return '\r';
                    case 't': return '\t';
                    case '\\': return '\\';
                    case '"': return '"';
                    case "'": return "'";
                    case '/': return '/';
                    default: return ch;
                }
            });
        }
        
        //Convert to the correct type
        switch(param.type) {
            case 'int':
                arg = Number.parseInt(arg); break;
            case 'float':
                arg = Number.parseFloat(arg); break;
            case 'boolean':
                arg = parseBoolean(arg); break;
            case 'BlockName':
            case 'BlockOrItemName':
            case 'ItemName':
                if (arg.endsWith('plank') || arg.endsWith('seed'))
                    arg += 's'; // add 's' to for common mistakes like "oak_plank" or "wheat_seed"
            case 'string':
                break;
            default:
                throw new Error(`Command '${commandName}' parameter '${paramNames[i]}' has an unknown type: ${param.type}`);
        }
        if(arg === null || Number.isNaN(arg))
            return `Error: Param '${paramNames[i]}' must be of type ${param.type}.`

        if(typeof arg === 'number') { //Check the domain of numbers
            const domain = param.domain;
            if(domain) {
                /**
                 * Javascript has a built in object for sets but not intervals.
                 * Currently the interval (lowerbound,upperbound] is represented as an Array: `[lowerbound, upperbound, '(]']`
                 */
                if (!domain[2]) domain[2] = '[)'; //By default, lower bound is included. Upper is not.

                if(!checkInInterval(arg, ...domain)) {
                    return `Error: Param '${paramNames[i]}' must be an element of ${domain[2][0]}${domain[0]}, ${domain[1]}${domain[2][1]}.`;
                    //Alternatively arg could be set to the nearest value in the domain.
                }
            } else if (!suppressNoDomainWarning) {
                console.warn(`Command '${commandName}' parameter '${paramNames[i]}' has no domain set. Expect any value [-Infinity, Infinity].`)
                suppressNoDomainWarning = true; //Don't spam console. Only give the warning once.
            }
        } else if(param.type === 'BlockName') { //Check that there is a block with this name
            if(getBlockId(arg) == null) return  `Invalid block type: ${arg}.`
        } else if(param.type === 'ItemName') { //Check that there is an item with this name
            if(getItemId(arg) == null) return `Invalid item type: ${arg}.`
        } else if(param.type === 'BlockOrItemName') {
            if(getBlockId(arg) == null && getItemId(arg) == null) return  `Invalid block or item type: ${arg}.`
        }
        args[i] = arg;
    }
    
    return { commandName, args };
}

export function truncCommandMessage(message) {
    const commandMatch = message.match(commandRegex);
    if (commandMatch) {
        return message.substring(0, commandMatch.index + commandMatch[0].length);
    }
    return message;
}

// Phase A1: return all command spans in the message, in order of appearance.
// Each span is { commandName, startIndex, endIndex }. The orchestrator slices
// message[startIndex:endIndex] and passes it to executeCommand for parsing +
// execution, so we avoid duplicating the arg-coercion logic here.
export function findAllCommandSpans(message) {
    if (!message) return [];
    const spans = [];
    const re = new RegExp(commandRegex.source, 'g');
    let m;
    while ((m = re.exec(message)) !== null) {
        if (m[0].length === 0) break; // safety against zero-width matches
        spans.push({
            commandName: '!' + m[1],
            startIndex: m.index,
            endIndex: m.index + m[0].length,
        });
    }
    return spans;
}

export function isAction(name) {
    return actionsList.find(action => action.name === name) !== undefined;
}

/**
 * @param {Object} command
 * @returns {Object[]} The command's parameters.
 */
function commandParams(command) {
    if (!command.params)
        return [];
    return Object.values(command.params);
}

/**
 * @param {Object} command
 * @returns {string[]} The names of the command's parameters.
 */
function commandParamNames(command) {
    if (!command.params)
        return [];
    return Object.keys(command.params);
}

function numParams(command) {
    return commandParams(command).length;
}

export async function executeCommand(agent, message) {
    let parsed = parseCommandMessage(message);
    if (typeof parsed === 'string')
        return parsed; //The command was incorrectly formatted or an invalid input was given.
    else {
        console.log('parsed command:', parsed);
        const command = getCommand(parsed.commandName);
        let numArgs = 0;
        if (parsed.args) {
            numArgs = parsed.args.length;
        }
        if (numArgs !== numParams(command))
            return `Command ${command.name} was given ${numArgs} args, but requires ${numParams(command)} args.`;
        // Phase I1: global per-player permission gate. Runs first so denial
        // rules can short-circuit before plan-mode / per-tool hooks. System
        // inputs and self-prompts bypass — see permissions.js for the matrix.
        try {
            const ctx = { agent, source: agent.last_sender };
            const perm = checkPlayerPermission(agent, command.name, ctx);
            if (perm && perm.allow === false) return perm.message;
        } catch (e) {
            console.warn('checkPlayerPermission threw:', e?.message || e);
        }
        // Phase C1: plan-mode gate. While agent.planMode is on, body-touching
        // commands are blocked. Read-only and concurrency-safe (non-body)
        // commands pass through. !exitPlanMode is always allowed regardless
        // of its flags so the LLM can leave plan mode.
        if (agent.planMode === true && command.name !== '!exitPlanMode') {
            const resolve = (v) => typeof v === 'function' ? !!v(parsed.args) : !!v;
            const planSafe = resolve(command.isReadOnly) || resolve(command.isConcurrencySafe);
            if (!planSafe) {
                return `[plan mode] Execute blocked for ${command.name}. You're in plan mode — only memory, queue, observation, and chat commands run. Post the plan to chat via !addTask, wait for player approval, then call !exitPlanMode (or the player saying "ok"/"yes"/"go" auto-exits).`;
            }
        }
        // Phase B4: per-tool permission gate. The hook receives the parsed
        // args + a runtime ctx and returns `{ allow: boolean, message?: string }`
        // (or undefined for allow-by-default). Phase I will populate per-command
        // checkPermissions for the player-permission system; for now the hook
        // is wired in but commands don't define it, so nothing is gated.
        if (typeof command.checkPermissions === 'function') {
            try {
                const ctx = { agent, source: agent.last_sender };
                const perm = command.checkPermissions(parsed.args, ctx) ?? { allow: true };
                if (perm && perm.allow === false) {
                    return perm.message || `[permission denied] You cannot use ${command.name} in this context.`;
                }
            } catch (e) {
                console.warn(`checkPermissions threw for ${command.name}:`, e?.message || e);
            }
        }
        const result = await command.perform(agent, ...parsed.args);
        return result;
    }
}

export function getCommandDocs(agent) {
    const typeTranslations = {
        //This was added to keep the prompt the same as before type checks were implemented.
        //If the language model is giving invalid inputs changing this might help.
        'float':             'number',
        'int':               'number',
        'BlockName':         'string',
        'ItemName':          'string',
        'BlockOrItemName':   'string',
        'boolean':           'bool'
    }
    let docs = `\n*COMMAND DOCS\n You can use the following commands to perform actions and get information about the world.
    Use the commands with the syntax: !commandName or !commandName("arg1", 1.2, ...) if the command takes arguments.\n
    Do not use codeblocks. Use double quotes for strings. Only use one command in each response, trailing commands and comments will be ignored.\n`;
    // Phase B3: per-tool prompt(ctx) hook. A tool can:
    //   - return undefined → use the static command.description (default)
    //   - return a string  → use that string as the rendered description
    //   - return null      → omit the tool entirely (turn itself off for this turn)
    // Lets context-sensitive tools self-gate (e.g. hide !goToBed when it's day).
    const ctx = { agent };
    for (let command of commandList) {
        if (agent.blocked_actions.includes(command.name)) {
            continue;
        }
        // Step 2 prune: commands flagged `internal: true` are callable but
        // not advertised to the LLM (e.g. setup verbs invoked programmatically
        // by other modules). Distinct from blocked_actions, which forbids
        // execution entirely.
        if (command.internal === true) {
            continue;
        }
        let description = command.description;
        if (typeof command.prompt === 'function') {
            try {
                const out = command.prompt(ctx);
                if (out === null) continue;
                if (typeof out === 'string') description = out;
            } catch (e) {
                console.warn(`command.prompt() threw for ${command.name}:`, e?.message || e);
            }
        }
        docs += command.name + ': ' + description + '\n';
        if (command.params) {
            docs += 'Params:\n';
            for (let param in command.params) {
                docs += `${param}: (${typeTranslations[command.params[param].type]??command.params[param].type}) ${command.params[param].description}\n`;
            }
        }
    }
    return docs + '*\n';
}
