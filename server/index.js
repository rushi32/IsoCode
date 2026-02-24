// server/index.js
// IsoCode Agent Server — Express HTTP server
// Supports Ollama, LM Studio, and OpenAI-compatible LLM backends.

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const { runAgent, compactSession, switchModel, activeAgents } = require('./agent');
const { callLLM, streamChat, listModels, healthCheck } = require('./llm');
const { PORT, LLM_API_BASE, LLM_API_KEY, LLM_PROVIDER, LLM_MODEL_ID, LLM_NATIVE_BASE } = require('./config');
const { listConversations, loadConversation, deleteConversation } = require('./store');
const { estimateMessagesTokens } = require('./context-manager');
const { getIndex, buildProjectMap } = require('./codebase');

const app = express();

app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// CORS for local development
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

/* ------------------------------------------------------------------ */
/* ROOT — status page                                                  */
/* ------------------------------------------------------------------ */

app.get('/', (_req, res) => {
    res.type('html').send(`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>IsoCode Agent Server</title></head>
<body style="font-family: system-ui; padding: 2rem; max-width: 40rem; margin: 0 auto; color: #e0e0e0; background: #1e1e1e;">
  <h1 style="color: #fff;">IsoCode Agent Server</h1>
  <p>Server is running. Use the <strong>IsoCode</strong> extension in VS Code to chat.</p>
  <table style="width: 100%; border-collapse: collapse; margin-top: 1rem;">
    <tr><td style="padding: 4px 8px; color: #888;">Provider:</td><td style="padding: 4px 8px; color: #4fc3f7;">${LLM_PROVIDER}</td></tr>
    <tr><td style="padding: 4px 8px; color: #888;">API Base:</td><td style="padding: 4px 8px;"><code>${LLM_API_BASE}</code></td></tr>
    <tr><td style="padding: 4px 8px; color: #888;">Default Model:</td><td style="padding: 4px 8px;"><code>${LLM_MODEL_ID}</code></td></tr>
  </table>
  <h3 style="margin-top: 1.5rem; color: #ccc;">Premium Features</h3>
  <ul style="color:#aaa;">
    <li>Auto-context: codebase indexing + smart file relevance</li>
    <li>Project rules: .isocode/rules.md, AGENTS.md, .cursorrules (legacy)</li>
    <li>Git tools: status, diff, log, commit, branch</li>
    <li>Lint/Test loops: auto-detect eslint/tsc/pytest/cargo + verify</li>
    <li>Streaming chat: token-by-token output (SSE)</li>
    <li>Context management: auto-compact, smart truncation</li>
    <li>Persistent memory: conversations + project facts</li>
    <li>28+ agentic tools for full coding autonomy</li>
  </ul>
  <h3 style="margin-top: 1.5rem; color: #ccc;">Endpoints</h3>
  <ul>
    <li><code>GET /health</code> — health check (LLM connectivity)</li>
    <li><code>GET /models</code> — list available models</li>
    <li><code>POST /chat</code> — chat (streaming SSE) or agent mode</li>
    <li><code>GET /codebase</code> — view project index</li>
    <li><code>POST /codebase/reindex</code> — refresh file index</li>
    <li><code>POST /compact</code> — compact conversation context</li>
    <li><code>GET /sessions</code> — list active and saved sessions</li>
    <li><code>POST /config</code> — runtime configuration</li>
  </ul>
  <p style="color: #888; font-size: 0.85rem; margin-top: 2rem;">
    ${LLM_PROVIDER === 'ollama'
            ? 'Ollama: ensure <code>ollama serve</code> is running at <code>http://localhost:11434</code>'
            : LLM_PROVIDER === 'lmstudio'
                ? 'LM Studio: ensure it is running at <code>http://localhost:1234</code> with a model loaded.'
                : `OpenAI-compatible server at <code>${LLM_API_BASE}</code>`
        }
  </p>
</body>
</html>
    `);
});

