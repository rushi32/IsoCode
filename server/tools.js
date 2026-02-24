// server/tools.js
// Comprehensive tool runner for the IsoCode agent.
// Implements agentic IDE tools inspired by Claude Code and IsoCode patterns.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { exec, execSync } = require('child_process');
const { applyPatch } = require('diff');
const config = require('./config.js');
const { memoryRead, memoryWrite, memoryList } = require('./memory.js');
const { McpClient } = require('./mcp-client.js');

let read_url, perform_browser_task, screenshot_url, browser_open, browser_screenshot,
    browser_click, browser_type, browser_extract, browser_evaluate, browser_wait,
    browser_close, analyze_image, read_docs;
try {
    ({
        read_url, perform_browser_task, screenshot_url,
        browser_open, browser_screenshot, browser_click, browser_type,
        browser_extract, browser_evaluate, browser_wait, browser_close,
        analyze_image
    } = require('./browser.js'));
    console.log('[Tools] Browser module loaded');
} catch (e) { console.warn('[Tools] browser.js not available:', e.message); }
try { ({ read_docs } = require('./tools/docs.js')); } catch (e) { console.warn('[Tools] docs.js not available:', e.message); }

let callVisionLLM;
try { ({ callVisionLLM } = require('./llm.js')); } catch (e) { console.warn('[Tools] Vision LLM not available:', e.message); }

const { getIndex, findRelevantFiles } = require('./codebase');

const mcpClients = new Map();

