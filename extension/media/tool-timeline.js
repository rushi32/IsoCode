/**
 * Tool Timeline Visualization - Shows agent's tool usage in a timeline
 */

class ToolTimeline {
    constructor() {
        this.toolCalls = [];
        this.currentTask = null;
    }

    /**
     * Add a tool call to the timeline
     */
    addToolCall(toolCall) {
        const call = {
            id: this.generateId(),
            taskId: this.currentTask?.id,
            timestamp: Date.now(),
            ...toolCall
        };
        this.toolCalls.push(call);
        return call;
    }

    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    /**
     * Start a new task
     */
    startTask(taskName, mode) {
        this.currentTask = {
            id: this.generateId(),
            name: taskName,
            mode: mode || 'execution',
            startTime: Date.now(),
            toolCalls: []
        };
        return this.currentTask;
    }

    /**
     * End current task
     */
    endTask() {
        if (this.currentTask) {
            this.currentTask.endTime = Date.now();
            this.currentTask = null;
        }
    }

    /**
     * Render tool timeline
     */
    renderTimeline(toolCalls) {
        const container = document.createElement('div');
        container.className = 'tool-timeline';
        container.style.padding = '12px';
        container.style.background = 'var(--vscode-editorWidget-background)';
        container.style.borderRadius = '8px';
        container.style.marginTop = '8px';

        const toolIcons = {
            'file_read': '📖',
            'file_write': '✍️',
            'command': '⚙️',
            'search': '🔍',
            'browser': '🌐',
            'default': '🔧'
        };

        toolCalls.forEach((call, index) => {
            const item = document.createElement('div');
            item.className = 'timeline-item';
            item.style.display = 'flex';
            item.style.alignItems = 'flex-start';
            item.style.gap = '12px';
            item.style.padding = '8px 0';
            item.style.borderLeft = '2px solid var(--vscode-button-background)';
            item.style.paddingLeft = '16px';
            item.style.marginLeft = '8px';
            item.style.position = 'relative';

            // Icon
            const icon = document.createElement('div');
            icon.className = 'timeline-icon';
            icon.style.width = '24px';
            icon.style.height = '24px';
            icon.style.borderRadius = '50%';
            icon.style.background = 'var(--vscode-button-background)';
            icon.style.display = 'flex';
            icon.style.alignItems = 'center';
            icon.style.justifyContent = 'center';
            icon.style.fontSize = '14px';
            icon.style.position = 'absolute';
            icon.style.left = '-13px';
            icon.textContent = toolIcons[call.tool] || toolIcons.default;

            // Content
            const content = document.createElement('div');
            content.style.flex = '1';
            content.style.marginLeft = '20px';

            const header = document.createElement('div');
            header.style.fontWeight = '500';
            header.style.fontSize = '13px';
            header.style.marginBottom = '4px';
            header.textContent = call.name || call.tool;

            const details = document.createElement('div');
            details.style.fontSize = '12px';
            details.style.color = 'var(--text-secondary)';
            details.style.marginBottom = '4px';

            if (call.description) {
                details.textContent = call.description;
            } else if (call.params) {
                details.textContent = JSON.stringify(call.params).substring(0, 100) + '...';
            }

            const status = document.createElement('div');
            status.style.fontSize = '11px';
            status.style.display = 'flex';
            status.style.alignItems = 'center';
            status.style.gap = '8px';

            if (call.status === 'success') {
                status.innerHTML = '<span style="color: #22863a;">✓ Success</span>';
            } else if (call.status === 'error') {
                status.innerHTML = '<span style="color: #b31d28;">✗ Error</span>';
            } else if (call.status === 'running') {
                status.innerHTML = '<span style="color: var(--text-secondary);">⟳ Running...</span>';
            }

            if (call.duration) {
                const durationSpan = document.createElement('span');
                durationSpan.style.color = 'var(--text-secondary)';
                durationSpan.textContent = `${call.duration}ms`;
                status.appendChild(durationSpan);
            }

            content.appendChild(header);
            content.appendChild(details);
            content.appendChild(status);

            item.appendChild(icon);
            item.appendChild(content);

            // Make expandable if has output
            if (call.output || call.error) {
                const expandBtn = document.createElement('button');
                expandBtn.className = 'md-icon-button';
                expandBtn.style.marginLeft = 'auto';
                expandBtn.textContent = '▼';
                expandBtn.style.transform = 'rotate(-90deg)';
                expandBtn.style.transition = 'transform 0.3s ease';

                const outputDiv = document.createElement('div');
                outputDiv.style.display = 'none';
                outputDiv.style.marginTop = '8px';
                outputDiv.style.padding = '8px';
                outputDiv.style.background = 'var(--vscode-editor-background)';
                outputDiv.style.borderRadius = '4px';
                outputDiv.style.fontSize = '11px';
                outputDiv.style.fontFamily = 'monospace';
                outputDiv.style.whiteSpace = 'pre-wrap';
                outputDiv.style.maxHeight = '200px';
                outputDiv.style.overflowY = 'auto';
                outputDiv.textContent = call.output || call.error;

                expandBtn.onclick = () => {
                    const isHidden = outputDiv.style.display === 'none';
                    outputDiv.style.display = isHidden ? 'block' : 'none';
                    expandBtn.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(-90deg)';
                };

                const headerDiv = document.createElement('div');
                headerDiv.style.display = 'flex';
                headerDiv.style.alignItems = 'center';
                headerDiv.appendChild(header);
                headerDiv.appendChild(expandBtn);

                content.insertBefore(headerDiv, content.firstChild);
                content.removeChild(header);
                content.appendChild(outputDiv);
            }

            container.appendChild(item);
        });

        return container;
    }

    /**
     * Render current task status
     */
    renderTaskStatus(task) {
        if (!task) return null;

        const container = document.createElement('div');
        container.className = 'task-status';
        container.style.padding = '12px 16px';
        container.style.background = 'var(--vscode-editorWidget-background)';
        container.style.borderRadius = '8px';
        container.style.marginBottom = '12px';
        container.style.borderLeft = '3px solid var(--vscode-button-background)';

        const modeColors = {
            planning: '#1976d2',
            execution: '#7b1fa2',
            verification: '#388e3c'
        };

        container.innerHTML = `
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
                <span style="font-weight: 500; font-size: 14px;">${task.name}</span>
                <span class="task-mode-${task.mode}" style="padding: 2px 8px; border-radius: 4px; font-size: 11px; text-transform: uppercase;">
                    ${task.mode}
                </span>
            </div>
            ${task.status ? `<div style="font-size: 12px; color: var(--text-secondary);">${task.status}</div>` : ''}
            ${task.summary ? `<div style="font-size: 12px; margin-top: 4px;">${task.summary}</div>` : ''}
        `;

        return container;
    }
}

// Export
if (typeof window !== 'undefined') {
    window.ToolTimeline = ToolTimeline;
}