/* ------------------------------------------------------------------ */
/* HEALTH CHECK                                                        */
/* ------------------------------------------------------------------ */

app.get('/health', async (_req, res) => {
    const result = await healthCheck();
    res.json(result);
});

/* ------------------------------------------------------------------ */
/* CONFIG                                                              */
/* ------------------------------------------------------------------ */

app.post('/config', (req, res) => {
    const incoming = req.body || {};
    const userConfigPath = path.join(process.cwd(), 'user-config.json');
    fs.writeFileSync(userConfigPath, JSON.stringify(incoming, null, 2));

    try {
        const runtime = require('./config.js');
        if (incoming.PERMISSIONS && typeof incoming.PERMISSIONS === 'object') {
            runtime.PERMISSIONS = runtime.PERMISSIONS || {};
            Object.assign(runtime.PERMISSIONS, incoming.PERMISSIONS);
        }
        if (Array.isArray(incoming.MCP_SERVERS)) {
            runtime.MCP_SERVERS = runtime.MCP_SERVERS || [];
            runtime.MCP_SERVERS.length = 0;
            for (const s of incoming.MCP_SERVERS) {
                if (s && s.name && s.command) {
                    runtime.MCP_SERVERS.push(s);
                    console.log(`[Config] MCP server registered: ${s.name} (${s.command} ${(s.args || []).join(' ')})`);
                }
            }
            console.log(`[Config] Total MCP servers: ${runtime.MCP_SERVERS.length}`);
        }
        if (incoming.MAX_HISTORY_MESSAGES != null) runtime.MAX_HISTORY_MESSAGES = incoming.MAX_HISTORY_MESSAGES;
        if (incoming.CONTEXT_WINDOW_SIZE != null) runtime.CONTEXT_WINDOW_SIZE = incoming.CONTEXT_WINDOW_SIZE;
        if (incoming.SYSTEM_PROMPT != null) runtime.SYSTEM_PROMPT = incoming.SYSTEM_PROMPT;
        if (incoming.LLM_API_BASE) runtime.LLM_API_BASE = incoming.LLM_API_BASE;
        if (incoming.LLM_MODEL_ID) runtime.LLM_MODEL_ID = incoming.LLM_MODEL_ID;
        if (incoming.LLM_PROVIDER) runtime.LLM_PROVIDER = incoming.LLM_PROVIDER;
    } catch (e) {
        console.error('[Server] Failed applying runtime config:', e.message);
    }

    res.json({ success: true, mcpServers: (incoming.MCP_SERVERS || []).length });
});

app.get('/mcp-status', async (_req, res) => {
    const config = require('./config.js');
    const servers = config.MCP_SERVERS || [];
    res.json({
        configured: servers.length,
        servers: servers.map(s => ({ name: s.name, command: s.command, args: s.args }))
    });
});

/* ------------------------------------------------------------------ */
/* CHAT                                                                */
/* ------------------------------------------------------------------ */

