// server/store.js
// Local persistent store for conversations, project context, and session metadata.
// Stores data in .isocode/ directory (per-workspace, survives restarts).

const fs = require('fs');
const path = require('path');

const STORE_DIR = path.join(process.cwd(), '.isocode');
const CONVERSATIONS_DIR = path.join(STORE_DIR, 'conversations');
const PROJECT_CONTEXT_PATH = path.join(STORE_DIR, 'project-context.json');
const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_SAVE = 100;

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// ---------------------------------------------------------------------------
// Conversation persistence
// ---------------------------------------------------------------------------

function getConversationPath(sessionId) {
    ensureDir(CONVERSATIONS_DIR);
    const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    return path.join(CONVERSATIONS_DIR, `${safe}.json`);
}

function saveConversation(sessionId, messages, metadata = {}) {
    try {
        const filePath = getConversationPath(sessionId);
        // Only save the last N messages to avoid huge files
        const toSave = messages.slice(-MAX_MESSAGES_PER_SAVE);
        const data = {
            sessionId,
            updatedAt: new Date().toISOString(),
            messageCount: toSave.length,
            metadata,
            messages: toSave.map(m => ({
                role: m.role,
                content: typeof m.content === 'string'
                    ? m.content.slice(0, 4000)
                    : JSON.stringify(m.content).slice(0, 4000)
            }))
        };
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.warn('[Store] Failed to save conversation:', e.message);
    }
}

function loadConversation(sessionId) {
    try {
        const filePath = getConversationPath(sessionId);
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function listConversations() {
    try {
        ensureDir(CONVERSATIONS_DIR);
        const files = fs.readdirSync(CONVERSATIONS_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                try {
                    const raw = fs.readFileSync(path.join(CONVERSATIONS_DIR, f), 'utf8');
                    const data = JSON.parse(raw);
                    return {
                        sessionId: data.sessionId,
                        updatedAt: data.updatedAt,
                        messageCount: data.messageCount,
                        preview: getConversationPreview(data)
                    };
                } catch { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        return files.slice(0, MAX_CONVERSATIONS);
    } catch {
        return [];
    }
}

function getConversationPreview(data) {
    if (!data?.messages?.length) return '';
    const firstUser = data.messages.find(m => m.role === 'user');
    if (!firstUser) return '';
    const content = typeof firstUser.content === 'string' ? firstUser.content : '';
    // Strip context preamble, find the actual user request
    const marker = content.indexOf('User request:\n');
    const text = marker >= 0 ? content.slice(marker + 14) : content;
    return text.trim().slice(0, 120);
}

function deleteConversation(sessionId) {
    try {
        const filePath = getConversationPath(sessionId);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return true;
    } catch { return false; }
}

// ---------------------------------------------------------------------------
// Project context — remembers facts about the workspace across sessions
// ---------------------------------------------------------------------------

function loadProjectContext() {
    try {
        if (!fs.existsSync(PROJECT_CONTEXT_PATH)) return {};
        const raw = fs.readFileSync(PROJECT_CONTEXT_PATH, 'utf8');
        return JSON.parse(raw) || {};
    } catch {
        return {};
    }
}

function saveProjectContext(ctx) {
    try {
        ensureDir(STORE_DIR);
        fs.writeFileSync(PROJECT_CONTEXT_PATH, JSON.stringify(ctx, null, 2), 'utf8');
    } catch (e) {
        console.warn('[Store] Failed to save project context:', e.message);
    }
}

/**
 * Update project context with auto-discovered facts.
 * Called after tool executions to remember things like:
 *   - Project type (Node.js, Python, etc.)
 *   - Key files (package.json, tsconfig, etc.)
 *   - Dependencies
 *   - Directory structure summary
 */
function updateProjectContext(key, value) {
    const ctx = loadProjectContext();
    ctx[key] = { value, updatedAt: new Date().toISOString() };
    // Cap total keys
    const keys = Object.keys(ctx);
    if (keys.length > 100) {
        delete ctx[keys[0]];
    }
    saveProjectContext(ctx);
}

/**
 * Build a concise project context string for injection into the system prompt.
 * Keeps it short to avoid wasting context window on stale info.
 */
function getProjectContextSummary() {
    const ctx = loadProjectContext();
    const entries = Object.entries(ctx);
    if (entries.length === 0) return '';

    const lines = entries
        .sort((a, b) => (b[1].updatedAt || '').localeCompare(a[1].updatedAt || ''))
        .slice(0, 15)
        .map(([k, v]) => `- ${k}: ${String(v.value).slice(0, 200)}`);

    return `\n\nProject context (remembered from previous sessions):\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Auto-discover project type from workspace
// ---------------------------------------------------------------------------

function discoverProjectType(workspaceRoot) {
    const root = workspaceRoot || process.cwd();
    const checks = [
        { file: 'package.json', type: 'node' },
        { file: 'requirements.txt', type: 'python' },
        { file: 'Cargo.toml', type: 'rust' },
        { file: 'go.mod', type: 'go' },
        { file: 'pom.xml', type: 'java-maven' },
        { file: 'build.gradle', type: 'java-gradle' },
        { file: 'Gemfile', type: 'ruby' },
        { file: 'pubspec.yaml', type: 'dart-flutter' },
        { file: 'composer.json', type: 'php' },
        { file: 'tsconfig.json', type: 'typescript' },
    ];

    const found = [];
    for (const c of checks) {
        if (fs.existsSync(path.join(root, c.file))) {
            found.push(c.type);
        }
    }

    if (found.length > 0) {
        updateProjectContext('projectType', found.join(', '));

        // Read package.json for Node projects
        if (found.includes('node') || found.includes('typescript')) {
            try {
                const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
                if (pkg.name) updateProjectContext('projectName', pkg.name);
                if (pkg.dependencies) {
                    updateProjectContext('dependencies', Object.keys(pkg.dependencies).slice(0, 20).join(', '));
                }
            } catch { }
        }
    }

    return found;
}

module.exports = {
    saveConversation,
    loadConversation,
    listConversations,
    deleteConversation,
    loadProjectContext,
    saveProjectContext,
    updateProjectContext,
    getProjectContextSummary,
    discoverProjectType
};