// ---------------------------------------------------------------------------
// Tool Definitions (OpenAI function calling format)
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [
    {
        name: 'read_file',
        description: 'Read the contents of a file. Use this to understand existing code before making changes.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path to the file from workspace root' },
                offset: { type: 'number', description: 'Line number to start reading from (1-indexed). Optional.' },
                limit: { type: 'number', description: 'Max number of lines to read. Optional.' }
            },
            required: ['path']
        }
    },
    {
        name: 'write_file',
        description: 'Write content to a file. Creates parent directories if needed. For existing files, prefer replace_in_file or apply_diff.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path to the file' },
                content: { type: 'string', description: 'Complete file content to write' }
            },
            required: ['path', 'content']
        }
    },
    {
        name: 'replace_in_file',
        description: 'Replace exact text in a file. Use for targeted edits. The search string must match exactly.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path to the file' },
                search: { type: 'string', description: 'Exact text to find (must match existing content)' },
                replace: { type: 'string', description: 'Replacement text' }
            },
            required: ['path', 'search', 'replace']
        }
    },
    {
        name: 'apply_diff',
        description: 'Apply a unified diff patch to a file. Best for complex multi-line changes.',
        parameters: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Relative path to the file' },
                diff: { type: 'string', description: 'Unified diff string' }
            },
            required: ['filePath', 'diff']
        }
    },
    {
        name: 'list_files',
        description: 'List files recursively in a directory. Ignores node_modules, .git, dist, out by default.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path to directory (default: workspace root)' },
                maxDepth: { type: 'number', description: 'Max directory depth to traverse (default: 5)' }
            }
        }
    },
    {
        name: 'glob_files',
        description: 'Find files matching a glob pattern (e.g., "**/*.ts", "src/**/*.js", "*.json").',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Glob pattern to match files' },
                path: { type: 'string', description: 'Directory to search in (default: workspace root)' }
            },
            required: ['pattern']
        }
    },
    {
        name: 'search_files',
        description: 'Search for text/regex in files. Returns matching lines with file paths and line numbers. Like grep/ripgrep.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Text or regex pattern to search for' },
                path: { type: 'string', description: 'Directory to search in (default: workspace root)' },
                include: { type: 'string', description: 'File extension filter, e.g., ".ts" or ".js,.py"' },
                maxResults: { type: 'number', description: 'Maximum results to return (default: 50)' }
            },
            required: ['query']
        }
    },
    {
        name: 'run_shell',
        description: 'Execute a shell command in the workspace root. Use for git, npm, test runners, builds, etc.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to execute' },
                cwd: { type: 'string', description: 'Working directory (default: workspace root)' },
                timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' }
            },
            required: ['command']
        }
    },
    {
        name: 'open_in_system_browser',
        description: 'Open a URL in the system default browser.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'URL to open' }
            },
            required: ['url']
        }
    },
    {
        name: 'read_url',
        description: 'Fetch a URL and return its content as markdown. Good for reading documentation or web pages.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'URL to read' }
            },
            required: ['url']
        }
    },
    {
        name: 'read_docs',
        description: 'Read documentation from a URL. Converts HTML to readable Markdown.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'Documentation URL to read' }
            },
            required: ['url']
        }
    },
    {
        name: 'memory_read',
        description: 'Read a stored fact from persistent memory. Memory persists across sessions.',
        parameters: {
            type: 'object',
            properties: {
                key: { type: 'string', description: 'Memory key to read' }
            },
            required: ['key']
        }
    },
    {
        name: 'memory_write',
        description: 'Store a fact in persistent memory. Useful for remembering project details across sessions.',
        parameters: {
            type: 'object',
            properties: {
                key: { type: 'string', description: 'Memory key' },
                value: { type: 'string', description: 'Value to store' }
            },
            required: ['key', 'value']
        }
    },
    {
        name: 'memory_list',
        description: 'List all keys in persistent memory.',
        parameters: { type: 'object', properties: {} }
    },
    {
        name: 'task_list',
        description: 'List current tasks/todos being tracked for this session.',
        parameters: { type: 'object', properties: {} }
    },
    {
        name: 'task_update',
        description: 'Create or update a task. Use for tracking multi-step work.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Task ID' },
                content: { type: 'string', description: 'Task description' },
                status: { type: 'string', description: 'Status: pending, in_progress, completed, cancelled' }
            },
            required: ['id', 'content', 'status']
        }
    },
    // --- Git tools (IsoCode/Claude Code parity) ---
    {
        name: 'git_status',
        description: 'Get git status of the workspace. Shows modified, staged, untracked files.',
        parameters: { type: 'object', properties: {} }
    },
    {
        name: 'git_diff',
        description: 'Show git diff of changes. Use to review modifications before committing.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Specific file path (optional, defaults to all changes)' },
                staged: { type: 'boolean', description: 'Show staged changes only (default: false)' }
            }
        }
    },
    {
        name: 'git_log',
        description: 'Show recent git commit history.',
        parameters: {
            type: 'object',
            properties: {
                count: { type: 'number', description: 'Number of commits to show (default: 10)' },
                oneline: { type: 'boolean', description: 'Show one line per commit (default: true)' }
            }
        }
    },
    {
        name: 'git_commit',
        description: 'Stage and commit changes. Use after verifying changes are correct.',
        parameters: {
            type: 'object',
            properties: {
                message: { type: 'string', description: 'Commit message' },
                files: { type: 'string', description: 'Files to stage (space-separated). Use "." for all.' }
            },
            required: ['message']
        }
    },
    {
        name: 'git_branch',
        description: 'List, create, or switch git branches.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', description: '"list", "create", "checkout", or "current"' },
                name: { type: 'string', description: 'Branch name (for create/checkout)' }
            }
        }
    },
    // --- Lint & Test tools (auto-verify loops) ---
    {
        name: 'run_lint',
        description: 'Run project linter and return errors/warnings. Auto-detects: eslint, tsc, pylint, ruff, cargo check.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Specific file to lint (optional)' },
                fix: { type: 'boolean', description: 'Auto-fix issues if supported (default: false)' }
            }
        }
    },
    {
        name: 'run_tests',
        description: 'Run project tests. Auto-detects: jest, mocha, pytest, cargo test, go test.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Specific test file or pattern (optional)' },
                timeout: { type: 'number', description: 'Timeout in milliseconds (default: 60000)' }
            }
        }
    },
    // --- Batch operations ---
    {
        name: 'batch_read',
        description: 'Read multiple files at once. More efficient than reading one at a time.',
        parameters: {
            type: 'object',
            properties: {
                paths: { type: 'string', description: 'Comma-separated list of file paths to read' }
            },
            required: ['paths']
        }
    },
    {
        name: 'codebase_search',
        description: 'Semantic-style search across the codebase. Finds files by name, content patterns, and directory structure. More powerful than search_files for broad exploration.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'What to search for (e.g., "authentication middleware", "database connection")' },
                maxResults: { type: 'number', description: 'Max files to return (default: 8)' }
            },
            required: ['query']
        }
    },
    {
        name: 'mcp_list_tools',
        description: 'List tools available from configured MCP (Model Context Protocol) servers.',
        parameters: { type: 'object', properties: {} }
    },
    {
        name: 'mcp_call_tool',
        description: 'Call a tool on an MCP server.',
        parameters: {
            type: 'object',
            properties: {
                server: { type: 'string', description: 'MCP server name' },
                tool: { type: 'string', description: 'Tool name to call' },
                arguments: { type: 'object', description: 'Tool arguments' }
            },
            required: ['tool']
        }
    },
    {
        name: 'screenshot_url',
        description: 'Take a screenshot of a URL and analyze the page. Returns screenshot path and page text content.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'URL to screenshot' },
                fullPage: { type: 'boolean', description: 'Capture full scrollable page (default: false)' }
            },
            required: ['url']
        }
    },
    {
        name: 'analyze_image',
        description: 'Analyze an image file from the workspace. Returns image data for visual inspection.',
        parameters: {
            type: 'object',
            properties: {
                imagePath: { type: 'string', description: 'Path to image file (relative to workspace)' },
                prompt: { type: 'string', description: 'What to analyze in the image (e.g. "describe the UI layout")' }
            },
            required: ['imagePath']
        }
    },
    {
        name: 'browser_open',
        description: 'Open a URL in a persistent browser session for multi-step interaction.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'URL to open' }
            },
            required: ['url']
        }
    },
    {
        name: 'browser_screenshot',
        description: 'Take a screenshot of the current browser page (must use browser_open first).',
        parameters: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector to screenshot (optional, screenshots full page if omitted)' },
                fullPage: { type: 'boolean', description: 'Capture full scrollable page' }
            }
        }
    },
    {
        name: 'browser_click',
        description: 'Click an element on the current browser page.',
        parameters: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector to click' },
                text: { type: 'string', description: 'Click element by visible text instead of selector' }
            }
        }
    },
    {
        name: 'browser_type',
        description: 'Type text into an input field on the current browser page.',
        parameters: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector of input field' },
                text: { type: 'string', description: 'Text to type' },
                pressEnter: { type: 'boolean', description: 'Press Enter after typing' }
            },
            required: ['selector', 'text']
        }
    },
    {
        name: 'browser_extract',
        description: 'Extract content from the current browser page (text, links, forms, headings).',
        parameters: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector to extract from (optional, extracts full page if omitted)' },
                attribute: { type: 'string', description: 'HTML attribute to extract (e.g. "href", "src")' }
            }
        }
    },
    {
        name: 'browser_evaluate',
        description: 'Run JavaScript code in the current browser page context.',
        parameters: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'JavaScript code to execute in the page' }
            },
            required: ['code']
        }
    },
    {
        name: 'browser_wait',
        description: 'Wait for a CSS selector to appear or a timeout.',
        parameters: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector to wait for' },
                timeout: { type: 'number', description: 'Timeout in milliseconds (default: 5000)' }
            }
        }
    },
    {
        name: 'browser_close',
        description: 'Close the persistent browser session.',
        parameters: { type: 'object', properties: {} }
    }
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.next', '__pycache__', '.venv', 'venv', '.cache', 'coverage', '.nyc_output']);
const IGNORED_PREFIXES = ['.'];

