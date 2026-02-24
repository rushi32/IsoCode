/**
 * Code Actions - Hover-based code fixes and improvements
 */

class CodeActions {
    constructor(vscodeApi) {
        this.vscode = vscodeApi;
        this.problemsCache = [];
    }

    /**
     * Show quick fix menu on hover
     */
    showQuickFixMenu(problem, element) {
        const menu = document.createElement('div');
        menu.className = 'quick-fix-menu md-card-elevated';
        menu.style.cssText = `
            position: absolute;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 8px;
            min-width: 200px;
            z-index: 1000;
            box-shadow: var(--md-elevation-4);
        `;

        // Position near the element
        const rect = element.getBoundingClientRect();
        menu.style.top = `${rect.bottom + 5}px`;
        menu.style.left = `${rect.left}px`;

        // Problem description
        const desc = document.createElement('div');
        desc.style.cssText = `
            padding: 8px;
            font-size: 12px;
            color: var(--text-secondary);
            border-bottom: 1px solid var(--border-color);
            margin-bottom: 4px;
        `;
        desc.textContent = problem.message;
        menu.appendChild(desc);

        // Quick actions
        const actions = [
            { icon: '🔍', label: 'Explain Problem', action: 'explain' },
            { icon: '🔧', label: 'Fix Automatically', action: 'fix' },
            { icon: '💡', label: 'Suggest Solutions', action: 'suggest' },
            { icon: '📚', label: 'Learn More', action: 'learn' }
        ];

        actions.forEach(({ icon, label, action }) => {
            const btn = document.createElement('button');
            btn.className = 'md-button-text';
            btn.style.cssText = `
                width: 100%;
                text-align: left;
                padding: 8px 12px;
                font-size: 13px;
                display: flex;
                align-items: center;
                gap: 8px;
            `;
            btn.innerHTML = `<span>${icon}</span><span>${label}</span>`;

            btn.onclick = () => {
                this.handleQuickAction(action, problem);
                menu.remove();
            };

            menu.appendChild(btn);
        });

        // Close on click outside
        const closeHandler = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 100);

