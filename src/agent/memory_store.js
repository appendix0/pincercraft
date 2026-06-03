// Persistent topic-based memory for the bot, modeled after Claude Code's
// auto-memory. Two layers:
//   - MEMORY.md: a short index (one line per topic, max 200 lines), injected
//     into every prompt via $MEMORY so the model always sees what it knows
//   - <topic>.md: detail files, read on demand via !recall(topic)
//
// Lives at bots/<name>/memory/. A separate durable layer from bots/<name>/memory.json
// (places + conversation turns). Both persist across reboots now — only the task
// queue (tasks.json) is wiped on start. Persists across reboots; this is the whole point.

import fs from 'fs';
import path from 'path';

const INDEX_LINE_CAP = 200;
const TOPIC_BYTE_CAP = 4096;
const TOPIC_COUNT_CAP = 30;
const SUMMARY_CHAR_CAP = 120;

// Phase F4: shared memory layers. Server memory is one source of truth across
// every bot on the host; player memory is per-player and follows them across
// sessions. Lives outside bots/<name>/memory/ so multiple bots share it.
const SERVER_MEMORY_DIR = path.resolve('./memory/server');
const PLAYER_MEMORY_DIR = path.resolve('./memory/players');

function slugify(topic) {
    return String(topic || '').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 60);
}

// Phase F3: truncate at word boundary instead of mid-word. The 0.6 cap ratio
// is what stops "the quick brown fox jumps over" from truncating to "the q…".
function truncAtWord(text, cap) {
    const s = String(text || '').replace(/\s+$/g, '');
    if (s.length <= cap) return s;
    const slice = s.substring(0, cap);
    const sp = slice.lastIndexOf(' ');
    if (sp > cap * 0.6) return slice.substring(0, sp) + '…';
    return slice + '…';
}

