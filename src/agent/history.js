import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { NPCData } from './npc/data.js';
import settings from './settings.js';


export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        this.memory_fp = `./bots/${this.name}/memory.json`;
        this.full_history_fp = undefined;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });

        this.turns = [];

        // Natural language memory as a summary of recent messages + previous memory
        this.memory = '';

        // Maximum number of messages to keep in context before saving chunk to memory
        this.max_messages = settings.max_messages;

        // Number of messages to remove from current history and save into memory
        this.summary_chunk_size = 5; 
        // chunking reduces expensive calls to promptMemSaving and appendFullHistory
        // and improves the quality of the memory summary
    }

    getHistory() { // expects an Examples object
        return JSON.parse(JSON.stringify(this.turns));
    }

    async summarizeMemories(turns) {
        console.log("Storing memories...");
        this.memory = await this.agent.prompter.promptMemSaving(turns);

        if (this.memory.length > 500) {
            this.memory = this.memory.slice(0, 500);
            this.memory += '...(Memory truncated to 500 chars. Compress it more next time)';
        }

        console.log("Memory updated to: ", this.memory);
    }

    async appendFullHistory(to_store) {
        if (this.full_history_fp === undefined) {
            const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
            this.full_history_fp = `./bots/${this.name}/histories/${string_timestamp}.json`;
            writeFileSync(this.full_history_fp, '[]', 'utf8');
        }
        try {
            const data = readFileSync(this.full_history_fp, 'utf8');
            let full_history = JSON.parse(data);
            full_history.push(...to_store);
            writeFileSync(this.full_history_fp, JSON.stringify(full_history, null, 4), 'utf8');
        } catch (err) {
            console.error(`Error reading ${this.name}'s full history file: ${err.message}`);
        }
    }

    async add(name, content) {
        let role = 'assistant';
        if (name === 'system') {
            role = 'system';
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        this.turns.push({role, content});

        if (this.turns.length >= this.max_messages) {
            let chunk = this.turns.splice(0, this.summary_chunk_size);
            while (this.turns.length > 0 && this.turns[0].role === 'assistant')
                chunk.push(this.turns.shift()); // remove until turns starts with system/user message

            await this.summarizeMemories(chunk);
            await this.appendFullHistory(chunk);
        }
    }

    async save() {
        try {
            const data = {
                memory: this.memory,
                turns: this.turns,
                self_prompting_state: this.agent.self_prompter.state,
                self_prompt: this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.prompt,
                taskStart: this.agent.task.taskStartTime,
                last_sender: this.agent.last_sender
            };
            writeFileSync(this.memory_fp, JSON.stringify(data, null, 2));
            console.log('Saved memory to:', this.memory_fp);
        } catch (error) {
            console.error('Failed to save history:', error);
            throw error;
        }
    }

    load() {
        try {
            if (!existsSync(this.memory_fp)) {
                console.log('No memory file found.');
                return null;
            }
            const data = JSON.parse(readFileSync(this.memory_fp, 'utf8'));
            this.memory = data.memory || '';
            this.turns = data.turns || [];
            console.log('Loaded memory:', this.memory);
            return data;
        } catch (error) {
            console.error('Failed to load history:', error);
            throw error;
        }
    }

    clear() {
        this.turns = [];
        this.memory = '';
    }

    // Phase A4: token-based compaction. When this.turns exceeds the byte/token
    // threshold, fold older turns into one [compacted] system message at the head.
    // Independent of the legacy max_messages summarizer above (which writes to
    // this.memory / $MEMORY); Phase F will retire that one. Until then they coexist.
    //
    // Token estimate is approximate (length/4 — Anthropic's rule of thumb). Trigger
    // is conservative; the goal is to avoid runaway turn growth on long sessions, not
    // to optimize every byte.
    async compactIfNeeded(threshold_tokens, keep_recent) {
        if (this.turns.length <= keep_recent) return false;
        const estimated = Math.ceil(JSON.stringify(this.turns).length / 4);
        if (estimated < threshold_tokens) return false;

        let to_compact = this.turns.slice(0, this.turns.length - keep_recent);
        let recent = this.turns.slice(this.turns.length - keep_recent);
        // Anthropic expects the first message to be user/system. If our cut left an
        // assistant turn at the head of `recent`, pull it into the compacted chunk.
        while (recent.length > 0 && recent[0].role === 'assistant') {
            to_compact.push(recent.shift());
        }
        if (to_compact.length === 0) return false;

        console.log(`[compact] turns=${this.turns.length} tokens≈${estimated} threshold=${threshold_tokens} → compacting ${to_compact.length} older turns, keeping ${recent.length}`);
        try {
            const summary = await this.agent.prompter.promptCompact(to_compact);
            if (!summary) {
                console.warn('[compact] empty summary; dropping oldest turns as fallback');
                this.turns = recent;
            } else {
                this.turns = [
                    { role: 'system', content: `[compacted ${to_compact.length} older turns]\n${summary}` },
                    ...recent
                ];
            }
            // Persist the compacted-out turns to the full history file so nothing is lost.
            await this.appendFullHistory(to_compact);
            console.log(`[compact] done. new turn count=${this.turns.length}`);
            return true;
        } catch (err) {
            console.error('[compact] failed:', err.message);
            return false;
        }
    }
}