        document.body.appendChild(menu);
        return menu;
    }

    /**
     * Handle quick action
     */
    handleQuickAction(action, problem) {
        const messages = {
            explain: `Explain this error: ${problem.message}\n\nFile: ${problem.file}\nLine: ${problem.line}`,
            fix: `Fix this error automatically: ${problem.message}\n\nFile: ${problem.file}\nLine: ${problem.line}\n\nCode:\n${problem.code}`,
            suggest: `Suggest solutions for: ${problem.message}\n\nFile: ${problem.file}\nLine: ${problem.line}`,
            learn: `Explain why this is a problem and how to avoid it in the future: ${problem.message}`
        };

        if (this.vscode && messages[action]) {
            this.vscode.postMessage({
                type: 'ask',
                value: messages[action],
                autoMode: true
            });
        }
    }

    /**
     * Add explain and fix overlay to problem indicators
     */
    enhanceProblemIndicators() {
        // This would be called whenever problems are displayed
        // In a real implementation, this would integrate with VS Code's diagnostic system
        document.querySelectorAll('.problem-indicator').forEach(indicator => {
            indicator.style.cursor = 'pointer';
            indicator.title = 'Click for quick fixes';

            indicator.addEventListener('click', (e) => {
                e.stopPropagation();
                const problemData = JSON.parse(indicator.dataset.problem || '{}');
                this.showQuickFixMenu(problemData, indicator);
            });
        });
    }

    /**
     * Multi-step refactoring workflow
     */
    startRefactoringWorkflow(code, goal) {
        return {
            steps: [
                {
                    id: 1,
                    title: 'Analyze Code',
                    description: 'Analyzing code structure and identifying refactoring opportunities',
                    status: 'pending'
                },
                {
                    id: 2,
                    title: 'Plan Changes',
                    description: 'Creating refactoring plan with safe transformations',
                    status: 'pending'
                },
                {
                    id: 3,
                    title: 'Apply Changes',
                    description: 'Applying refactoring changes incrementally',
                    status: 'pending'
                },
                {
                    id: 4,
                    title: 'Verify Results',
                    description: 'Running tests and verifying correctness',
                    status: 'pending'
                }
            ],
            code,
            goal
        };
    }

    /**
     * Render refactoring workflow UI
     */
    renderRefactoringWorkflow(workflow) {
        const container = document.createElement('div');
        container.className = 'refactoring-workflow md-card';
        container.style.cssText = `
            padding: 16px;
            margin: 12px 0;
        `;

        const header = document.createElement('div');
        header.style.cssText = 'font-weight: 500; font-size: 14px; margin-bottom: 16px;';
        header.textContent = `Refactoring: ${workflow.goal}`;
        container.appendChild(header);

        workflow.steps.forEach((step, index) => {
            const stepEl = document.createElement('div');
            stepEl.style.cssText = `
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 12px;
                border-radius: 8px;
                margin-bottom: 8px;
                background: var(--vscode-editorWidget-background);
            `;

            const statusIcon = document.createElement('div');
            statusIcon.style.cssText = 'width: 24px; height: 24px; flex-shrink: 0;';

            if (step.status === 'completed') {
                statusIcon.textContent = '✅';
            } else if (step.status === 'running') {
                statusIcon.innerHTML = '<div class="md-spinner"></div>';
            } else if (step.status === 'error') {
                statusIcon.textContent = '❌';
            } else {
                statusIcon.textContent = '⏸️';
            }

            const content = document.createElement('div');
            content.style.flex = '1';
            content.innerHTML = `
                <div style="font-weight: 500; font-size: 13px; margin-bottom: 4px;">
                    ${step.id}. ${step.title}
                </div>
                <div style="font-size: 11px; color: var(--text-secondary);">
                    ${step.description}
                </div>
            `;

            stepEl.appendChild(statusIcon);
            stepEl.appendChild(content);
            container.appendChild(stepEl);
        });

        return container;
    }

    /**
     * Inline feedback on artifacts
     */
    enableInlineFeedback(artifactElement, artifactData) {
        // Add comment icons to artifact sections
        const sections = artifactElement.querySelectorAll('h2, h3');
        sections.forEach(section => {
            const commentBtn = document.createElement('button');
            commentBtn.className = 'md-icon-button';
            commentBtn.style.cssText = `
                margin-left: 8px;
                opacity: 0;
                transition: opacity 0.2s ease;
            `;
            commentBtn.textContent = '💬';
            commentBtn.title = 'Add comment';

            commentBtn.onclick = () => {
                this.showCommentInput(section, artifactData);
            };

            section.style.position = 'relative';
            section.appendChild(commentBtn);

            section.onmouseenter = () => { commentBtn.style.opacity = '0.7'; };
            section.onmouseleave = () => { commentBtn.style.opacity = '0'; };
        });
    }

    /**
     * Show comment input
     */
    showCommentInput(element, artifactData) {
        const input = document.createElement('textarea');
        input.className = 'inline-comment-input';
        input.style.cssText = `
            width: 100%;
            padding: 8px;
            margin-top: 8px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            background: var(--input-bg);
            color: var(--text-primary);
            font-family: inherit;
            font-size: 12px;
            resize: vertical;
            min-height: 60px;
        `;
        input.placeholder = 'Add your feedback or question...';

        const actions = document.createElement('div');
        actions.style.cssText = 'display: flex; gap: 8px; margin-top: 8px;';

        const submitBtn = document.createElement('button');
        submitBtn.className = 'md-button-filled';
        submitBtn.textContent = 'Submit';
        submitBtn.onclick = () => {
            if (input.value.trim()) {
                this.submitFeedback(artifactData, element.textContent, input.value);
                input.value = '';
                input.remove();
                actions.remove();
            }
        };

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'md-button-text';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => {
            input.remove();
            actions.remove();
        };

        actions.appendChild(submitBtn);
        actions.appendChild(cancelBtn);

        element.parentElement.insertBefore(input, element.nextSibling);
        element.parentElement.insertBefore(actions, input.nextSibling);
        input.focus();
    }

    /**
     * Submit feedback
     */
    submitFeedback(artifactData, section, feedback) {
        if (this.vscode) {
            this.vscode.postMessage({
                type: 'artifact-feedback',
                value: {
                    artifactId: artifactData.id,
                    section,
                    feedback
                }
            });
        }
    }
}

// Export
if (typeof window !== 'undefined') {
    window.CodeActions = CodeActions;
}