app.post('/chat', async (req, res) => {
    const {
        message,
        autoMode = false,
        agentPlus = false,
        model,
        sessionId = 'default',
        decision,
        context,
        workspaceRoot
    } = req.body || {};

    console.log('[Server] POST /chat', {
        hasMessage: !!message,
        messageLen: typeof message === 'string' ? message.length : 0,
        model: model || '(default)',
        autoMode,
        hasDecision: decision != null,
        provider: LLM_PROVIDER
    });

    if (!message && decision == null) {
        return res.status(400).json({ error: 'message or decision required' });
    }

    const buildUserContent = (msg) => {
        if (!context || !Array.isArray(context) || context.length === 0) return msg;
        const preamble = context.map((c) =>
            (c.path ? `File: ${c.path}\n` : '') + (c.content ? `\n\`\`\`\n${c.content}\n\`\`\`` : '')
        ).join('\n\n');
        return `${preamble}\n\nUser request:\n${msg}`;
    };

    /* ---------- BASIC CHAT (STREAMING) ---------- */
    if (!autoMode && message) {
        const userContent = buildUserContent(message);
        console.log('[Server] Streaming chat, model:', model || LLM_MODEL_ID);

        // Check if client wants streaming
        const wantsStream = req.headers.accept?.includes('text/event-stream');

        if (wantsStream) {
            // SSE streaming — token by token
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders?.();

            try {
                const stream = streamChat({
                    model,
                    messages: [{ role: 'user', content: userContent }],
                    options: { max_tokens: 4096, temperature: 0.7, timeout: 120000 }
                });

                for await (const chunk of stream) {
                    res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
                }
                res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            } catch (err) {
                console.error('[Server] Streaming chat error:', err.message);
                res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
            }
            res.end();
            return;
        }

        // Non-streaming fallback
        try {
            const out = await callLLM({
                model,
                messages: [{ role: 'user', content: userContent }],
                options: { max_tokens: 4096, temperature: 0.7, timeout: 120000 }
            });
            const responseStr = typeof out === 'string' ? out : (out?.content || JSON.stringify(out));
            console.log('[Server] Chat response length:', responseStr.length);
            return res.json({ response: responseStr });
        } catch (err) {
            console.error('[Server] Chat LLM error:', err.message);
            const details = err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || String(err));
            return res.status(500).json({
                error: 'LLM failed',
                details,
                hint: LLM_PROVIDER === 'ollama'
                    ? 'Ensure Ollama is running (ollama serve) and the model is pulled (ollama pull <model>).'
                    : LLM_PROVIDER === 'lmstudio'
                        ? 'Ensure LM Studio is running and a model is loaded.'
                        : 'Check your LLM API configuration.'
            });
        }
    }

    /* ---------- AGENT MODE (SSE) ---------- */
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (obj) => {
        try {
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify(obj)}\n\n`);
            }
        } catch { }
    };

    try {
        console.log('[Server] Starting agent (SSE), model:', model || LLM_MODEL_ID, 'provider:', LLM_PROVIDER);
        await runAgent({
            sessionId,
            message: buildUserContent(message || ''),
            decision,
            model,
            agentPlus: !!agentPlus,
            workspaceRoot,
            send,
            maxSteps: 500
        });
        console.log('[Server] Agent finished');
    } catch (err) {
        console.error('[Server] Agent error:', err.message);
        send({ type: 'final', content: String(err) });
    } finally {
        res.end();
    }
});

app.post('/stop-agent', (req, res) => {
    const { sessionId = 'default' } = req.body || {};
    const state = activeAgents.get(sessionId);
    if (state) {
        state.stopRequested = true;
        console.log(`[Server] Stop requested for session: ${sessionId}`);
        res.json({ ok: true });
    } else {
        res.json({ ok: false, error: 'No active session' });
    }
});

/* ------------------------------------------------------------------ */
/* COMPACT — compress conversation context                             */
/* ------------------------------------------------------------------ */

app.post('/clear-session', (req, res) => {
    const { sessionId } = req.body || {};
    if (sessionId && activeAgents.has(sessionId)) {
        activeAgents.delete(sessionId);
        console.log(`[Server] Cleared agent session: ${sessionId}`);
    }
    res.json({ ok: true });
});

app.post('/compact', async (req, res) => {
    const { sessionId = 'default', model } = req.body || {};
    console.log(`[Server] POST /compact session=${sessionId}`);
    try {
        const result = await compactSession(sessionId, model);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ------------------------------------------------------------------ */
/* SESSIONS — list, load, delete conversations                         */
/* ------------------------------------------------------------------ */

app.get('/sessions', (_req, res) => {
    const saved = listConversations();
    // Also include active in-memory sessions
    const active = [];
    for (const [id, state] of activeAgents.entries()) {
        active.push({
            sessionId: id,
            active: true,
            messageCount: state.messages?.length || 0,
            estimatedTokens: estimateMessagesTokens(state.messages || []),
            model: state.model || LLM_MODEL_ID
        });
    }
    res.json({ active, saved });
});

app.get('/sessions/:id', (req, res) => {
    const conv = loadConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Session not found' });
    res.json(conv);
});

app.delete('/sessions/:id', (req, res) => {
    deleteConversation(req.params.id);
    activeAgents.delete(req.params.id);
    res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* MODEL SWITCH                                                        */
/* ------------------------------------------------------------------ */

app.post('/switch-model', async (req, res) => {
    const { sessionId = 'default', model } = req.body || {};
    if (!model) return res.status(400).json({ error: 'model required' });
    console.log(`[Server] POST /switch-model session=${sessionId} model=${model}`);
    try {
        const result = await switchModel(sessionId, model, () => {});
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ------------------------------------------------------------------ */
/* CODEBASE INDEX                                                      */
/* ------------------------------------------------------------------ */

app.get('/codebase', async (req, res) => {
    const workspaceRoot = req.query.root || process.cwd();
    try {
        const index = await getIndex(workspaceRoot);
        const map = buildProjectMap(index);
        res.json({
            fileCount: index.fileCount,
            dirs: index.dirs.length,
            keyFiles: Object.keys(index.keyFiles),
            map,
            timestamp: index.timestamp
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/codebase/reindex', async (req, res) => {
    const { invalidateIndex } = require('./codebase');
    invalidateIndex();
    const workspaceRoot = req.body?.root || process.cwd();
    try {
        const index = await getIndex(workspaceRoot);
        res.json({ ok: true, fileCount: index.fileCount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ------------------------------------------------------------------ */
/* MODELS                                                              */
/* ------------------------------------------------------------------ */

app.get('/models', async (_req, res) => {
    console.log(`[Server] GET /models (provider: ${LLM_PROVIDER})`);

    try {
        const models = await listModels();
        console.log(`[Server] Found ${models.length} model(s)`);
        res.status(200).json({ models, provider: LLM_PROVIDER });
    } catch (error) {
        console.error('[Server] GET /models failed:', error.code || error.message);
        const hint = LLM_PROVIDER === 'ollama'
            ? 'Ensure Ollama is running: ollama serve'
            : LLM_PROVIDER === 'lmstudio'
                ? 'Ensure LM Studio is running with a model loaded.'
                : 'Check your LLM API configuration.';
        res.status(200).json({
            models: [],
            provider: LLM_PROVIDER,
            error: error.code === 'ECONNREFUSED'
                ? `Cannot reach ${LLM_PROVIDER} server. ${hint}`
                : error.message
        });
    }
});

/* ------------------------------------------------------------------ */
/* START                                                               */
/* ------------------------------------------------------------------ */

app.listen(PORT, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║       IsoCode Agent Server                   ║');
    console.log('  ╠══════════════════════════════════════════════╣');
    console.log(`  ║  URL:      http://localhost:${PORT}              ║`);
    console.log(`  ║  Provider: ${String(LLM_PROVIDER).padEnd(33)}║`);
    console.log(`  ║  API Base: ${String(LLM_API_BASE).slice(0, 33).padEnd(33)}║`);
    console.log(`  ║  Model:    ${String(LLM_MODEL_ID).slice(0, 33).padEnd(33)}║`);
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');

    // Run a quick health check on startup
    healthCheck().then(result => {
        if (result.ok) {
            console.log(`  ✓ ${LLM_PROVIDER} server is reachable`);
        } else {
            console.warn(`  ✗ ${LLM_PROVIDER} server is NOT reachable: ${result.error}`);
            if (LLM_PROVIDER === 'ollama') {
                console.warn('    → Run "ollama serve" and pull a model: "ollama pull qwen2.5-coder:7b"');
            } else if (LLM_PROVIDER === 'lmstudio') {
                console.warn('    → Start LM Studio and load a model');
            }
        }
        console.log('');
    });
});
