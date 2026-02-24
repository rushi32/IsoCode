// server/context-manager.js
// Smart context window management for local LLMs.
// Handles: token estimation, message truncation, conversation compaction,
// and context budgeting — similar to IsoCode/Claude Code patterns.

const { callLLM } = require('./llm');

// ---------------------------------------------------------------------------
// Token estimation (rough, no tokenizer dependency needed)
// ~4 chars per token for English, ~3 for code. Use 3.5 as compromise.
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 3.5;

function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

function estimateMessagesTokens(messages) {
    if (!Array.isArray(messages)) return 0;
    let total = 0;
    for (const m of messages) {
        total += 4; // per-message overhead
        total += estimateTokens(m.role);
        total += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    }
    return total;
}

// ---------------------------------------------------------------------------
// Smart output truncation (keeps head + tail, not just head)
// ---------------------------------------------------------------------------

function smartTruncate(text, maxChars) {
    if (!text || typeof text !== 'string') return text || '';
    if (text.length <= maxChars) return text;

    const headSize = Math.floor(maxChars * 0.7);
    const tailSize = Math.floor(maxChars * 0.2);
    const head = text.slice(0, headSize);
    const tail = text.slice(-tailSize);
    const omitted = text.length - headSize - tailSize;
    return `${head}\n\n... [${omitted} characters omitted] ...\n\n${tail}`;
}

// ---------------------------------------------------------------------------
// Truncate tool/observation results to a budget
// ---------------------------------------------------------------------------

const MAX_TOOL_RESULT_CHARS = 3000;
const MAX_FILE_CONTENT_CHARS = 4000;

function truncateToolResult(result) {
    if (!result) return result;
    const s = typeof result === 'string' ? result : JSON.stringify(result);
    if (s.length <= MAX_TOOL_RESULT_CHARS) return result;

    // For objects, try to truncate specific large fields
    if (typeof result === 'object' && result !== null) {
        const clone = { ...result };
        if (typeof clone.content === 'string' && clone.content.length > MAX_FILE_CONTENT_CHARS) {
            clone.content = smartTruncate(clone.content, MAX_FILE_CONTENT_CHARS);
        }
        if (typeof clone.stdout === 'string' && clone.stdout.length > 2000) {
            clone.stdout = smartTruncate(clone.stdout, 2000);
        }
        if (typeof clone.stderr === 'string' && clone.stderr.length > 1000) {
            clone.stderr = smartTruncate(clone.stderr, 1000);
        }
        if (Array.isArray(clone.files) && clone.files.length > 80) {
            const total = clone.files.length;
            clone.files = clone.files.slice(0, 80);
            clone.files.push(`... and ${total - 80} more files`);
        }
        if (Array.isArray(clone.matches) && clone.matches.length > 30) {
            const total = clone.matches.length;
            clone.matches = clone.matches.slice(0, 30);
            clone.truncated = `Showing 30 of ${total} matches`;
        }
        const out = JSON.stringify(clone);
        if (out.length <= MAX_TOOL_RESULT_CHARS + 500) return clone;
        return smartTruncate(out, MAX_TOOL_RESULT_CHARS);
    }

    return smartTruncate(s, MAX_TOOL_RESULT_CHARS);
}

// ---------------------------------------------------------------------------
// Context-aware message trimming
// Keeps system prompt, recent user messages, and condenses old context.
// Budget-based: fits within a target token count.
// ---------------------------------------------------------------------------

function trimForContextWindow(messages, maxTokens) {
    if (!Array.isArray(messages) || messages.length <= 2) return messages;

    const budget = maxTokens || 6000; // conservative default for local models
    const system = messages[0];
    const systemTokens = estimateTokens(system?.content || '');

    // Reserve space: system prompt + response buffer (1024 tokens for model output)
    const available = budget - systemTokens - 1024;
    if (available <= 0) {
        // System prompt alone is too large — trim it
        const trimmedSystem = {
            ...system,
            content: smartTruncate(system.content, Math.floor(budget * CHARS_PER_TOKEN * 0.5))
        };
        return [trimmedSystem, messages[messages.length - 1]];
    }

    // Work backwards from most recent message, fitting within budget
    const rest = messages.slice(1);
    const kept = [];
    let usedTokens = 0;

    for (let i = rest.length - 1; i >= 0; i--) {
        const m = rest[i];
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
        let tokens = estimateTokens(content) + 4;

        if (usedTokens + tokens <= available) {
            kept.unshift(m);
            usedTokens += tokens;
        } else if (usedTokens + 100 <= available) {
            // Truncate this message to fit remaining budget
            const remainingChars = Math.floor((available - usedTokens - 20) * CHARS_PER_TOKEN);
            if (remainingChars > 200) {
                kept.unshift({
                    ...m,
                    content: smartTruncate(content, remainingChars)
                });
                usedTokens = available;
            }
            break;
        } else {
            break;
        }
    }

    console.log(`[Context] Trimmed ${rest.length} → ${kept.length} messages, ~${usedTokens + systemTokens} tokens (budget: ${budget})`);
    return [system, ...kept];
}

