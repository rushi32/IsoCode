// server/agent.js
// Agentic loop: ReAct (Reason→Act→Observe) framework with task planning.
// Agent+ auto-approves all permissions. Agent asks for approval on file mutations.
// Both modes plan tasks first, then implement one-by-one until complete.
// Auto-saves context summaries to .isocode/ to prevent context loss.

const activeAgents = new Map();

const { callLLM, listModels } = require('./llm');
const { runTool, TOOL_DEFINITIONS } = require('./tools');
const { MAX_HISTORY_MESSAGES, CONTEXT_WINDOW_SIZE, LLM_PROVIDER, SWARM_MAX_WORKERS, SWARM_VISION_MODEL } = require('./config.js');
const { trimForContextWindow, truncateToolResult, shouldAutoCompact, compactConversation, estimateMessagesTokens, saveSessionSummary, buildMemoryContext } = require('./context-manager.js');
const { saveConversation, getProjectContextSummary, discoverProjectType } = require('./store.js');
const { getIndex, buildProjectMap, gatherAutoContext } = require('./codebase.js');
const { loadProjectRules } = require('./rules.js');
const fs = require('fs');
const path = require('path');
const { createTwoFilesPatch } = require('diff');

/** Ensure path stays inside workspace (prevents path traversal). */
function resolvePathInWorkspace(workspaceRoot, filePath) {
    const root = path.resolve(workspaceRoot || process.cwd());
    const resolved = path.resolve(root, String(filePath).replace(/^\/+/, ''));
    const normalizedRoot = root + path.sep;
    if (resolved !== root && !resolved.startsWith(normalizedRoot)) {
        throw new Error(`Security: path outside workspace denied for: ${filePath}`);
    }
    return resolved;
}

const CONTEXT_BUDGET = typeof CONTEXT_WINDOW_SIZE === 'number' && CONTEXT_WINDOW_SIZE > 0
    ? CONTEXT_WINDOW_SIZE
    : 16000;

// ---------------------------------------------------------------------------
// JSON extraction from model output (handles many wrapper formats)
// ---------------------------------------------------------------------------

function extractAgentJson(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();

    const msgMatch = s.match(/<\|message\|>\s*(\{[\s\S]*\})\s*$/);
    if (msgMatch) return msgMatch[1];

    const fenceMatch = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
        const inner = fenceMatch[1].trim();
        if (inner.startsWith('{')) return inner;
    }

    const lastBrace = s.lastIndexOf('}');
    if (lastBrace > 0) {
        let depth = 0;
        let start = -1;
        for (let i = 0; i <= lastBrace; i++) {
            if (s[i] === '{') { if (depth === 0) start = i; depth++; }
            if (s[i] === '}') depth--;
            if (depth === 0 && start >= 0) {
                const candidate = s.slice(start, i + 1);
                try { JSON.parse(candidate); return candidate; } catch { start = -1; }
            }
        }
    }

    if (s.startsWith('{') && s.endsWith('}')) return s;
    return null;
}

function parseWrappedAction(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    const actionMatch = s.match(/action\s*=\s*"([^"]+)"/i);
    if (!actionMatch) return null;
    const tool = actionMatch[1];
    const argsMatch = s.match(/args\s*=\s*(\{[\s\S]*\})/i);
    let args = {};
    if (argsMatch) {
        let a = argsMatch[1].trim();
        for (let i = 0; i < 4; i++) {
            try { args = JSON.parse(a); break; } catch (_) {
                if (a.endsWith('}')) a = a.slice(0, -1).trim();
                else break;
            }
        }
    }
    return { type: 'action', tool, args };
}