function shouldIgnore(name) {
    if (IGNORED_DIRS.has(name)) return true;
    return false;
}

function getWorkspaceRoot(ctx = {}) {
    const root = (ctx.workspaceRoot && typeof ctx.workspaceRoot === 'string')
        ? path.resolve(ctx.workspaceRoot)
        : process.cwd();
    return root;
}

function resolvePath(filePath, workspaceRoot) {
    const resolved = path.resolve(workspaceRoot, filePath);
    const normalizedRoot = path.resolve(workspaceRoot);
    if (!resolved.startsWith(normalizedRoot)) {
        throw new Error(`Security Error: Path traversal detected. Access denied to ${filePath}`);
    }
    return resolved;
}

function withPermission(toolName, actionFn, ctx = {}) {
    const policy = config.PERMISSIONS?.[toolName] || 'always';
    if (policy === 'never') {
        throw new Error(`Permission denied: tool "${toolName}" is disabled by policy.`);
    }
    if (ctx.autoMode) return actionFn();
    if (policy === 'ask') {
        throw new Error(`Permission required for "${toolName}" in normal mode. Enable agent mode or set permission to always.`);
    }
    return actionFn();
}

// ---------------------------------------------------------------------------
// MCP Client Management
// ---------------------------------------------------------------------------

let mcpConfigHash = '';

async function ensureMcpClients() {
    const servers = Array.isArray(config.MCP_SERVERS) ? config.MCP_SERVERS : [];
    // Detect config changes and re-initialize if needed
    const newHash = JSON.stringify(servers.map(s => s?.name + ':' + s?.command));
    if (newHash !== mcpConfigHash) {
        mcpConfigHash = newHash;
        // Close old clients
        for (const [name, client] of mcpClients.entries()) {
            try { if (client?.process) client.process.kill(); } catch { }
        }
        mcpClients.clear();
        console.log(`[MCP] Config changed, reinitializing ${servers.length} servers`);
    }

    for (const s of servers) {
        if (!s || !s.name || !s.command) continue;
        if (mcpClients.has(s.name)) continue;
        console.log(`[MCP] Connecting to ${s.name}: ${s.command} ${(s.args || []).join(' ')}`);
        try {
            const client = new McpClient(s.command, s.args || []);
            await client.connect();
            try {
                const initResult = await Promise.race([
                    client.initialize(),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))
                ]);
                console.log(`[MCP] ${s.name} initialized:`, initResult ? 'ok' : 'no response');
            } catch (initErr) {
                console.warn(`[MCP] ${s.name} init handshake failed (may still work):`, initErr.message);
            }
            mcpClients.set(s.name, client);
            console.log(`[MCP] ${s.name} connected successfully`);
        } catch (e) {
            console.error(`[MCP] ${s.name} connection failed:`, e.message);
            mcpClients.set(s.name, { error: String(e) });
        }
    }
}

// ---------------------------------------------------------------------------
// Task tracking (in-memory per session)
// ---------------------------------------------------------------------------

const sessionTasks = new Map();

// ---------------------------------------------------------------------------
// Glob implementation (simple, no external deps)
// ---------------------------------------------------------------------------

function matchGlob(pattern, filePath) {
    const regexStr = pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '{{GLOBSTAR}}')
        .replace(/\*/g, '[^/\\\\]*')
        .replace(/\?/g, '[^/\\\\]')
        .replace(/\{\{GLOBSTAR\}\}/g, '.*');
    const regex = new RegExp(`^${regexStr}$`, 'i');
    return regex.test(filePath) || regex.test(filePath.replace(/\\/g, '/'));
}

