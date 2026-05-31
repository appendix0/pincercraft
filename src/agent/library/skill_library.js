import { cosineSimilarity } from '../../utils/math.js';
import { getSkillDocs } from './index.js';

// Lexical coverage scorer for skill-doc retrieval when no embedding model is
// configured. Counts how many of the task's meaningful words appear in a doc,
// after splitting camelCase + dotted names (so "smelt" / "go to" can match
// skills.smeltItem / skills.goToPosition) and dropping stopwords. Coverage is
// far more stable here than Jaccard word-overlap, which penalizes long
// descriptive docs and inflates short ones via shared stopwords.
const RETRIEVAL_STOPWORDS = new Set(
    'a an the to with into from of and or is are be this that your you it its on at in for some down up out'.split(' ')
);
function lexicalTokens(text) {
    return (text || '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')   // camelCase: smeltItem -> smelt Item
        .replace(/[^a-zA-Z]/g, ' ')             // dots/underscores/digits -> spaces
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 1 && !RETRIEVAL_STOPWORDS.has(w));
}
function coverageScore(message, doc) {
    const docWords = new Set(lexicalTokens(doc));
    const queryWords = [...new Set(lexicalTokens(message))];
    return queryWords.filter(w => docWords.has(w)).length;
}

export class SkillLibrary {
    constructor(agent,embedding_model) {
        this.agent = agent;
        this.embedding_model = embedding_model;
        this.skill_docs_embeddings = {};
        this.skill_docs = null;
        this.always_show_skills = ['skills.placeBlock', 'skills.wait', 'skills.breakBlockAt']
    }
    async initSkillLibrary() {
        const skillDocs = getSkillDocs();
        this.skill_docs = skillDocs;
        if (this.embedding_model) {
            try {
                const embeddingPromises = skillDocs.map((doc) => {
                    return (async () => {
                        let func_name_desc = doc.split('\n').slice(0, 2).join('');
                        this.skill_docs_embeddings[doc] = await this.embedding_model.embed(func_name_desc);
                    })();
                });
                await Promise.all(embeddingPromises);
            } catch (error) {
                console.warn('Error with embedding model, using word-overlap instead.');
                this.embedding_model = null;
            }
        }
        this.always_show_skills_docs = {};
        for (const skillName of this.always_show_skills) {
            this.always_show_skills_docs[skillName] = this.skill_docs.find(doc => doc.includes(skillName));
        }
    }

    async getAllSkillDocs() {
        return this.skill_docs;
    }

    async getRelevantSkillDocs(message, select_num) {
        if(!message) // use filler message if none is provided
            message = '(no message)';
        let skill_doc_similarities = [];

        if (select_num === -1) {
            skill_doc_similarities = Object.keys(this.skill_docs_embeddings)
            .map(doc_key => ({
                doc_key,
                similarity_score: 0
            }));
        }
        else if (!this.embedding_model) {
            // No embedding model: rank docs by lexical coverage of the task's
            // meaningful words. Previously this iterated skill_docs_embeddings
            // (empty without an embedding model) and passed a would-be vector to
            // a text function, so it ranked nothing — every task fell back to
            // just the always-show docs, which is why the coder hallucinated
            // APIs on non-gather tasks. Coverage-ranking this.skill_docs revives
            // retrieval for all task families (craft/smelt/build/navigate/...).
            skill_doc_similarities = this.skill_docs
                .map(doc => ({
                    doc_key: doc,
                    similarity_score: coverageScore(message, doc)
                }))
                .sort((a, b) => b.similarity_score - a.similarity_score);
        }
        else {
            let latest_message_embedding = await this.embedding_model.embed(message);
            skill_doc_similarities = Object.keys(this.skill_docs_embeddings)
            .map(doc_key => ({
                doc_key,
                similarity_score: cosineSimilarity(latest_message_embedding, this.skill_docs_embeddings[doc_key])
            }))
            .sort((a, b) => b.similarity_score - a.similarity_score);
        }

        let length = skill_doc_similarities.length;
        if (select_num === -1 || select_num > length) {
            select_num = length;
        }
        // Get initial docs from similarity scores
        let selected_docs = new Set(skill_doc_similarities.slice(0, select_num).map(doc => doc.doc_key));
        
        // Add always show docs
        Object.values(this.always_show_skills_docs).forEach(doc => {
            if (doc) {
                selected_docs.add(doc);
            }
        });

        // Resource-gathering tasks need the mining API in context, or the coder
        // hallucinates skills.mineBlock / passes the wrong arg shape (task #188).
        // Surface skills.mineBlockAt + skills.collectBlock when the task asks to
        // chop/mine/break/collect/gather/harvest/dig.
        if (/\b(chop|mine|mining|break|collect|gather|harvest|dig)\w*/i.test(message)) {
            for (const skillName of ['skills.mineBlockAt', 'skills.collectBlock']) {
                // Match the doc whose first line is the skill name — a loose
                // includes() would catch docs that merely cross-reference it.
                const doc = this.skill_docs.find(d => d.startsWith(skillName + '\n'));
                if (doc) selected_docs.add(doc);
            }
        }

        let relevant_skill_docs = '#### RELEVANT CODE DOCS ###\nThe following functions are available to use:\n';
        relevant_skill_docs += Array.from(selected_docs).join('\n### ');

        console.log('Selected skill docs:', Array.from(selected_docs).map(doc => {
            const first_line_break = doc.indexOf('\n');
            return first_line_break > 0 ? doc.substring(0, first_line_break) : doc;
        }));
        return relevant_skill_docs;
    }
}
