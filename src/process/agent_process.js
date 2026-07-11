import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { logoutAgent } from '../mindcraft/mindserver.js';

const init_agent_path = fileURLToPath(new URL('./init_agent.js', import.meta.url));

export class AgentProcess {
    constructor(name, port) {
        this.name = name;
        this.port = port;
    }

    start(load_memory=false, init_message=null, count_id=0) {
        this.count_id = count_id;
        this.running = true;

        let args = [init_agent_path, this.name];
        args.push('-n', this.name);
        args.push('-c', count_id);
        if (load_memory)
            args.push('-l', load_memory);
        if (init_message)
            args.push('-m', init_message);
        args.push('-p', this.port);

        const agentProcess = spawn(process.execPath, args, {
            stdio: 'inherit',
            stderr: 'inherit',
        });
        
        let last_restart = Date.now();
        agentProcess.on('exit', (code, signal) => {
            console.log(`Agent process exited with code ${code} and signal ${signal}`);
            this.running = false;
            logoutAgent(this.name);
            
            if (code > 1) {
                console.log(`Ending task`);
                process.exit(code);
            }

            if (code !== 0 && signal !== 'SIGINT') {
                let delay = 10000;
                if (Date.now() - last_restart < 10000) {
                    // Fast exit (crashed within 10s of spawning): back off, and
                    // hand the service to systemd (Restart=on-failure) rather
                    // than lingering as a live process with no agent inside —
                    // reconcile trusts `systemctl is-active`, so a zombie parent
                    // pins the bot down until someone restarts it by hand.
                    this.fast_exit_count = (this.fast_exit_count || 0) + 1;
                    if (this.fast_exit_count >= 5) {
                        console.error(`Agent process crash-looping (${this.fast_exit_count} fast exits) — exiting so systemd restarts the service.`);
                        process.exit(1);
                    }
                    delay = Math.min(10000 * 2 ** this.fast_exit_count, 300000);
                    console.error(`Agent process exited too quickly; retrying in ${delay / 1000}s (fast exit ${this.fast_exit_count}/5).`);
                } else {
                    this.fast_exit_count = 0;
                    console.log('Restarting agent in 10s...');
                }
                setTimeout(() => {
                    this.start(true, 'Agent process restarted.', count_id);
                }, delay);
            }
        });
    
        agentProcess.on('error', (err) => {
            console.error('Agent process error:', err);
        });

        this.process = agentProcess;
    }

    stop() {
        if (!this.running) return;
        this.process.kill('SIGINT');
    }

    forceRestart() {
        if (this.running && this.process && !this.process.killed) {
            console.log(`Agent process for ${this.name} is still running. Attempting to force restart.`);
            
            const restartTimeout = setTimeout(() => {
                console.warn(`Agent ${this.name} did not stop in time. It might be stuck.`);
            }, 5000); // 5 seconds to exit

            this.process.once('exit', () => {
                 clearTimeout(restartTimeout);
                 console.log(`Stopped hanging agent ${this.name}. Now restarting.`);
                 this.start(true, 'Agent process restarted.', this.count_id);
            });
            this.stop(); // sends SIGINT
        } else {
             this.start(true, 'Agent process restarted.', this.count_id);
        }
    }
}