async function globFiles(rootDir, pattern, maxResults = 200) {
    const results = [];
    const normalizedPattern = pattern.replace(/\\/g, '/');

    async function walk(dir, depth = 0) {
        if (depth > 10 || results.length >= maxResults) return;
        let dirents;
        try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }

        for (const dirent of dirents) {
            if (results.length >= maxResults) break;
            if (shouldIgnore(dirent.name)) continue;

            const fullPath = path.resolve(dir, dirent.name);
            const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

            if (dirent.isDirectory()) {
                if (matchGlob(normalizedPattern, relPath + '/') || normalizedPattern.includes('**')) {
                    await walk(fullPath, depth + 1);
                }
            } else {
                if (matchGlob(normalizedPattern, relPath)) {
                    results.push(relPath);
                }
            }
        }
    }

    await walk(rootDir);
    return results;
}

// ---------------------------------------------------------------------------
// Tool Runner
// ---------------------------------------------------------------------------

async function runTool(tool, args = {}, ctx = {}) {
    const WORKSPACE_ROOT = getWorkspaceRoot(ctx);

    switch (tool) {
        case 'apply_diff': {
            const { filePath, diff } = args;
            const abs = resolvePath(filePath, WORKSPACE_ROOT);
            const original = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
            const patched = applyPatch(original, diff);
            if (patched === false) {
                throw new Error('Failed to apply diff — the patch does not match the current file content.');
            }
            const dir = path.dirname(abs);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(abs, patched, 'utf8');
            return { ok: true, message: `Diff applied to ${filePath}` };
        }

        case 'read_file':
            return withPermission('read_file', async () => {
                const targetPath = resolvePath(args.path, WORKSPACE_ROOT);
                const MAX_LINES_AUTO = 200; // auto-limit for large files
                try {
                    const content = await fsp.readFile(targetPath, 'utf8');
                    const lines = content.split('\n');
                    const totalLines = lines.length;

                    if (args.offset || args.limit) {
                        const start = Math.max(0, (args.offset || 1) - 1);
                        const end = args.limit ? start + args.limit : Math.min(lines.length, start + MAX_LINES_AUTO);
                        const slice = lines.slice(start, end);
                        const numbered = slice.map((l, i) => `${start + i + 1}|${l}`).join('\n');
                        return { file: args.path, content: numbered, totalLines, showing: `${start + 1}-${start + slice.length}` };
                    }

                    // Auto-paginate large files — don't dump 1000+ lines into context
                    if (totalLines > MAX_LINES_AUTO) {
                        const slice = lines.slice(0, MAX_LINES_AUTO);
                        const numbered = slice.map((l, i) => `${i + 1}|${l}`).join('\n');
                        return {
                            file: args.path,
                            content: numbered,
                            totalLines,
                            showing: `1-${MAX_LINES_AUTO}`,
                            note: `File has ${totalLines} lines. Showing first ${MAX_LINES_AUTO}. Use offset/limit args to read more.`
                        };
                    }

                    const numbered = lines.map((l, i) => `${i + 1}|${l}`).join('\n');
                    return { file: args.path, content: numbered, totalLines };
                } catch (error) {
                    return { error: `Cannot read ${args.path}: ${error.message}` };
                }
            }, ctx);

        case 'write_file':
            return withPermission('write_file', async () => {
                const targetPath = resolvePath(args.path, WORKSPACE_ROOT);
                try {
                    const dir = path.dirname(targetPath);
                    await fsp.mkdir(dir, { recursive: true });
                    await fsp.writeFile(targetPath, args.content ?? '', 'utf8');
                    return { ok: true, message: `Wrote ${args.path}` };
                } catch (error) {
                    return { error: `Error writing ${args.path}: ${error.message}` };
                }
            }, ctx);

        case 'replace_in_file':
            return withPermission('replace_in_file', async () => {
                const targetPath = resolvePath(args.path, WORKSPACE_ROOT);
                try {
                    const content = await fsp.readFile(targetPath, 'utf8');
                    if (!content.includes(args.search)) {
                        return { ok: false, error: `Search string not found in ${args.path}. Make sure the search text matches exactly.` };
                    }
                    const newContent = content.replace(args.search, args.replace);
                    await fsp.writeFile(targetPath, newContent, 'utf8');
                    return { ok: true, message: `Replaced content in ${args.path}` };
                } catch (error) {
                    return { error: `Error modifying ${args.path}: ${error.message}` };
                }
            }, ctx);

        case 'run_shell':
            return withPermission('run_shell', async () => {
                const command = args.command;
                if (!command || typeof command !== 'string') {
                    return { error: 'run_shell requires a string "command" argument' };
                }
                const cwd = args.cwd ? resolvePath(args.cwd, WORKSPACE_ROOT) : WORKSPACE_ROOT;
                const timeout = args.timeout || 30000;
                return new Promise((resolve) => {
                    exec(command, { cwd, timeout, maxBuffer: 1024 * 1024 * 2 }, (error, stdout, stderr) => {
                        if (error) {
                            resolve({
                                exitCode: error.code || 1,
                                error: error.killed ? 'Command timed out' : `Command failed: ${error.message}`,
                                stdout: stdout ? stdout.slice(0, 2000) : '',
                                stderr: stderr ? stderr.slice(0, 1500) : ''
                            });
                        } else {
                            resolve({
                                exitCode: 0,
                                stdout: stdout ? stdout.slice(0, 3000) : '',
                                stderr: stderr ? stderr.slice(0, 1500) : ''
                            });
                        }
                    });
                });
            }, ctx);

        case 'open_in_system_browser':
            return withPermission('run_shell', async () => {
                const url = String(args.url || '').trim();
                if (!url) return { error: 'open_in_system_browser requires { url }' };
                const safe = url.replace(/"/g, '\\"');
                const platform = process.platform;
                const cmd = platform === 'win32'
                    ? `start "" "${safe}"`
                    : platform === 'darwin'
                        ? `open "${safe}"`
                        : `xdg-open "${safe}"`;
                return new Promise((resolve) => {
                    exec(cmd, { cwd: WORKSPACE_ROOT }, (error, stdout, stderr) => {
                        if (error) resolve({ error: `Failed: ${error.message}` });
                        else resolve({ ok: true, message: `Opened ${url} in browser` });
                    });
                });
            }, ctx);

        case 'list_files':
            return withPermission('list_files', async () => {
                const dirPath = args.path || '.';
                const maxDepth = args.maxDepth || 5;
                const absolutePath = resolvePath(dirPath, WORKSPACE_ROOT);

                async function getFiles(dir, depth = 0) {
                    if (depth > maxDepth) return [];
                    let dirents;
                    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
                    const files = await Promise.all(
                        dirents.map(async (dirent) => {
                            if (shouldIgnore(dirent.name)) return [];
                            const res = path.resolve(dir, dirent.name);
                            if (dirent.isDirectory()) {
                                return getFiles(res, depth + 1);
                            }
                            return path.relative(WORKSPACE_ROOT, res).replace(/\\/g, '/');
                        })
                    );
                    return files.flat();
                }

                try {
                    const files = await getFiles(absolutePath);
                    return { root: dirPath, files: files.slice(0, 500), totalFiles: files.length };
                } catch (error) {
                    return { error: `Error listing ${dirPath}: ${error.message}` };
                }
            }, ctx);

        case 'glob_files':
            return (async () => {
                const pattern = args.pattern;
                if (!pattern) return { error: 'glob_files requires a "pattern" argument' };
                const dirPath = args.path || '.';
                const absolutePath = resolvePath(dirPath, WORKSPACE_ROOT);
                try {
                    const files = await globFiles(absolutePath, pattern);
                    return { pattern, files, count: files.length };
                } catch (error) {
                    return { error: `Glob error: ${error.message}` };
                }
            })();

        case 'search_files':
            return withPermission('search_files', async () => {
                const query = args.query;
                const dirPath = args.path || '.';
                const maxResults = args.maxResults || 50;
                const includeFilter = args.include || '';

                if (!query) return { error: 'search_files requires a "query" string' };

                const absolutePath = resolvePath(dirPath, WORKSPACE_ROOT);
                const matches = [];
                let regex;
                try { regex = new RegExp(query, 'gi'); } catch {
                    regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                }

                const extensions = includeFilter ? includeFilter.split(',').map(e => e.trim().toLowerCase()) : [];

                async function searchDir(dir, depth = 0) {
                    if (depth > 8 || matches.length >= maxResults) return;
                    let dirents;
                    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }

                    for (const dirent of dirents) {
                        if (matches.length >= maxResults) break;
                        if (shouldIgnore(dirent.name)) continue;

                        const res = path.resolve(dir, dirent.name);
                        if (dirent.isDirectory()) {
                            await searchDir(res, depth + 1);
                        } else {
                            if (extensions.length > 0) {
                                const ext = path.extname(dirent.name).toLowerCase();
                                if (!extensions.some(e => ext === e || ext === `.${e}` || dirent.name.endsWith(e))) continue;
                            }
                            try {
                                const content = await fsp.readFile(res, 'utf8');
                                const lines = content.split('\n');
                                for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
                                    regex.lastIndex = 0;
                                    if (regex.test(lines[i])) {
                                        matches.push({
                                            file: path.relative(WORKSPACE_ROOT, res).replace(/\\/g, '/'),
                                            line: i + 1,
                                            text: lines[i].trim().slice(0, 200)
                                        });
                                    }
                                }
                            } catch { }
                        }
                    }
                }

                try {
                    await searchDir(absolutePath);
                    return { query, matches, totalMatches: matches.length };
                } catch (error) {
                    return { error: `Search error: ${error.message}` };
                }
            }, ctx);

        case 'read_url':
            if (!read_url) return { error: 'Browser module not available. Install puppeteer.' };
            return read_url(args);

        case 'perform_browser_task':
            if (!perform_browser_task) return { error: 'Browser module not available. Install puppeteer.' };
            return perform_browser_task(args);

        case 'screenshot_url':
            if (!screenshot_url) return { error: 'Browser module not available.' };
            return screenshot_url(args, ctx);

        case 'analyze_image':
            if (!analyze_image) return { error: 'Browser module not available.' };
            return (async () => {
                const imgResult = await analyze_image(args, ctx);
                if (imgResult.error) return imgResult;
                // If a prompt is provided and vision LLM is available, analyze with vision
                if (args.prompt && callVisionLLM && imgResult.base64) {
                    try {
                        const analysis = await callVisionLLM({
                            prompt: args.prompt || 'Describe this image in detail. What do you see?',
                            imageBase64: imgResult.base64,
                            mimeType: imgResult.mimeType,
                            options: { timeout: 60000 }
                        });
                        return { ...imgResult, base64: '(omitted)', analysis };
                    } catch (visionErr) {
                        return { ...imgResult, base64: '(omitted)', visionError: visionErr.message, note: 'Vision analysis failed. Image saved at: ' + imgResult.path };
                    }
                }
                return { ...imgResult, base64: '(omitted for context)', note: 'Image loaded. Use a vision model (llava, qwen-vl) for visual analysis.' };
            })();

        case 'browser_open':
            if (!browser_open) return { error: 'Browser module not available.' };
            return browser_open(args, ctx);

        case 'browser_screenshot':
            if (!browser_screenshot) return { error: 'Browser module not available.' };
            return browser_screenshot(args, ctx);

        case 'browser_click':
            if (!browser_click) return { error: 'Browser module not available.' };
            return browser_click(args);

        case 'browser_type':
            if (!browser_type) return { error: 'Browser module not available.' };
            return browser_type(args);

        case 'browser_extract':
            if (!browser_extract) return { error: 'Browser module not available.' };
            return browser_extract(args);

        case 'browser_evaluate':
            if (!browser_evaluate) return { error: 'Browser module not available.' };
            return browser_evaluate(args);

        case 'browser_wait':
            if (!browser_wait) return { error: 'Browser module not available.' };
            return browser_wait(args);

        case 'browser_close':
            if (!browser_close) return { error: 'Browser module not available.' };
            return browser_close();

        case 'read_docs':
            if (!read_docs) return { error: 'Docs module not available.' };
            return read_docs(args);

        case 'memory_read':
            return (async () => {
                const key = args.key;
                if (!key) return { error: 'memory_read requires a "key" argument' };
                const value = memoryRead(key);
                return value !== null ? { key, value } : { key, value: null, message: 'Key not found' };
            })();

        case 'memory_write':
            return (async () => {
                const key = args.key;
                const value = args.value;
                if (!key) return { error: 'memory_write requires a "key" argument' };
                return memoryWrite(key, value);
            })();

        case 'memory_list':
            return memoryList();

        case 'task_list':
            return (async () => {
                const tasks = sessionTasks.get(ctx.sessionId || 'default') || [];
                return { tasks };
            })();

        case 'task_update':
            return (async () => {
                const sid = ctx.sessionId || 'default';
                if (!sessionTasks.has(sid)) sessionTasks.set(sid, []);
                const tasks = sessionTasks.get(sid);
                const existing = tasks.find(t => t.id === args.id);
                if (existing) {
                    existing.content = args.content || existing.content;
                    existing.status = args.status || existing.status;
                } else {
                    tasks.push({ id: args.id, content: args.content, status: args.status || 'pending' });
                }
                return { ok: true, tasks };
            })();

        // ---------------------------------------------------------------
        // Git Tools
        // ---------------------------------------------------------------

        case 'git_status':
            return withPermission('run_shell', async () => {
                return new Promise((resolve) => {
                    exec('git status --porcelain -b', { cwd: WORKSPACE_ROOT, timeout: 10000 }, (error, stdout, stderr) => {
                        if (error) {
                            if (stderr?.includes('not a git repository')) {
                                resolve({ error: 'Not a git repository. Initialize with: git init' });
                            } else {
                                resolve({ error: stderr || error.message });
                            }
                            return;
                        }
                        const lines = stdout.trim().split('\n').filter(Boolean);
                        const branch = lines[0]?.replace(/^## /, '') || 'unknown';
                        const files = lines.slice(1).map(l => ({
                            status: l.slice(0, 2).trim(),
                            file: l.slice(3)
                        }));
                        resolve({ branch, files, totalChanges: files.length, raw: stdout.trim() });
                    });
                });
            }, ctx);

        case 'git_diff':
            return withPermission('run_shell', async () => {
                const staged = args.staged ? '--staged' : '';
                const filePath = args.path ? ` -- ${args.path}` : '';
                const cmd = `git diff ${staged}${filePath}`;
                return new Promise((resolve) => {
                    exec(cmd, { cwd: WORKSPACE_ROOT, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
                        if (error) {
                            resolve({ error: stderr || error.message });
                            return;
                        }
                        const diff = stdout.slice(0, 4000);
                        const truncated = stdout.length > 4000;
                        resolve({ diff, truncated, length: stdout.length });
                    });
                });
            }, ctx);

        case 'git_log':
            return withPermission('run_shell', async () => {
                const count = Math.min(args.count || 10, 30);
                const format = args.oneline !== false ? '--oneline' : '--format=medium';
                const cmd = `git log -${count} ${format}`;
                return new Promise((resolve) => {
                    exec(cmd, { cwd: WORKSPACE_ROOT, timeout: 10000 }, (error, stdout, stderr) => {
                        if (error) {
                            resolve({ error: stderr || error.message });
                            return;
                        }
                        resolve({ log: stdout.trim(), count });
                    });
                });
            }, ctx);

        case 'git_commit':
            return withPermission('run_shell', async () => {
                const message = args.message;
                if (!message) return { error: 'git_commit requires a "message"' };
                const files = args.files || '.';
                return new Promise((resolve) => {
                    const addCmd = `git add ${files}`;
                    exec(addCmd, { cwd: WORKSPACE_ROOT, timeout: 10000 }, (addErr, _addOut, addStderr) => {
                        if (addErr) {
                            resolve({ error: `git add failed: ${addStderr || addErr.message}` });
                            return;
                        }
                        const safeMsg = message.replace(/"/g, '\\"');
                        exec(`git commit -m "${safeMsg}"`, { cwd: WORKSPACE_ROOT, timeout: 15000 }, (err, stdout, stderr) => {
                            if (err) {
                                resolve({ error: stderr || err.message });
                                return;
                            }
                            resolve({ ok: true, message: stdout.trim() });
                        });
                    });
                });
            }, ctx);

        case 'git_branch':
            return withPermission('run_shell', async () => {
                const action = args.action || 'current';
                let cmd;
                switch (action) {
                    case 'list': cmd = 'git branch -a'; break;
                    case 'current': cmd = 'git branch --show-current'; break;
                    case 'create':
                        if (!args.name) return { error: 'Branch name required' };
                        cmd = `git checkout -b ${args.name}`;
                        break;
                    case 'checkout':
                        if (!args.name) return { error: 'Branch name required' };
                        cmd = `git checkout ${args.name}`;
                        break;
                    default: return { error: `Unknown action: ${action}. Use: list, current, create, checkout` };
                }
                return new Promise((resolve) => {
                    exec(cmd, { cwd: WORKSPACE_ROOT, timeout: 10000 }, (error, stdout, stderr) => {
                        if (error) {
                            resolve({ error: stderr || error.message });
                            return;
                        }
                        resolve({ ok: true, result: stdout.trim() || stderr.trim() });
                    });
                });
            }, ctx);

        // ---------------------------------------------------------------
        // Lint & Test Tools
        // ---------------------------------------------------------------

        case 'run_lint':
            return withPermission('run_shell', async () => {
                const filePath = args.path || '';
                const fix = args.fix ? '--fix' : '';

                // Auto-detect linter
                const detectors = [
                    { test: 'package.json', cmd: () => {
                        try {
                            const pkg = JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, 'package.json'), 'utf8'));
                            if (pkg.devDependencies?.eslint || pkg.dependencies?.eslint) {
                                return `npx eslint ${filePath || '.'} ${fix} --format compact --max-warnings 50 2>&1 || true`;
                            }
                            if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
                                return `npx tsc --noEmit 2>&1 | head -50 || true`;
                            }
                        } catch { }
                        return null;
                    }},
                    { test: 'pyproject.toml', cmd: () => `ruff check ${filePath || '.'} ${fix ? '--fix' : ''} 2>&1 || pylint ${filePath || '.'} 2>&1 || true` },
                    { test: 'Cargo.toml', cmd: () => 'cargo check 2>&1 | head -50 || true' },
                    { test: 'go.mod', cmd: () => `go vet ${filePath || './...'} 2>&1 || true` }
                ];

                let lintCmd = null;
                for (const d of detectors) {
                    if (fs.existsSync(path.join(WORKSPACE_ROOT, d.test))) {
                        lintCmd = typeof d.cmd === 'function' ? d.cmd() : d.cmd;
                        if (lintCmd) break;
                    }
                }

                if (!lintCmd) return { error: 'No linter detected. Install eslint, tsc, ruff, or cargo.' };

                return new Promise((resolve) => {
                    exec(lintCmd, { cwd: WORKSPACE_ROOT, timeout: 45000, maxBuffer: 1024 * 512 }, (error, stdout, stderr) => {
                        const output = (stdout || '').slice(0, 3000) + (stderr ? '\n' + stderr.slice(0, 1000) : '');
                        const hasErrors = output.includes('error') || output.includes('Error');
                        resolve({
                            ok: !hasErrors,
                            output: output.trim() || 'No lint issues found.',
                            hasErrors
                        });
                    });
                });
            }, ctx);

        case 'run_tests':
            return withPermission('run_shell', async () => {
                const testPath = args.path || '';
                const timeout = Math.min(args.timeout || 60000, 120000);

                // Auto-detect test runner
                const detectors = [
                    { test: 'package.json', cmd: () => {
                        try {
                            const pkg = JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, 'package.json'), 'utf8'));
                            if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
                                return `npm test ${testPath ? '-- ' + testPath : ''} 2>&1 || true`;
                            }
                            if (pkg.devDependencies?.jest || pkg.dependencies?.jest) {
                                return `npx jest ${testPath} --no-coverage 2>&1 || true`;
                            }
                            if (pkg.devDependencies?.mocha) {
                                return `npx mocha ${testPath || 'test/**'} 2>&1 || true`;
                            }
                            if (pkg.devDependencies?.vitest) {
                                return `npx vitest run ${testPath} 2>&1 || true`;
                            }
                        } catch { }
                        return null;
                    }},
                    { test: 'pyproject.toml', cmd: () => `pytest ${testPath || '.'} -v --tb=short 2>&1 || true` },
                    { test: 'Cargo.toml', cmd: () => `cargo test ${testPath} 2>&1 || true` },
                    { test: 'go.mod', cmd: () => `go test ${testPath || './...'} -v 2>&1 || true` }
                ];

                let testCmd = null;
                for (const d of detectors) {
                    if (fs.existsSync(path.join(WORKSPACE_ROOT, d.test))) {
                        testCmd = typeof d.cmd === 'function' ? d.cmd() : d.cmd;
                        if (testCmd) break;
                    }
                }

                if (!testCmd) return { error: 'No test runner detected. Install jest, pytest, cargo, or configure npm test.' };

                return new Promise((resolve) => {
                    exec(testCmd, { cwd: WORKSPACE_ROOT, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
                        const output = (stdout || '').slice(0, 3000) + (stderr ? '\n' + stderr.slice(0, 1000) : '');
                        const passed = output.includes('passed') || output.includes('PASS') || output.includes('ok');
                        const failed = output.includes('failed') || output.includes('FAIL') || output.includes('error');
                        resolve({
                            ok: passed && !failed,
                            output: output.trim() || 'No test output.',
                            passed,
                            failed
                        });
                    });
                });
            }, ctx);

        // ---------------------------------------------------------------
        // Batch & Codebase Tools
        // ---------------------------------------------------------------

        case 'batch_read':
            return withPermission('read_file', async () => {
                const paths = (args.paths || '').split(',').map(p => p.trim()).filter(Boolean);
                if (paths.length === 0) return { error: 'No paths provided' };
                const results = {};
                const MAX_PER_FILE = 1200;
                for (const p of paths.slice(0, 6)) {
                    try {
                        const abs = resolvePath(p, WORKSPACE_ROOT);
                        const content = await fsp.readFile(abs, 'utf8');
                        const lines = content.split('\n');
                        if (lines.length > 100) {
                            results[p] = lines.slice(0, 100).join('\n') + `\n...[${lines.length - 100} more lines]`;
                        } else {
                            results[p] = content.slice(0, MAX_PER_FILE);
                        }
                    } catch (e) {
                        results[p] = `Error: ${e.message}`;
                    }
                }
                return { files: results, count: Object.keys(results).length };
            }, ctx);

        case 'codebase_search':
            return (async () => {
                const query = args.query;
                if (!query) return { error: 'codebase_search requires a "query"' };
                const max = args.maxResults || 8;
                try {
                    const index = await getIndex(WORKSPACE_ROOT);
                    const relevant = findRelevantFiles(query, index, max);

                    // Also do a quick grep for the most important terms
                    const terms = query.split(/\s+/).filter(t => t.length > 3).slice(0, 3);
                    const grepResults = [];
                    if (terms.length > 0) {
                        const grepPattern = terms[0];
                        try {
                            const searchResult = await runTool('search_files', {
                                query: grepPattern,
                                maxResults: 10
                            }, { workspaceRoot: WORKSPACE_ROOT, autoMode: true });
                            if (searchResult?.matches) {
                                grepResults.push(...searchResult.matches.slice(0, 5));
                            }
                        } catch { }
                    }

                    return {
                        query,
                        relevantFiles: relevant.map(f => ({ path: f.path, score: f.score, ext: f.ext })),
                        grepMatches: grepResults,
                        totalIndexedFiles: index.fileCount
                    };
                } catch (e) {
                    return { error: `Codebase search failed: ${e.message}` };
                }
            })();

        case 'mcp_list_tools':
            return (async () => {
                await ensureMcpClients();
                const out = {};
                const tools_flat = [];
                for (const [name, client] of mcpClients.entries()) {
                    if (client?.error) {
                        out[name] = { error: client.error };
                        continue;
                    }
                    try {
                        const res = await client.listTools();
                        out[name] = res;
                        const items = Array.isArray(res?.tools) ? res.tools : (Array.isArray(res) ? res : []);
                        for (const t of items) {
                            const toolName = t?.name || t?.tool || '';
                            if (toolName) tools_flat.push({ server: name, tool: toolName, description: t?.description || '' });
                        }
                    } catch (e) {
                        out[name] = { error: String(e) };
                    }
                }
                return { servers: out, tools_flat };
            })();

        case 'mcp_call_tool':
            return (async () => {
                await ensureMcpClients();
                let server = args.server;
                const toolName = args.tool || args.name;
                const toolArgs = args.arguments || args.args || {};
                if (!toolName) {
                    return { error: 'mcp_call_tool requires { tool, arguments }' };
                }
                if (!server) {
                    const available = Array.from(mcpClients.keys());
                    if (available.length === 1) server = available[0];
                }
                const client = mcpClients.get(server);
                if (!client || client?.error) {
                    return { error: `MCP server "${server}" not available`, details: client?.error || null };
                }
                try {
                    const result = await client.callTool(toolName, toolArgs);
                    return { ok: true, server, tool: toolName, result };
                } catch (e) {
                    return { error: `MCP tool call failed: ${String(e)}`, server, tool: toolName };
                }
            })();

        default:
            return { error: `Unknown tool: ${tool}. Available: ${TOOL_DEFINITIONS.map(t => t.name).join(', ')}` };
    }
}

module.exports = { runTool, TOOL_DEFINITIONS };
