// server/codebase.js
// Codebase indexing, smart context gathering, and auto-relevance scoring.
// Provides IsoCode-style codebase awareness so the agent knows
// what's in the project without reading every file.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { updateProjectContext } = require('./store');

const IGNORED = new Set([
    'node_modules', '.git', 'dist', 'out', '.next', 'build',
    '__pycache__', '.venv', 'venv', '.cache', 'coverage',
    '.nyc_output', '.parcel-cache', '.turbo', '.vercel',
    '.svelte-kit', '.nuxt', 'vendor', 'target'
]);

const BINARY_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
    '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.wav',
    '.zip', '.tar', '.gz', '.pdf', '.exe', '.dll', '.so', '.dylib',
    '.pyc', '.pyo', '.class', '.jar', '.lock', '.map'
]);

const KEY_FILES = [
    'package.json', 'tsconfig.json', 'pyproject.toml', 'requirements.txt',
    'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Gemfile',
    'Makefile', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
    '.env.example', 'README.md', 'AGENTS.md', 'CLAUDE.md',
    '.isocode/rules.md', '.cursorrules'
];

// ---------------------------------------------------------------------------
// File index — lightweight map of all files with metadata
// ---------------------------------------------------------------------------

let fileIndex = null;
let indexTimestamp = 0;
const INDEX_TTL = 60000; // refresh every 60s

/**
 * Build a file index for the workspace.
 * Returns { files: [{path, ext, size, dir}], dirs: [string], keyFiles: {name: content} }
 */
async function buildIndex(workspaceRoot) {
    const root = workspaceRoot || process.cwd();
    const files = [];
    const dirs = new Set();
    const keyFileContents = {};

    async function walk(dir, depth = 0) {
        if (depth > 6) return;
        let entries;
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }

        for (const entry of entries) {
            if (IGNORED.has(entry.name)) continue;
            if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;

            const fullPath = path.join(dir, entry.name);
            const relPath = path.relative(root, fullPath).replace(/\\/g, '/');

            if (entry.isDirectory()) {
                dirs.add(relPath);
                await walk(fullPath, depth + 1);
            } else {
                const ext = path.extname(entry.name).toLowerCase();
                if (BINARY_EXT.has(ext)) continue;
                let size = 0;
                try { size = (await fsp.stat(fullPath)).size; } catch { }
                files.push({ path: relPath, ext, size, dir: path.dirname(relPath) });

                // Read key files
                if (KEY_FILES.includes(entry.name) || KEY_FILES.includes(relPath)) {
                    try {
                        const content = await fsp.readFile(fullPath, 'utf8');
                        keyFileContents[relPath] = content.slice(0, 2000);
                    } catch { }
                }
            }
        }
    }

    await walk(root);

    // Sort by path for consistency
    files.sort((a, b) => a.path.localeCompare(b.path));

    const index = {
        root,
        files,
        dirs: Array.from(dirs).sort(),
        keyFiles: keyFileContents,
        fileCount: files.length,
        timestamp: Date.now()
    };

    // Persist summary to project context
    updateProjectContext('fileCount', String(files.length));
    updateProjectContext('directories', Array.from(dirs).slice(0, 30).join(', '));
    const exts = {};
    for (const f of files) { exts[f.ext] = (exts[f.ext] || 0) + 1; }
    const topExts = Object.entries(exts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([e, c]) => `${e}(${c})`).join(', ');
    updateProjectContext('fileTypes', topExts);

    return index;
}

async function getIndex(workspaceRoot) {
    if (fileIndex && (Date.now() - indexTimestamp) < INDEX_TTL) return fileIndex;
    fileIndex = await buildIndex(workspaceRoot);
    indexTimestamp = Date.now();
    return fileIndex;
}

function invalidateIndex() {
    fileIndex = null;
    indexTimestamp = 0;
}

// ---------------------------------------------------------------------------
// Smart context gathering — IsoCode auto-context
// ---------------------------------------------------------------------------

/**
 * Given a user query and the file index, score and return the most relevant files.
 * Uses keyword matching, path matching, and recency heuristics.
 */
function findRelevantFiles(query, index, maxFiles = 8) {
    if (!index?.files?.length) return [];

    const terms = query.toLowerCase().split(/[\s,.;:!?()"'`{}[\]]+/).filter(t => t.length > 2);
    const scored = [];

    for (const f of index.files) {
        let score = 0;
        const pathLower = f.path.toLowerCase();
        const name = path.basename(f.path).toLowerCase();

        // Direct file mention in query
        for (const term of terms) {
            if (name.includes(term)) score += 10;
            if (pathLower.includes(term)) score += 5;
        }

        // Key config files get a boost
        if (KEY_FILES.some(k => f.path.endsWith(k))) score += 3;

        // Extension relevance
        if (terms.some(t => ['.ts', '.js', '.py', '.rs', '.go', '.java'].includes(`.${t}`))) {
            if (f.ext === `.${terms.find(t => ['.ts', '.js', '.py'].includes(`.${t}`))}`) score += 4;
        }

        // Size penalty for huge files
        if (f.size > 50000) score -= 2;

        if (score > 0) {
            scored.push({ ...f, score });
        }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxFiles);
}

/**
 * Build a compact project map for injection into system prompt.
 * Much smaller than listing all files — focuses on structure.
 */
function buildProjectMap(index) {
    if (!index?.files?.length) return '';

    const lines = [];
    lines.push(`Project: ${index.fileCount} files`);

    // Directory tree (compact)
    const topDirs = index.dirs.filter(d => !d.includes('/') || d.split('/').length <= 2).slice(0, 20);
    if (topDirs.length > 0) {
        lines.push('Directories: ' + topDirs.join(', '));
    }

    // Key files
    const keyNames = Object.keys(index.keyFiles);
    if (keyNames.length > 0) {
        lines.push('Key files: ' + keyNames.join(', '));
    }

    // File type breakdown
    const exts = {};
    for (const f of index.files) { exts[f.ext || '(no ext)'] = (exts[f.ext || '(no ext)'] || 0) + 1; }
    const breakdown = Object.entries(exts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([e, c]) => `${e}: ${c}`)
        .join(', ');
    lines.push('Types: ' + breakdown);

    return lines.join('\n');
}

/**
 * Read and return contents of the most relevant files for a query.
 * Used to auto-inject context before the agent runs.
 */
async function gatherAutoContext(query, workspaceRoot, maxChars = 6000) {
    const index = await getIndex(workspaceRoot);
    const relevant = findRelevantFiles(query, index);

    if (relevant.length === 0) return '';

    const parts = [];
    let totalChars = 0;
    const root = workspaceRoot || process.cwd();

    for (const f of relevant) {
        if (totalChars >= maxChars) break;
        try {
            const content = await fsp.readFile(path.join(root, f.path), 'utf8');
            const budget = Math.min(1500, maxChars - totalChars);
            const trimmed = content.length > budget
                ? content.slice(0, budget) + '\n...[truncated]'
                : content;
            parts.push(`File: ${f.path} (relevance: ${f.score})\n\`\`\`\n${trimmed}\n\`\`\``);
            totalChars += trimmed.length;
        } catch { }
    }

    return parts.length > 0
        ? `\n\nAuto-gathered context (${parts.length} relevant files):\n${parts.join('\n\n')}`
        : '';
}

module.exports = {
    buildIndex,
    getIndex,
    invalidateIndex,
    findRelevantFiles,
    buildProjectMap,
    gatherAutoContext
};