// ---------------------------------------------------------------------------
// Conversation compaction — summarize old messages into a compact form
// Uses the LLM itself to create a summary (like Claude Code's /compact)
// ---------------------------------------------------------------------------

async function compactConversation(messages, model) {
    if (!Array.isArray(messages) || messages.length <= 3) {
        return { messages, compacted: false };
    }

    const system = messages[0];
    const rest = messages.slice(1);

    // Keep last 4 messages verbatim, compact everything before
    const keepCount = Math.min(4, rest.length);
    const toCompact = rest.slice(0, rest.length - keepCount);
    const toKeep = rest.slice(rest.length - keepCount);

    if (toCompact.length < 2) {
        return { messages, compacted: false };
    }

    // Build a summary of old messages
    const summaryInput = toCompact.map(m => {
        const role = m.role || 'unknown';
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `[${role}]: ${content.slice(0, 500)}`;
    }).join('\n');

    let summary;
    try {
        summary = await callLLM({
            model,
            messages: [
                {
                    role: 'system',
                    content: 'Summarize this conversation history in 2-4 bullet points. Focus on: what was asked, what tools were used, what changes were made, what the current state is. Be very concise.'
                },
                { role: 'user', content: summaryInput.slice(0, 3000) }
            ],
            options: { max_tokens: 512, temperature: 0.3, timeout: 30000 }
        });
    } catch (e) {
        console.warn('[Context] Compact failed, using simple truncation:', e.message);
        // Fallback: simple summary without LLM
        summary = `Previous conversation (${toCompact.length} messages compacted): ` +
            toCompact.filter(m => m.role === 'user').map(m => {
                const c = typeof m.content === 'string' ? m.content : '';
                return c.slice(0, 100);
            }).join('; ');
    }

    const summaryStr = typeof summary === 'string' ? summary : (summary?.content || String(summary));
    const compactedMessage = {
        role: 'assistant',
        content: JSON.stringify({
            type: 'observation',
            content: `[Conversation summary — ${toCompact.length} older messages compacted]\n${summaryStr}`
        })
    };

    const result = [system, compactedMessage, ...toKeep];
    console.log(`[Context] Compacted ${messages.length} → ${result.length} messages`);
    return { messages: result, compacted: true, removedCount: toCompact.length };
}

// ---------------------------------------------------------------------------
// Auto-compact: trigger when messages exceed threshold
// ---------------------------------------------------------------------------

function shouldAutoCompact(messages, maxTokens) {
    const tokens = estimateMessagesTokens(messages);
    const threshold = (maxTokens || 6000) * 0.75; // compact at 75% of budget
    return tokens > threshold;
}

// ---------------------------------------------------------------------------
// Persistent memory: auto-save summaries to local .isocode/memory/
// This allows context to survive across sessions and model switches
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

function getMemoryDir(workspaceRoot) {
    const dir = path.join(workspaceRoot || process.cwd(), '.isocode', 'memory');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function saveSessionSummary(sessionId, summary, workspaceRoot) {
    try {
        const dir = getMemoryDir(workspaceRoot);
        const file = path.join(dir, `${sessionId}.json`);
        const data = {
            sessionId,
            timestamp: new Date().toISOString(),
            summary: typeof summary === 'string' ? summary : String(summary)
        };
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch { }
}

function loadSessionSummary(sessionId, workspaceRoot) {
    try {
        const dir = getMemoryDir(workspaceRoot);
        const file = path.join(dir, `${sessionId}.json`);
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    } catch { }
    return null;
}

function loadRecentSummaries(workspaceRoot, maxCount = 3) {
    try {
        const dir = getMemoryDir(workspaceRoot);
        if (!fs.existsSync(dir)) return [];
        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                const full = path.join(dir, f);
                return { name: f, mtime: fs.statSync(full).mtimeMs, full };
            })
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, maxCount);
        return files.map(f => {
            try { return JSON.parse(fs.readFileSync(f.full, 'utf8')); } catch { return null; }
        }).filter(Boolean);
    } catch { return []; }
}

/**
 * Build a context primer from recent session summaries.
 * Injected into agent system prompt so the LLM has memory of past sessions.
 */
function buildMemoryContext(workspaceRoot) {
    const summaries = loadRecentSummaries(workspaceRoot, 3);
    if (summaries.length === 0) return '';
    const lines = summaries.map(s =>
        `[${s.timestamp?.split('T')[0] || 'recent'}] ${s.summary?.slice(0, 200) || '(no summary)'}`
    );
    return '\n\nRECENT SESSION MEMORY:\n' + lines.join('\n');
}

module.exports = {
    estimateTokens,
    estimateMessagesTokens,
    smartTruncate,
    truncateToolResult,
    trimForContextWindow,
    compactConversation,
    shouldAutoCompact,
    saveSessionSummary,
    loadSessionSummary,
    loadRecentSummaries,
    buildMemoryContext,
    CHARS_PER_TOKEN,
    MAX_TOOL_RESULT_CHARS
};
