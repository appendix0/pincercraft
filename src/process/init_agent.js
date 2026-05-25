import { Agent } from '../agent/agent.js';
import { serverProxy } from '../agent/mindserver_proxy.js';
import yargs from 'yargs';

// Surface async throws instead of dying silently. Before this, an
// unhandledRejection inside !newAction code (e.g. mineflayer-pathfinder
// throwing across an await) terminated the child with no log line; only
// the mindserver socket-disconnect printed, which made the crash look
// like a server kick. Bot.log now ends with the actual stack.
process.on('unhandledRejection', (reason, promise) => {
    console.error('[fatal] unhandledRejection at:', promise);
    console.error('[fatal] reason:', reason && reason.stack ? reason.stack : reason);
    // Stay alive — pathfinder/mineflayer often throw across awaits during
    // !newAction code execution; killing the bot for each one would make
    // it unusable. Operator can watch bot.log for these.
});
process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaughtException:', err && err.stack ? err.stack : err);
    // Exit so AgentProcess (parent) restarts us via its 10s-rule auto-restart.
    // Unlike unhandledRejection these are usually broken-state synchronous throws.
    process.exit(1);
});

const args = process.argv.slice(2);
if (args.length < 1) {
    console.log('Usage: node init_agent.js -n <agent_name> -p <port> -l <load_memory> -m <init_message> -c <count_id>');
    process.exit(1);
}

const argv = yargs(args)
    .option('name', {
        alias: 'n',
        type: 'string',
        description: 'name of agent'
    })
    .option('load_memory', {
        alias: 'l',
        type: 'boolean',
        description: 'load agent memory from file on startup'
    })
    .option('init_message', {
        alias: 'm',
        type: 'string',
        description: 'automatically prompt the agent on startup'
    })
    .option('count_id', {
        alias: 'c',
        type: 'number',
        default: 0,
        description: 'identifying count for multi-agent scenarios',
    })
    .option('port', {
        alias: 'p',
        type: 'number',
        description: 'port of mindserver'
    })
    .argv;

(async () => {
    try {
        console.log('Connecting to MindServer');
        await serverProxy.connect(argv.name, argv.port);
        console.log('Starting agent');
        const agent = new Agent();
        serverProxy.setAgent(agent);
        await agent.start(argv.load_memory, argv.init_message, argv.count_id);
    } catch (error) {
        console.error('Failed to start agent process:');
        console.error(error.message);
        console.error(error.stack);
        process.exit(1);
    }
})();