function salvageNonJsonResponse(text) {
    if (!text || typeof text !== 'string') return null;
    const t = text.toLowerCase();

    const readMatch = text.match(/(?:read|look at|open|examine|check)\s+(?:the\s+)?(?:file\s+)?[`"']?([^\s`"']+\.\w+)[`"']?/i);
    if (readMatch) {
        return { type: 'action', tool: 'read_file', args: { path: readMatch[1] } };
    }

    const shellMatch = text.match(/(?:run|execute|install)\s+[`"'](.+?)[`"']/i);
    if (shellMatch) {
        return { type: 'action', tool: 'run_shell', args: { command: shellMatch[1] } };
    }

    const searchMatch = text.match(/(?:search|find|grep|look for)\s+[`"']?(.+?)[`"']?(?:\s+in|\s*$)/i);
    if (searchMatch) {
        return { type: 'action', tool: 'search_files', args: { query: searchMatch[1].slice(0, 60) } };
    }

    if (t.includes('list') && (t.includes('file') || t.includes('director'))) {
        const pathMatch = text.match(/(?:in|at|of)\s+[`"']?([^\s`"']+)[`"']?/i);
        return { type: 'action', tool: 'list_files', args: { path: pathMatch?.[1] || '.' } };
    }

    if (t.includes('i need to') || t.includes('let me') || t.includes('i will') || t.includes('first,') || t.includes('my plan')) {
        return { type: 'thought', content: text.slice(0, 500) };
    }

    return null;
}

function extractLatestUserRequest(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role !== 'user' || typeof m?.content !== 'string') continue;
        const marker = 'User request:\n';
        const idx = m.content.lastIndexOf(marker);
        if (idx >= 0) return m.content.slice(idx + marker.length).trim();
        return m.content.trim();
    }
    return '';
}

function extractContextFileFromMessage(userContent) {
    if (!userContent || typeof userContent !== 'string') return null;
    const fileMatch = userContent.match(/File:\s*(.+?)(?:\n|$)/);
    if (!fileMatch) return null;
    const filePath = fileMatch[1].trim();
    const codeMatch = userContent.match(/```\s*\n?([\s\S]*?)```/);
    const content = codeMatch ? codeMatch[1].trimEnd() : '';
    return { filePath, content };
}

// ---------------------------------------------------------------------------
// Tool definitions for system prompt
// ---------------------------------------------------------------------------

function buildToolListForPrompt() {
    const categories = {
        'File Operations': ['read_file', 'write_file', 'replace_in_file', 'apply_diff', 'batch_read'],
        'Search & Navigation': ['list_files', 'glob_files', 'search_files', 'codebase_search'],
        'Shell & Execution': ['run_shell'],
        'Git': ['git_status', 'git_diff', 'git_log', 'git_commit', 'git_branch'],
        'Lint & Test': ['run_lint', 'run_tests'],
        'Memory & Tasks': ['memory_read', 'memory_write', 'memory_list', 'task_list', 'task_update'],
        'Web & Browser': ['read_url', 'read_docs', 'open_in_system_browser', 'screenshot_url', 'analyze_image'],
        'Browser Automation': ['browser_open', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_extract', 'browser_evaluate', 'browser_wait', 'browser_close'],
        'MCP': ['mcp_list_tools', 'mcp_call_tool']
    };

    const toolMap = {};
    for (const t of TOOL_DEFINITIONS) toolMap[t.name] = t;

    const lines = [];
    for (const [cat, names] of Object.entries(categories)) {
        lines.push(`[${cat}]`);
        for (const name of names) {
            const t = toolMap[name];
            if (!t) continue;
            const params = t.parameters?.properties
                ? Object.entries(t.parameters.properties).map(([k, v]) => {
                    const req = (t.parameters.required || []).includes(k) ? '*' : '';
                    return `${k}${req}`;
                }).join(', ')
                : '';
            lines.push(`  ${t.name}(${params}) — ${t.description}`);
        }
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// System prompt — ReAct framework with task planning
// ---------------------------------------------------------------------------

function buildSystemPrompt(isAgentPlus) {
    const planningSection = `
TASK PLANNING — MANDATORY FOR EVERY NON-TRIVIAL REQUEST:
Before implementing, you MUST create a plan using a thought ONCE at the start:
{"type":"thought","content":"PLAN:\\n1. [task 1]\\n2. [task 2]\\n...\\nLet me start with task 1."}
Do NOT repeat the same plan thought in later turns; only PROGRESS thoughts after that.

After completing each task in your plan, emit a thought tracking progress:
{"type":"thought","content":"PROGRESS: Completed task 1. Moving to task 2."}

Continue until ALL planned tasks are done. Do NOT emit {"type":"final"} until every task is complete.
`;

    const permissionSection = isAgentPlus
        ? `
PERMISSIONS — Agent+ Mode:
- ALL permissions are GRANTED. You do NOT need to ask for approval.
- Apply file changes directly without waiting for user review.
- Execute shell commands without asking.
- You have FULL AUTONOMY. Complete the task end-to-end.
- Do NOT stop for approval. Do NOT emit diff_request — use write_file or replace_in_file directly.
- Keep working until EVERY planned task is DONE.

SWARM (optional): For large tasks with 2+ independent subtasks, delegate:
{"type":"delegate","tasks":["subtask 1","subtask 2"]}
The system auto-selects the best model per subtask. Up to ${Math.min(2, SWARM_MAX_WORKERS || 2)} workers run in parallel.
`
        : `
PERMISSIONS — Agent Mode:
- File reads, searches, shell commands: GRANTED automatically.
- File WRITES/EDITS: Propose as diff_request for user approval.
- After user approves/rejects, CONTINUE with the next task. Do not stop.
- You will receive an observation after each approval telling you the result.
`;

    return `You are IsoCode, an expert autonomous AI coding agent embedded in VS Code.
You operate using the ReAct framework: Reason → Act → Observe → Repeat.
You have full access to the user's workspace: read, write, search, execute, git, lint, and test.

CORE IDENTITY:
- You are an AGENT, not a chatbot. You TAKE ACTIONS using tools.
- You NEVER just describe what you would do — you DO IT.
- You complete tasks END-TO-END. You do not stop until the job is done.
- You verify your work after making changes.

RESPONSE FORMAT — Respond with exactly ONE JSON object per turn:

{"type":"thought","content":"reasoning"}
  Reason about your approach. Use for planning and progress tracking.

{"type":"action","tool":"tool_name","args":{...}}
  Execute a tool. You will receive the observation result in the next turn.

{"type":"diff_request","filePath":"path","diff":"unified diff"}
  Propose a file change for user review (Agent mode only).

{"type":"final","content":"response to user"}
  ONLY when ALL tasks are COMPLETE. Summarize what you did.
${planningSection}${permissionSection}
ReAct LOOP — Follow this on EVERY turn:
1. REASON: Think about what to do next (thought)
2. ACT: Use a tool to take action (action)
3. OBSERVE: Read the tool result
4. REPEAT: Go back to step 1 until the task is fully complete
5. FINALIZE: Only when everything is done, emit {"type":"final"}

AVAILABLE TOOLS:
${buildToolListForPrompt()}

WORKFLOW for coding tasks:
1. PLAN: Create a numbered task list (thought)
2. EXPLORE: Search/read relevant code (codebase_search, read_file, list_files)
3. IMPLEMENT: Make changes one task at a time
4. VERIFY: After each change, check with read_file, run_lint, or run_tests
5. CONTINUE: Move to next task. Track progress with thoughts.
6. FINALIZE: When ALL tasks are done, summarize results (final)

CRITICAL RULES:
- NEVER emit {"type":"final"} before all tasks are complete.
- ALWAYS use tools. If the user asks to run something → run_shell. Open URL → open_in_system_browser. Install → run_shell.
- Read a file BEFORE modifying it (unless user provided it as context).
- After errors, RECOVER: try a different approach, don't give up.
- If context gets large, use memory_write to persist important findings.
- Make surgical, targeted changes. Don't rewrite entire files.

CONTEXT FILE HANDLING:
When the user provides a file via File: <path> with a code block:
- You already have the content. Do NOT call read_file on it again.
- Prefer editing this file unless the task needs others.
- Go directly to making the change.

EFFICIENCY:
- Don't re-read files the user already provided.
- For simple edits: replace_in_file (1 step) over read_file + write_file (2 steps).
- Use batch_read for multiple files.
`;
}

// ---------------------------------------------------------------------------
// Build OpenAI-format tool definitions for native function calling
// ---------------------------------------------------------------------------

function buildNativeTools() {
    return TOOL_DEFINITIONS.map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters || { type: 'object', properties: {} }
        }
    }));
}

// ---------------------------------------------------------------------------
// Context checkpoint: save summarized .md to .isocode/ periodically
// ---------------------------------------------------------------------------

function saveContextCheckpoint(state, resolvedModel) {
    if (!state || !state.workspaceRoot) return;
    const wsRoot = state.workspaceRoot;
    const dir = path.join(wsRoot, '.isocode', 'checkpoints');
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch { return; }

    const messages = state.messages || [];
    const userMsgs = messages.filter(m => m.role === 'user').map(m => {
        const c = typeof m.content === 'string' ? m.content : '';
        return c.slice(0, 200);
    });
    const toolActions = messages.filter(m => {
        if (m.role !== 'assistant') return false;
        try {
            const p = JSON.parse(m.content);
            return p.type === 'action';
        } catch { return false; }
    }).map(m => {
        try {
            const p = JSON.parse(m.content);
            return `- ${p.tool}(${Object.keys(p.args || {}).join(', ')})`;
        } catch { return ''; }
    }).filter(Boolean);

    const thoughts = messages.filter(m => {
        if (m.role !== 'assistant') return false;
        try { return JSON.parse(m.content).type === 'thought'; } catch { return false; }
    }).map(m => {
        try { return JSON.parse(m.content).content?.slice(0, 150) || ''; } catch { return ''; }
    }).filter(Boolean);

    const md = `# Session Checkpoint: ${state.sessionId}
Date: ${new Date().toISOString()}
Model: ${resolvedModel || 'unknown'}
Mode: ${state.agentPlus ? 'Agent+' : 'Agent'}
Steps: ${state.step}

## User Requests
${userMsgs.map(u => `- ${u}`).join('\n')}

## Key Thoughts
${thoughts.slice(-5).map(t => `- ${t}`).join('\n')}

## Tool Actions (${toolActions.length} total)
${toolActions.slice(-15).join('\n')}

## Current Plan
${state.currentPlan || '(no plan recorded)'}
`;

    try {
        const filename = `${state.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`;
        fs.writeFileSync(path.join(dir, filename), md);
    } catch { }
}

// ---------------------------------------------------------------------------
// Agent loop — ReAct framework
// ---------------------------------------------------------------------------

async function runAgent({
    sessionId,
    message,
    decision,
    model,
    agentPlus = false,
    workspaceRoot,
    send,
    maxSteps = 12
}) {
    let state = activeAgents.get(sessionId);

    // Resume (approve/reject) with no active session — e.g. server restarted or wrong sessionId
    if (decision != null && !state) {
        send({ type: 'final', content: 'No active agent session to resume. Start a new request.' });
        return;
    }

    // Handle approval / rejection of a pending diff
    if (decision && state && !state.pendingDiff) {
        send({ type: 'final', content: 'No pending diff to approve or reject. Send a new message to continue.' });
        return;
    }
    if (decision && state?.pendingDiff) {
        if (decision === 'approve') {
            const pd = state.pendingDiff;
            let applyResult;
            try {
                applyResult = await runTool('apply_diff', { filePath: pd.filePath, diff: pd.diff }, { workspaceRoot: state.workspaceRoot, autoMode: true });
            } catch (e) {
                applyResult = { error: String(e) };
            }
            state.messages.push({
                role: 'assistant',
                content: JSON.stringify({
                    type: 'observation',
                    content: applyResult?.error
                        ? `Failed to apply diff: ${applyResult.error}. Try a different approach.`
                        : 'User APPROVED. Diff applied successfully. Continue with the next task in your plan.'
                })
            });
        } else {
            state.messages.push({
                role: 'assistant',
                content: JSON.stringify({
                    type: 'observation',
                    content: 'User REJECTED the diff. Try a different approach or ask for clarification. Continue with the next task.'
                })
            });
        }
        state.pendingDiff = null;
        // After approval/rejection, CONTINUE the loop — don't stop
    }

    // Initialize session
    if (!state) {
        const SYSTEM_PROMPT = buildSystemPrompt(agentPlus);

        const wsRoot = workspaceRoot || process.cwd();
        let projectCtx = '';
        let projectMap = '';
        let projectRules = '';

        try { discoverProjectType(wsRoot); } catch { }
        try { projectCtx = getProjectContextSummary(); } catch { }
        try {
            const index = await getIndex(wsRoot);
            projectMap = '\n\nPROJECT MAP:\n' + buildProjectMap(index);
        } catch { }
        try { projectRules = await loadProjectRules(wsRoot); } catch { }

        const hasExplicitContext = message && (message.includes('File:') || message.includes('```'));
        let autoCtx = '';
        if (!hasExplicitContext) {
            try {
                autoCtx = await gatherAutoContext(message || '', wsRoot, 3000);
            } catch { }
        }

        let contextNudge = '';
        if (hasExplicitContext) {
            const contextFile = extractContextFileFromMessage(message);
            if (contextFile) {
                contextNudge = `\n\nThe user provided file "${contextFile.filePath}". Work on it directly. Do NOT read it again.`;
            }
        }

        let memoryCtx = '';
        try { memoryCtx = buildMemoryContext(wsRoot); } catch { }

        // Load previous checkpoint if exists
        let checkpointCtx = '';
        try {
            const cpDir = path.join(wsRoot, '.isocode', 'checkpoints');
            const cpFile = path.join(cpDir, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`);
            if (fs.existsSync(cpFile)) {
                const cpContent = fs.readFileSync(cpFile, 'utf8');
                checkpointCtx = '\n\nPREVIOUS SESSION CONTEXT:\n' + cpContent.slice(0, 1500);
            }
        } catch { }

        const systemContent = SYSTEM_PROMPT + contextNudge + projectCtx + projectMap + projectRules + memoryCtx + checkpointCtx;
        const userContent = autoCtx ? `${message}${autoCtx}` : message;

        state = {
            step: 0,
            model: model || null,
            agentPlus,
            sessionId,
            workspaceRoot: wsRoot,
            messages: [
                { role: 'system', content: systemContent },
                { role: 'user', content: userContent }
            ],
            pendingDiff: null,
            retryCount: 0,
            currentPlan: null,
            completedTasks: 0,
            totalTasks: 0,
            consecutiveFinals: 0,
            compactCount: 0,
            consecutiveStepsWithoutAction: 0,
            stopRequested: false,
            swarmDisabled: false
        };
        activeAgents.set(sessionId, state);
        console.log(`[Agent] Session ${sessionId} initialized (${agentPlus ? 'Agent+' : 'Agent'}): projectMap=${projectMap.length}c, rules=${projectRules.length}c, autoCtx=${autoCtx.length}c`);
    } else {
        if (model) state.model = model;
        if (message) {
            state.messages.push({ role: 'user', content: message });
        }
    }

    // Reset step counter for each new run (new message or resumed after approval)
    state.step = 0;
    state.consecutiveFinals = 0;
    state.consecutiveStepsWithoutAction = 0;
    state._compactedThisRun = false;

    const NO_PROGRESS_LIMIT = 10;  // stop if this many steps in a row with no tool/diff action

    const resolvedModel = model || state.model || null;
    const { messages } = state;

    // --- ReAct Loop ---
    // No fixed step limit for local use; stop on: final, diff_request (Agent), no-progress, or safety cap
    for (; state.step < maxSteps; state.step++) {
        if (state.stopRequested) {
            saveContextCheckpoint(state, resolvedModel);
            send({ type: 'final', content: 'Agent stopped by user.' });
            state.stopRequested = false;
            return;
        }
        if ((state.consecutiveStepsWithoutAction || 0) >= NO_PROGRESS_LIMIT) {
            saveContextCheckpoint(state, resolvedModel);
            send({ type: 'final', content: 'Stopped: no further actions after several steps. Send a follow-up to continue.' });
            return;
        }

        // Auto-compact when context grows large
        if (state.compactCount < 3 && shouldAutoCompact(messages, CONTEXT_BUDGET)) {
            console.log(`[Agent] Auto-compacting (${messages.length} msgs, ~${estimateMessagesTokens(messages)} tokens)`);
            try {
                const result = await compactConversation(messages, resolvedModel);
                if (result.compacted) {
                    messages.length = 0;
                    messages.push(...result.messages);
                    state.compactCount++;
                    console.log(`[Agent] Compacted: removed ${result.removedCount} messages (compact #${state.compactCount})`);
                    // Save checkpoint after compaction
                    saveContextCheckpoint(state, resolvedModel);
                }
            } catch (e) {
                console.warn('[Agent] Auto-compact failed:', e.message);
                state.compactCount = 3; // Stop retrying
            }
        }

        // Periodic checkpoint save (every 8 steps)
        if (state.step > 0 && state.step % 8 === 0) {
            saveContextCheckpoint(state, resolvedModel);
        }

        const trimmedMessages = trimForContextWindow(messages, CONTEXT_BUDGET);

        let raw;
        try {
            raw = await callLLM({
                model: resolvedModel,
                messages: trimmedMessages,
                options: {
                    expect_json: true,
                    temperature: state.agentPlus ? 0.5 : 0.2,
                    max_tokens: 4096,
                    timeout: state.agentPlus ? 300000 : 180000
                }
            });
            state.retryCount = 0;
        } catch (err) {
            const errData = err?.response?.data;
            const details = errData ? (typeof errData === 'string' ? errData : JSON.stringify(errData)) : (err?.message || String(err));

            if (state.retryCount < 2 && !details.includes('not found') && !details.includes('does not exist')) {
                state.retryCount = (state.retryCount || 0) + 1;
                console.warn(`[Agent] LLM call failed (attempt ${state.retryCount}), retrying: ${details}`);
                send({ type: 'thought', content: `Retrying (attempt ${state.retryCount + 1})...` });
                continue;
            }

            let hint = '';
            if (details.includes('not found')) {
                hint = `\n\nModel "${resolvedModel || 'default'}" not available. Pull it: ollama pull ${resolvedModel || '<model>'}`;
            }
            saveContextCheckpoint(state, resolvedModel);
            send({ type: 'final', content: `LLM call failed: ${details}${hint}` });
            return;
        }

        // Handle native tool_calls (OpenAI format)
        if (raw && typeof raw === 'object' && raw.tool_calls) {
            state.consecutiveStepsWithoutAction = 0;
            for (const tc of raw.tool_calls) {
                const fn = tc.function || {};
                let parsedArgs = {};
                try { parsedArgs = JSON.parse(fn.arguments || '{}'); } catch { }
                const parsed = { type: 'action', tool: fn.name, args: parsedArgs };

                send(parsed);
                messages.push({ role: 'assistant', content: JSON.stringify(parsed) });

                const result = await executeToolAction(parsed, state, send, messages);
                if (result === 'stop') return;
            }
            continue;
        }

        // Parse JSON response
        const rawStr = typeof raw === 'string' ? raw : JSON.stringify(raw);
        let jsonStr = extractAgentJson(rawStr) || rawStr;
        let parsed;

        try {
            parsed = JSON.parse(jsonStr);
        } catch {
            try {
                const fixed = String(jsonStr || '')
                    .replace(/^<\|[^>]+?\|>.*?<\|message\|>/s, '')
                    .trim();
                const wrapped = fixed.startsWith('{') ? fixed : `{${fixed}`;
                jsonStr = wrapped.endsWith('}') ? wrapped : `${wrapped}}`;
                parsed = JSON.parse(jsonStr);
            } catch {
                parsed = parseWrappedAction(rawStr) || parseWrappedAction(jsonStr);
                if (!parsed) {
                    const textResponse = String(rawStr || '').trim();
                    const salvaged = salvageNonJsonResponse(textResponse);
                    if (salvaged) {
                        parsed = salvaged;
                    } else if (textResponse) {
                        // Non-JSON text — don't treat as final immediately, nudge the model
                        messages.push({
                            role: 'assistant',
                            content: textResponse
                        });
                        messages.push({
                            role: 'user',
                            content: 'You must respond with valid JSON. Use {"type":"action","tool":"tool_name","args":{}} to take action, or {"type":"thought","content":"..."} to reason. Do NOT output plain text.'
                        });
                        continue;
                    } else {
                        send({ type: 'final', content: 'No response from model.' });
                        return;
                    }
                }
            }
        }

        // Ensure type field
        if (parsed && !parsed.type) {
            if (parsed.filePath && parsed.diff) parsed.type = 'diff_request';
            else if (parsed.tool) parsed.type = 'action';
            else if (parsed.name) { parsed.type = 'action'; parsed.tool = parsed.name; }
            else if (parsed.content && !parsed.tool) parsed.type = 'thought';
        }

        // Track plan from thoughts
        if (parsed.type === 'thought' && typeof parsed.content === 'string') {
            const content = parsed.content;
            if (content.includes('PLAN:') || content.includes('PLAN\n') || /^\d+\.\s/.test(content)) {
                state.currentPlan = content.slice(0, 500);
                const taskCount = (content.match(/^\d+\.\s/gm) || []).length;
                if (taskCount > 0) state.totalTasks = taskCount;
            }
            if (content.includes('PROGRESS:') || content.includes('Completed task')) {
                state.completedTasks++;
            }
        }

        // Agent+ swarm: delegate subtasks to workers (GPU-limited concurrency). Fallback to single-agent if swarm fails.
        if (parsed.type === 'delegate' && state.agentPlus && Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
            messages.push({ role: 'assistant', content: JSON.stringify(parsed) });
            if (state.swarmDisabled) {
                messages.push({
                    role: 'user',
                    content: 'Delegation is disabled (swarm failed earlier, e.g. memory/hardware). Complete the remaining tasks yourself in single-agent mode. Do NOT emit delegate again; use actions and thoughts only.'
                });
                send({ type: 'thought', content: 'Continuing in single-agent mode (delegation disabled).' });
                state.consecutiveStepsWithoutAction = 0;
                continue;
            }
            const maxWorkers = Math.max(1, Math.min(5, SWARM_MAX_WORKERS || 2));
            send({ type: 'thought', content: `Swarm: delegating ${parsed.tasks.length} subtask(s) (max ${maxWorkers} in parallel).` });
            const swarmTasks = normalizeSwarmTasks(parsed.tasks);
            try {
                await runSwarmWorkers(swarmTasks, state, send, messages, resolvedModel, maxWorkers);
            } catch (err) {
                const reason = err && (err.message || String(err));
                state.swarmDisabled = true;
                const fallbackMsg = `Swarm failed (${reason}). Switching to single-agent mode for the rest of this run. Continue with your plan using actions and thoughts; do NOT use delegate again.`;
                messages.push({ role: 'tool', content: JSON.stringify({ type: 'observation', content: fallbackMsg }) });
                send({ type: 'observation', content: { swarm: false, error: reason, fallback: true } });
                send({ type: 'thought', content: 'Swarm failed; continuing in single-agent mode.' });
            }
            state.consecutiveStepsWithoutAction = 0;
            continue;
        }

        // Send to UI
        if (parsed.type === 'diff_request') {
            send({ ...parsed, sessionId });
        } else {
            send(parsed);
        }

        messages.push({ role: 'assistant', content: JSON.stringify(parsed) });

        // Handle FINAL — but only truly stop if no more tasks remain
        if (parsed.type === 'final') {
            state.consecutiveFinals++;

            // If the model emitted final but we know there are more planned tasks,
            // nudge it to continue (up to 2 nudges)
            if (state.totalTasks > 0 && state.completedTasks < state.totalTasks && state.consecutiveFinals <= 2) {
                messages.push({
                    role: 'user',
                    content: `You said you're done, but you've only completed ${state.completedTasks}/${state.totalTasks} planned tasks. Please continue with the remaining tasks. Do NOT emit final until ALL tasks are complete.`
                });
                send({ type: 'thought', content: `Continuing... (${state.completedTasks}/${state.totalTasks} tasks done)` });
                continue;
            }

            // Truly done
            saveContextCheckpoint(state, resolvedModel);
            try { await autoSaveWithSummary(sessionId, messages, resolvedModel, state.model); } catch { }
            activeAgents.delete(sessionId);
            return;
        }

        if (parsed.type === 'diff_request') {
            state.consecutiveStepsWithoutAction = 0;
            state.pendingDiff = parsed;
            // In Agent+ mode, auto-approve and continue
            if (state.agentPlus) {
                let applyResult;
                try {
                    applyResult = await runTool('apply_diff', { filePath: parsed.filePath, diff: parsed.diff }, { workspaceRoot: state.workspaceRoot, autoMode: true });
                } catch (e) {
                    applyResult = { error: String(e) };
                }
                state.pendingDiff = null;
                messages.push({
                    role: 'assistant',
                    content: JSON.stringify({
                        type: 'observation',
                        content: applyResult?.error
                            ? `Auto-applied diff failed: ${applyResult.error}. Try a different approach.`
                            : 'Diff auto-applied successfully (Agent+ mode). Continue with the next task.'
                    })
                });
                send({ type: 'observation', content: { autoApplied: true, success: !applyResult?.error } });
                continue;
            }
            // Agent mode: wait for user approval (stream will end, resume on approval)
            return;
        }

        // Tool execution
        if (parsed.type === 'action') {
            state.consecutiveFinals = 0;
            state.consecutiveStepsWithoutAction = 0;
            const result = await executeToolAction(parsed, state, send, messages);
            if (result === 'stop') return;
            continue;
        }

        // thought only — no tool or diff this step; count toward no-progress stop
        state.consecutiveFinals = 0;
        state.consecutiveStepsWithoutAction = (state.consecutiveStepsWithoutAction || 0) + 1;

        // Anti-loop: after 2 consecutive thoughts, nudge the model to take action
        if (state.consecutiveStepsWithoutAction >= 2) {
            messages.push({
                role: 'user',
                content: 'You have been thinking without acting. Remember: a thought must always be followed by an action. Your next response MUST be {"type":"action","tool":"<tool_name>","args":{...}}. Take action now.'
            });
        }
    }

    // Safety cap reached (no step limit in normal use; this is a fallback to avoid endless runs)
    saveContextCheckpoint(state, resolvedModel);
    try { await autoSaveWithSummary(sessionId, messages, resolvedModel, state.model); } catch { }
    send({ type: 'final', content: 'Stopped after many steps to avoid long runs. Send a follow-up to continue.' });
}

/** Task type for picking the best model from available ones (Ollama/LM Studio/etc.). */
const TASK_TYPE = { VISION: 'vision', CODER: 'coder', GENERAL: 'general' };

/** Patterns (lowercase) that identify vision-capable models. Used to pick a model that can do screenshots/browser. */
const VISION_MODEL_PATTERNS = [
    'llava', 'qwen-vl', 'qwen2-vl', 'pixtral', 'minicpm-v', 'bakllava', 'moondream', 'llava-phi', 'cogvlm',
    'vision', 'multimodal', 'image',
    'glm4', 'glm-4', 'glm4.7', 'glm-4.7', 'gemma-2', 'gemini', 'gpt-4o', 'gpt-4-vision', 'gpt4o',
    'claude-3', 'claude.*vision', 'gemini.*vision'
];

/** Patterns that identify coder/specialist coding models (avoid these for vision tasks when possible). */
const CODER_MODEL_PATTERNS = ['coder', 'code', 'deepseek-coder', 'starcoder', 'codellama', 'codeqwen', 'qwen.*coder', 'phi.*qwen', 'mistral.*code', 'granite.*code', 'command-r'];

function classifyTaskType(taskText) {
    if (!taskText || typeof taskText !== 'string') return TASK_TYPE.GENERAL;
    const t = taskText.toLowerCase();
    if (/screenshot|browser|vision|image|picture|photo|screen\s*capture|what'?s\s+on\s+(the\s+)?screen|see\s+what'?s\s+displayed|take\s+(a\s+)?(screenshot|picture)|capture\s+(the\s+)?screen|perform_browser|mcp.*browser|localhost.*screenshot|screenshot.*(of\s+)?(output|localhost|page|ui)/i.test(t)) return TASK_TYPE.VISION;
    if (/implement|code|fix\s+(the\s+)?(bug|issue)|write\s+(the\s+)?(file|code)|refactor|add\s+(the\s+)?(feature|function)|edit\s+(the\s+)?file|create\s+(the\s+)?(file|module)|replace_in_file|write_file|apply_diff|run_lint|run_tests|debug|patch/i.test(t)) return TASK_TYPE.CODER;
    return TASK_TYPE.GENERAL;
}

/** Score a model id/name against patterns (higher = better match). */
function scoreModelForType(modelId, displayName, patterns) {
    const s = `${(modelId || '')} ${(displayName || '')}`.toLowerCase();
    for (let i = 0; i < patterns.length; i++) {
        const p = patterns[i];
        const re = p.includes('*') ? new RegExp(p.replace(/\*/g, '.*'), 'i') : null;
        if (re && re.test(s)) return patterns.length - i;
        if (!re && s.includes(p)) return patterns.length - i;
    }
    return 0;
}

/** Return true if model id/name matches coder patterns (avoid for vision tasks). */
function isCoderModel(modelId, displayName) {
    const s = `${(modelId || '')} ${(displayName || '')}`.toLowerCase();
    return CODER_MODEL_PATTERNS.some((p) => {
        const re = p.includes('*') ? new RegExp(p.replace(/\*/g, '.*'), 'i') : null;
        return re ? re.test(s) : s.includes(p);
    });
}

/**
 * Pick the best available model for this task from the list (Ollama/LM Studio/etc.).
 * For vision tasks: prefer vision-capable models (e.g. llava, glm4.7-flash); if none match, prefer any non-coder model over the session coder.
 * preferredVisionModel (e.g. SWARM_VISION_MODEL) is used for vision tasks when the session model is a coder and no capable model was found in the list.
 */
function pickBestModelForTask(taskText, availableModels, defaultModel, preferredVisionModel) {
    if (!Array.isArray(availableModels) || availableModels.length === 0) {
        if (classifyTaskType(taskText) === TASK_TYPE.VISION && preferredVisionModel && isCoderModel(defaultModel, defaultModel)) return preferredVisionModel;
        return defaultModel;
    }
    const type = classifyTaskType(taskText);
    const patterns = type === TASK_TYPE.VISION ? VISION_MODEL_PATTERNS : type === TASK_TYPE.CODER ? CODER_MODEL_PATTERNS : null;
    let best = null;
    let bestScore = 0;
    if (patterns) {
        for (const m of availableModels) {
            const id = m.id || m.displayName || '';
            const displayName = m.displayName || m.id || '';
            const score = scoreModelForType(id, displayName, patterns);
            if (score > bestScore) {
                bestScore = score;
                best = id;
            }
        }
    }
    if (best) return best;
    if (type === TASK_TYPE.VISION) {
        const defaultIsCoder = isCoderModel(defaultModel, defaultModel);
        if (defaultIsCoder) {
            for (const m of availableModels) {
                const id = m.id || m.displayName || '';
                if (!id) continue;
                if (!isCoderModel(id, m.displayName || id)) return id;
            }
            if (preferredVisionModel) return preferredVisionModel;
        }
    }
    return defaultModel;
}

/** Normalize delegate tasks to [{ task, model? }]. Accepts string[] or { task, model? }[]. */
function normalizeSwarmTasks(tasks) {
    return tasks.map((t) => {
        if (typeof t === 'string') return { task: t, model: null };
        if (t && typeof t.task === 'string') return { task: t.task, model: t.model || null };
        return { task: String(t), model: null };
    });
}

/**
 * Ordered list of model IDs to try for a task (goal: get task done irrespective of model).
 * First is best match; rest are fallbacks so we can retry with another model on failure.
 */
function getModelsToTryForTask(taskText, availableModels, defaultModel, preferredVisionModel, explicitModel) {
    if (explicitModel && typeof explicitModel === 'string') return [explicitModel];
    const primary = pickBestModelForTask(taskText, availableModels, defaultModel, preferredVisionModel) || defaultModel;
    const seen = new Set([primary]);
    const out = [primary];
    const add = (id) => { if (id && !seen.has(id)) { seen.add(id); out.push(id); } };
    if (Array.isArray(availableModels) && availableModels.length > 0) {
        for (const m of availableModels) {
            const id = m.id || m.displayName || '';
            if (id) add(id);
        }
    }
    add(preferredVisionModel);
    add(defaultModel);
    return out;
}

/**
 * Run delegated subtasks with a worker pool (max concurrency to avoid GPU bottleneck).
 * Each worker tries the best model first; on non-fatal failure, retries with the next model so the task gets done irrespective of which model is used.
 */
async function runSwarmWorkers(tasks, state, parentSend, messages, resolvedModel, maxWorkers) {
    const normalized = normalizeSwarmTasks(tasks);
    const defaultModel = state.model || resolvedModel;
    const preferredVision = SWARM_VISION_MODEL || null;
    let availableModels = [];
    try {
        availableModels = await listModels();
    } catch (e) {
        console.warn('[Agent] Swarm listModels failed, using default model for all workers:', e.message);
    }
    const results = [];
    const baseId = state.sessionId + '_swarm_';
    for (let i = 0; i < normalized.length; i += maxWorkers) {
        const chunk = normalized.slice(i, i + maxWorkers);
        const chunkPromises = chunk.map(async (item, j) => {
            const workerId = baseId + (i + j);
            const taskText = item.task;
            const modelsToTry = getModelsToTryForTask(taskText, availableModels, defaultModel, preferredVision, item.model);
            let finalContent = '';
            const workerSend = (obj) => {
                if (obj && obj.type === 'final' && obj.content != null) finalContent = String(obj.content);
            };
            let lastError = null;
            for (const workerModel of modelsToTry) {
                try {
                    await runAgent({
                        sessionId: workerId,
                        message: taskText,
                        model: workerModel,
                        agentPlus: true,
                        workspaceRoot: state.workspaceRoot,
                        send: workerSend,
                        maxSteps: 15
                    });
                    activeAgents.delete(workerId);
                    return finalContent || '(no output)';
                } catch (err) {
                    activeAgents.delete(workerId);
                    const msg = err && (err.message || String(err));
                    const fatal = /memory|heap|ENOMEM|out of memory|ECONNRESET|socket hang up|abort/i.test(msg);
                    if (fatal) throw err;
                    lastError = msg;
                }
            }
            return lastError != null ? `Worker error: ${lastError}` : '(no output)';
        });
        const chunkResults = await Promise.all(chunkPromises);
        results.push(...chunkResults);
    }
    const allErrors = results.every((r) => typeof r === 'string' && r.startsWith('Worker error:'));
    if (results.length > 0 && allErrors) {
        throw new Error(results[0] || 'Swarm workers failed (e.g. memory or hardware).');
    }
    const combined = results.map((r, idx) => `[Subtask ${idx + 1}]\n${r}`).join('\n\n');
    messages.push({ role: 'tool', content: JSON.stringify({ type: 'observation', content: `Swarm results:\n\n${combined}` }) });
    parentSend({ type: 'observation', content: { swarm: true, results: results.length, summary: combined.slice(0, 500) + (combined.length > 500 ? '...' : '') } });
}

/**
 * Execute a tool action and push observation. Returns 'stop' if agent should halt.
 */
async function executeToolAction(parsed, state, send, messages) {
    let result;
    try {
        const isExternalBrowserTool = ['mcp_list_tools', 'mcp_call_tool', 'perform_browser_task'].includes(parsed.tool);

        if (isExternalBrowserTool && !state.agentPlus) {
            result = { error: 'MCP/browser automation requires Agent+ mode.' };
            messages.push({ role: 'tool', content: JSON.stringify(result) });
            send({ type: 'observation', content: result });
            return 'continue';
        }

        // In Agent mode, file mutations go through diff_request for approval
        // In Agent+ mode, apply directly
        if (!state.agentPlus) {
            if (parsed.tool === 'apply_diff' && parsed.args?.filePath && parsed.args?.diff) {
                const root = state.workspaceRoot || process.cwd();
                const filePath = resolvePathInWorkspace(root, parsed.args.filePath);
                const relPath = path.relative(root, filePath).replace(/\\/g, '/');
                const dr = { type: 'diff_request', filePath: relPath, diff: parsed.args.diff };
                send({ ...dr, sessionId: state.sessionId });
                state.pendingDiff = dr;
                return 'stop';
            }
            if (parsed.tool === 'write_file' && parsed.args?.path != null && parsed.args?.content != null) {
                const root = state.workspaceRoot || process.cwd();
                const abs = resolvePathInWorkspace(root, parsed.args.path);
                const filePath = path.relative(root, abs).replace(/\\/g, '/');
                const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
                const after = String(parsed.args.content);
                const patch = createTwoFilesPatch(filePath, filePath, before, after, '', '', { context: 3 });
                const dr = { type: 'diff_request', filePath, diff: patch };
                send({ ...dr, sessionId: state.sessionId });
                state.pendingDiff = dr;
                return 'stop';
            }
            if (parsed.tool === 'replace_in_file' && parsed.args?.path != null) {
                const root = state.workspaceRoot || process.cwd();
                const abs = resolvePathInWorkspace(root, parsed.args.path);
                const filePath = path.relative(root, abs).replace(/\\/g, '/');
                const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
                const search = String(parsed.args.search ?? '');
                const replace = String(parsed.args.replace ?? '');
                const after = before.includes(search) ? before.replace(search, replace) : before;
                const patch = createTwoFilesPatch(filePath, filePath, before, after, '', '', { context: 3 });
                const dr = { type: 'diff_request', filePath, diff: patch };
                send({ ...dr, sessionId: state.sessionId });
                state.pendingDiff = dr;
                return 'stop';
            }
        }

        // Execute the tool
        result = await runTool(parsed.tool, parsed.args || {}, { workspaceRoot: state.workspaceRoot, autoMode: true });
    } catch (e) {
        result = { error: String(e) };
    }

    const truncatedResult = truncateToolResult(result);

    // ENOENT hint
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result || {});
    if (resultStr.includes('ENOENT') || resultStr.includes('no such file')) {
        const errPath = resultStr.match(/open '([^']+)'/)?.[1] || '';
        truncatedResult.hint = `File not found. Try list_files to find "${path.basename(errPath)}".`;
    }

    messages.push({ role: 'tool', content: JSON.stringify(truncatedResult) });
    send({ type: 'observation', content: result });

    // Tell the client to open the file in the editor when the agent creates/edits it (e.g. write_file)
    const fileMutationOk = result && typeof result === 'object' && result.ok === true && !result.error;
    if (fileMutationOk && (parsed.tool === 'write_file' || parsed.tool === 'replace_in_file') && parsed.args?.path) {
        try {
            const root = state.workspaceRoot || process.cwd();
            const absPath = resolvePathInWorkspace(root, parsed.args.path);
            const relPath = path.relative(root, absPath).replace(/\\/g, '/');
            send({ type: 'open_file', path: relPath });
        } catch (_) { /* ignore */ }
    }

    // Persist after each tool step
    try { saveConversation(state.sessionId || 'default', messages, { model: state.model }); } catch { }

    return 'continue';
}

/**
 * Auto-save conversation with a compact summary for later retrieval.
 */
async function autoSaveWithSummary(sessionId, messages, resolvedModel, stateModel) {
    const state = activeAgents.get(sessionId);
    const wsRoot = state?.workspaceRoot || process.cwd();
    saveConversation(sessionId, messages, { model: stateModel });

    if (messages.length > 6) {
        try {
            const result = await compactConversation([...messages], resolvedModel);
            if (result.compacted) {
                saveConversation(`${sessionId}_compact`, result.messages, { model: stateModel, compacted: true });
                const summaryMsg = result.messages.find(m =>
                    typeof m.content === 'string' && m.content.includes('summary')
                );
                if (summaryMsg) {
                    try {
                        const parsed = JSON.parse(summaryMsg.content);
                        saveSessionSummary(sessionId, parsed.content || summaryMsg.content, wsRoot);
                    } catch {
                        saveSessionSummary(sessionId, summaryMsg.content, wsRoot);
                    }
                }
            }
        } catch { }
    }
}

/**
 * Switch model mid-conversation: summarize current context for new model.
 */
async function switchModel(sessionId, newModel, send) {
    const state = activeAgents.get(sessionId);
    if (!state) return { ok: false, error: 'No active session' };

    const oldModel = state.model;
    state.model = newModel;

    const { messages } = state;
    if (messages.length > 4) {
        try {
            // Save checkpoint before switch
            saveContextCheckpoint(state, oldModel);
            const result = await compactConversation(messages, newModel);
            if (result.compacted) {
                messages.length = 0;
                messages.push(...result.messages);
                messages.push({
                    role: 'assistant',
                    content: JSON.stringify({
                        type: 'observation',
                        content: `Model switched from ${oldModel || 'previous'} to ${newModel}. Context has been summarized.`
                    })
                });
            }
        } catch { }
    }

    state.compactCount = 0;
    return { ok: true, from: oldModel, to: newModel, messages: messages.length };
}

async function resumeAgent({ sessionId, send, model }) {
    const state = activeAgents.get(sessionId);
    if (!state) {
        send({ type: 'final', content: 'No active agent session.' });
        return;
    }
    // Resume continues the ReAct loop from where it left off
    await runAgent({ sessionId, send, model });
}

/**
 * Manually compact a session's conversation.
 */
async function compactSession(sessionId, model) {
    const state = activeAgents.get(sessionId);
    if (!state) return { ok: false, error: 'No active session' };

    const { messages } = state;
    const before = messages.length;
    const result = await compactConversation(messages, model || state.model);
    if (result.compacted) {
        messages.length = 0;
        messages.push(...result.messages);
        saveConversation(sessionId, messages, { model: state.model });
        saveContextCheckpoint(state, model || state.model);
        return { ok: true, before, after: messages.length, removedCount: result.removedCount };
    }
    return { ok: true, before, after: before, message: 'Nothing to compact' };
}

module.exports = { runAgent, resumeAgent, compactSession, switchModel, activeAgents };
