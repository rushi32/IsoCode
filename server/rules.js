// server/rules.js
// Load project-level rules from multiple sources:
//   .isocode/rules.md, AGENTS.md, CLAUDE.md, .cursorrules (legacy), .cursor/rules (legacy)
// Similar to IsoCode rules + Claude Code CLAUDE.md + OpenClaw AGENTS.md

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const RULE_FILES = [
    '.isocode/rules.md',
    'AGENTS.md',
    'CLAUDE.md',
    '.cursorrules',
];

const RULE_DIRS = [
    '.cursor/rules',
    '.isocode/rules'
];

/**
 * Load all project rules and combine them.
 * @param {string} workspaceRoot
 * @returns {Promise<string>} Combined rules text
 */
async function loadProjectRules(workspaceRoot) {
    const root = workspaceRoot || process.cwd();
    const parts = [];

    // Load individual rule files
    for (const relPath of RULE_FILES) {
        const fullPath = path.join(root, relPath);
        try {
            const content = await fsp.readFile(fullPath, 'utf8');
            if (content.trim()) {
                parts.push(`[Rules from ${relPath}]\n${content.trim()}`);
            }
        } catch { }
    }

    // Load rule directories
    for (const dir of RULE_DIRS) {
        const dirPath = path.join(root, dir);
        try {
            const entries = await fsp.readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile()) continue;
                if (!['.md', '.txt', '.rules'].includes(path.extname(entry.name))) continue;
                const filePath = path.join(dirPath, entry.name);
                const content = await fsp.readFile(filePath, 'utf8');
                if (content.trim()) {
                    parts.push(`[Rules from ${dir}/${entry.name}]\n${content.trim()}`);
                }
            }
        } catch { }
    }

    if (parts.length === 0) return '';

    return `\n\nPROJECT RULES (from workspace configuration — follow these strictly):\n${parts.join('\n\n')}`;
}

/**
 * Quick check if any rules files exist.
 */
async function hasProjectRules(workspaceRoot) {
    const root = workspaceRoot || process.cwd();
    for (const relPath of RULE_FILES) {
        try {
            await fsp.access(path.join(root, relPath));
            return true;
        } catch { }
    }
    return false;
}

module.exports = { loadProjectRules, hasProjectRules };
