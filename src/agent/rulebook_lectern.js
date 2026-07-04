// Watches a designated lectern for book changes and re-syncs the bot's
// house rules (bots/<name>/house_rules.md — NOT CLAUDE.md, which is the
// staple Code of Conduct and always wins on conflict).
//
// Flow:
//   1. Player runs !designateRulebookLectern near a lectern → designate(block)
//      saves the coords to bots/<name>/rulebook_lectern.json.
//   2. We install bot.on('blockUpdate') listener for that exact position.
//   3. When the lectern's `has_book` state flips false→true (player took the
//      book off, edited it, placed it back), we pathfind to it and re-read.
//   4. The bot writes the new pages to house_rules.md; the next LLM turn
//      picks up the new $COC automatically (composed fresh every turn).
//
// Constraint: the lectern's chunk must stay loaded. Either place it within
// the bot's normal patrol range, in spawn chunks, or `forceload add` the chunk.

import fs from 'fs';
import path from 'path';
import * as skills from './library/skills.js';

const DEBOUNCE_MS = 1500;

export class RulebookLectern {
    constructor(agent) {
        this.agent = agent;
        this.configPath = path.resolve(`./bots/${agent.name}/rulebook_lectern.json`);
        this.position = this._loadConfig();
        this._debounceTimer = null;
        this._lastHadBook = null;
        this._listener = null;
        this._installed = false;
    }

    _loadConfig() {
        try {
            const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            return data.position || null;
        } catch { return null; }
    }

    _saveConfig() {
        try {
            fs.mkdirSync(path.dirname(this.configPath), {recursive: true});
            fs.writeFileSync(this.configPath, JSON.stringify({position: this.position}, null, 2));
        } catch (e) {
            console.warn('RulebookLectern: save failed:', e?.message || e);
        }
    }

    installListener() {
        if (this._installed) return;
        const bot = this.agent.bot;
        if (!bot) return;
        this._listener = (oldBlock, newBlock) => this._onBlockUpdate(oldBlock, newBlock);
        bot.on('blockUpdate', this._listener);
        this._installed = true;
        if (this.position) {
            console.log(`[rulebook] watching lectern at (${this.position.x},${this.position.y},${this.position.z})`);
            // Seed _lastHadBook from the current chunk state if loaded; otherwise
            // wait for the first blockUpdate to set it.
            try {
                const Vec3 = bot.entity?.position?.constructor;
                if (Vec3) {
                    const block = bot.blockAt(new Vec3(this.position.x, this.position.y, this.position.z));
                    if (block?.name === 'lectern') {
                        this._lastHadBook = block.getProperties?.()?.has_book ?? null;
                    }
                }
            } catch { /* chunk not loaded yet, ok */ }
        }
    }

    uninstallListener() {
        if (!this._installed) return;
        try { this.agent.bot.removeListener('blockUpdate', this._listener); } catch {}
        this._listener = null;
        this._installed = false;
    }

    designate(block) {
        if (!block || block.name !== 'lectern') {
            return {ok: false, message: 'That block is not a lectern.'};
        }
        this.position = {x: block.position.x, y: block.position.y, z: block.position.z};
        this._lastHadBook = block.getProperties?.()?.has_book ?? null;
        this._saveConfig();
        if (!this._installed) this.installListener();
        return {ok: true, message: `Rulebook lectern set at (${this.position.x},${this.position.y},${this.position.z}). I'll re-read the house rules whenever you change the book on it.`};
    }

    _onBlockUpdate(oldBlock, newBlock) {
        if (!this.position || !newBlock) return;
        const p = newBlock.position;
        if (p.x !== this.position.x || p.y !== this.position.y || p.z !== this.position.z) return;
        if (newBlock.name !== 'lectern') {
            // lectern was broken or replaced — stop tracking
            console.log('[rulebook] designated lectern no longer exists, clearing.');
            this.position = null;
            this._lastHadBook = null;
            this._saveConfig();
            return;
        }
        const hasBook = newBlock.getProperties?.()?.has_book;
        if (hasBook === true && this._lastHadBook !== true) {
            this._scheduleRead();
        }
        this._lastHadBook = hasBook;
    }

    _scheduleRead() {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(async () => {
            const pos = this.position;
            if (!pos) return;
            console.log(`[rulebook] book change detected at (${pos.x},${pos.y},${pos.z}) — reading.`);
            try {
                const ok = await skills.loadCOCFromLectern(this.agent.bot, 8, pos);
                if (ok) {
                    try { this.agent.openChat?.('Rulebook updated — new rules apply from next turn.'); } catch {}
                }
            } catch (e) {
                console.warn('[rulebook] auto-read failed:', e?.message || e);
            }
        }, DEBOUNCE_MS);
    }
}