// Phase F3: normalize line endings + trim trailing whitespace per line.
function normalize(text) {
    return String(text || '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.replace(/[ \t]+$/g, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+|\n+$/g, '');
}

// Phase F4: load all .md files from a layer dir into [{slug, summary, body}].
// Used by the prompter to assemble $MEMORY across server / bot / player layers.
function readLayer(dir) {
    try {
        return fs.readdirSync(dir)
            .filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
            .map(f => {
                const slug = f.replace(/\.md$/, '');
                let summary = '';
                try {
                    const content = fs.readFileSync(path.join(dir, f), 'utf8');
                    summary = truncAtWord(
                        content.split('\n')[0].replace(/^#+\s*/, '').trim(),
                        SUMMARY_CHAR_CAP
                    );
                } catch { /* ignore */ }
                return { slug, summary };
            })
            .sort((a, b) => a.slug.localeCompare(b.slug));
    } catch { return []; }
}

// Phase F4: assemble the layered $MEMORY block. Each layer is prefixed by a
// section header so the LLM knows which scope it's reading. Empty layers are
// silently omitted.
export function buildLayeredMemoryIndex(agent) {
    const sections = [];
    // Server layer — applies to all bots on the host.
    const server = readLayer(SERVER_MEMORY_DIR);
    if (server.length) {
        sections.push('## Server (shared across all bots)');
        sections.push(...server.map(e => `- ${e.slug} — ${e.summary || '(no summary)'}`));
    }
    // Bot layer — the existing MemoryStore index, but rendered through the
    // same line shape for consistency.
    const botIndex = agent?.memory_store?.serializeIndex();
    if (botIndex && botIndex !== 'No saved memories yet. Use !remember to save persistent facts.') {
        sections.push('## Bot (' + (agent?.name || 'me') + ')');
        // Strip the "# Memory Index" header that serializeIndex emits.
        sections.push(botIndex.replace(/^# Memory Index\s*\n+/, '').trimEnd());
    }
    // Player layer — only for the most recent human sender, if any.
    const player = agent?.last_sender;
    if (player) {
        const playerFile = path.join(PLAYER_MEMORY_DIR, `${slugify(player)}.md`);
        try {
            if (fs.existsSync(playerFile)) {
                const body = fs.readFileSync(playerFile, 'utf8').trim();
                if (body) {
                    sections.push(`## Player (${player})`);
                    sections.push(body);
                }
            }
        } catch { /* ignore */ }
    }
    if (sections.length === 0) {
        return 'No saved memories yet. Use !remember to save persistent facts.';
    }
    return sections.join('\n');
}

export class MemoryStore {
    constructor(agentName) {
        this.agentName = agentName;
        this.dir = path.resolve(`./bots/${agentName}/memory`);
        this.indexPath = path.join(this.dir, 'MEMORY.md');
        this._ensureDir();
    }

    _ensureDir() {
        try { fs.mkdirSync(this.dir, {recursive: true}); } catch (e) { /* ignore */ }
    }

    _topicPath(topic) {
        const slug = slugify(topic);
        if (!slug) return null;
        return {slug, path: path.join(this.dir, `${slug}.md`)};
    }

    _topicCount() {
        try {
            return fs.readdirSync(this.dir)
                .filter(f => f.endsWith('.md') && f !== 'MEMORY.md').length;
        } catch { return 0; }
    }

    _readIndex() {
        try { return fs.readFileSync(this.indexPath, 'utf8'); } catch { return ''; }
    }

    _writeIndex(body) {
        try { fs.writeFileSync(this.indexPath, body); } catch (e) {
            console.warn('MemoryStore: writeIndex failed:', e?.message || e);
        }
    }

    // Each index line is `- <slug> — <summary>`. Rebuilds the index from the
    // current topic files on disk so manual edits to topic files stay reflected.
    _rebuildIndex() {
        // Phase F3: summary now truncates at word boundary instead of mid-word.
        let entries = [];
        try {
            entries = fs.readdirSync(this.dir)
                .filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
                .map(f => {
                    const slug = f.replace(/\.md$/, '');
                    let summary = '';
                    try {
                        const content = fs.readFileSync(path.join(this.dir, f), 'utf8');
                        summary = truncAtWord(
                            content.split('\n')[0].replace(/^#+\s*/, '').trim(),
                            SUMMARY_CHAR_CAP
                        );
                    } catch { /* ignore */ }
                    return {slug, summary};
                })
                .sort((a, b) => a.slug.localeCompare(b.slug));
        } catch { /* dir missing */ }
        const lines = ['# Memory Index', '', ...entries.map(e => `- ${e.slug} — ${e.summary || '(no summary)'}`)];
        this._writeIndex(lines.join('\n') + '\n');
    }

    write(topic, content) {
        const t = this._topicPath(topic);
        if (!t) return {ok: false, message: 'Topic name empty or invalid — rejected.'};
        // Phase F3: normalize line endings (CRLF → LF) + strip trailing
        // whitespace per line + collapse 3+ blank lines into 2, so files
        // written from different platforms / LLM outputs converge on the
        // same shape.
        content = normalize(content);
        if (!content) return {ok: false, message: `Topic "${t.slug}" content empty — rejected.`};
        if (Buffer.byteLength(content, 'utf8') > TOPIC_BYTE_CAP) {
            return {ok: false, message: `Topic "${t.slug}" content exceeds ${TOPIC_BYTE_CAP} bytes — rejected. Be concise or split into multiple topics.`};
        }
        const exists = fs.existsSync(t.path);
        if (!exists && this._topicCount() >= TOPIC_COUNT_CAP) {
            return {ok: false, message: `Memory full (${TOPIC_COUNT_CAP} topics). !forget an old topic before adding new ones.`};
        }
        try { fs.writeFileSync(t.path, content + '\n'); }
        catch (e) { return {ok: false, message: `Failed to write memory: ${e?.message || e}`}; }
        this._rebuildIndex();
        return {ok: true, message: `${exists ? 'Updated' : 'Saved'} memory "${t.slug}".`, slug: t.slug};
    }

    read(topic) {
        const t = this._topicPath(topic);
        if (!t) return {ok: false, message: 'Topic name empty or invalid.'};
        try {
            const content = fs.readFileSync(t.path, 'utf8');
            return {ok: true, message: content, slug: t.slug};
        } catch {
            return {ok: false, message: `No memory found for "${t.slug}". Use !listMemory to see what's saved.`};
        }
    }

    remove(topic) {
        const t = this._topicPath(topic);
        if (!t) return {ok: false, message: 'Topic name empty or invalid.'};
        if (!fs.existsSync(t.path)) return {ok: false, message: `No memory "${t.slug}" to forget.`};
        try { fs.unlinkSync(t.path); }
        catch (e) { return {ok: false, message: `Failed to delete: ${e?.message || e}`}; }
        this._rebuildIndex();
        return {ok: true, message: `Forgot memory "${t.slug}".`};
    }

    list() {
        try {
            return fs.readdirSync(this.dir)
                .filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
                .map(f => f.replace(/\.md$/, ''))
                .sort();
        } catch { return []; }
    }

    // What the LLM sees in $MEMORY every turn. First INDEX_LINE_CAP lines of
    // MEMORY.md verbatim, or a friendly empty-state line if no memories yet.
    serializeIndex() {
        const raw = this._readIndex();
        if (!raw.trim()) return 'No saved memories yet. Use !remember to save persistent facts.';
        const lines = raw.split('\n');
        if (lines.length <= INDEX_LINE_CAP) return raw.trimEnd();
        return lines.slice(0, INDEX_LINE_CAP).join('\n') + `\n... (${lines.length - INDEX_LINE_CAP} more lines truncated)`;
    }

    // Human-facing dump for !listMemory.
    formatForChat() {
        const topics = this.list();
        if (topics.length === 0) return 'No memories saved.';
        return `Memories (${topics.length}): ${topics.join(', ')}`;
    }
}
