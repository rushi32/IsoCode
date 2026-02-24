/**
 * Workflow Commands Manager - Handles / slash commands
 */

class WorkflowCommands {
    constructor() {
        this.commands = new Map();
        this.initializeDefaultCommands();
    }

    /**
     * Register a workflow command
     */
    registerCommand(name, description, handler) {
        this.commands.set(name, {
            name,
            description,
            handler
        });
    }

    /**
     * Initialize default workflow commands
     */
    initializeDefaultCommands() {
        this.registerCommand('help', 'Show available commands', () => {
            return this.getHelpText();
        });

        this.registerCommand('clear', 'Clear chat history', () => {
            return { action: 'clear-chat' };
        });

        this.registerCommand('new', 'Start a new conversation', () => {
            return { action: 'new-conversation' };
        });

        this.registerCommand('export', 'Export current conversation', () => {
            return { action: 'export-conversation' };
        });

        this.registerCommand('settings', 'Open settings panel', () => {
            return { action: 'open-settings' };
        });

        this.registerCommand('explain', 'Explain selected code', () => {
            return { action: 'explain-selection' };
        });

        this.registerCommand('fix', 'Fix selected code', () => {
            return { action: 'fix-selection' };
        });

        this.registerCommand('test', 'Generate tests for selected code', () => {
            return { action: 'test-selection' };
        });

        this.registerCommand('refactor', 'Refactor selected code', () => {
            return { action: 'refactor-selection' };
        });

        this.registerCommand('optimize', 'Optimize selected code', () => {
            return { action: 'optimize-selection' };
        });

        this.registerCommand('docs', 'Generate documentation', () => {
            return { action: 'generate-docs' };
        });

        this.registerCommand('debug', 'Debug current file', () => {
            return { action: 'debug-file' };
        });
    }

    /**
     * Parse command from text
     */
    parseCommand(text) {
        const trimmed = text.trim();
        if (!trimmed.startsWith('/')) {
            return null;
        }

        const parts = trimmed.substring(1).split(/\s+/);
        const commandName = parts[0].toLowerCase();
        const args = parts.slice(1);

        const command = this.commands.get(commandName);
        if (command) {
            return {
                command: commandName,
                args,
                handler: command.handler
            };
        }

        return null;
    }

    /**
     * Execute command
     */
    executeCommand(text) {
        const parsed = this.parseCommand(text);
        if (!parsed) {
            return null;
        }

        return parsed.handler(parsed.args);
    }

    /**
     * Get help text
     */
    getHelpText() {
        let help = '## Available Commands\n\n';
        this.commands.forEach((cmd, name) => {
            help += `- **/${name}** - ${cmd.description}\n`;
        });
        return { type: 'help', content: help };
    }

    /**
     * Get command suggestions for autocomplete
     */
    getSuggestions(query) {
        const suggestions = [];
        const lowerQuery = query.toLowerCase();

        this.commands.forEach((cmd, name) => {
            if (name.startsWith(lowerQuery)) {
                suggestions.push({
                    name: `/${name}`,
                    description: cmd.description
                });
            }
        });

        return suggestions;
    }

    /**
     * Render autocomplete overlay
     */
    renderAutocomplete(suggestions, onSelect) {
        const overlay = document.createElement('div');
        overlay.className = 'command-autocomplete';
        overlay.style.cssText = `
            position: absolute;
            bottom: 80px;
            left: 20px;
            right: 20px;
            background: var(--md-sys-color-surface-variant);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            max-height: 250px;
            overflow-y: auto;
            z-index: 1000;
            box-shadow: var(--md-elevation-4);
            animation: slideUp 0.2s ease-out;
        `;

        const ul = document.createElement('ul');
        ul.className = 'md-list';

        suggestions.forEach(suggestion => {
            const li = document.createElement('li');
            li.className = 'md-list-item';

            li.innerHTML = `
                <span class="material-symbols-outlined" style="color: var(--accent);">terminal</span>
                <div class="command-content">
                    <div style="font-weight: 500; font-size: 14px;">${suggestion.name}</div>
                    <div style="font-size: 12px; opacity: 0.7;">${suggestion.description}</div>
                </div>
            `;

            li.onclick = () => {
                onSelect(suggestion.name);
                overlay.remove();
            };

            ul.appendChild(li);
        });

        overlay.appendChild(ul);
        return overlay;
    }
}

// Global export
window.WorkflowCommands = WorkflowCommands;
