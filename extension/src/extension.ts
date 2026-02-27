import * as vscode from 'vscode';
import { SidebarProvider } from './SidebarProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('IsoCode Local is now active!');

    const sidebarProvider = new SidebarProvider(context.extensionUri);
    context.subscriptions.push(sidebarProvider);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            "isocode-sidebar-view",
            sidebarProvider
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('isocode.explainSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('IsoCode: Open a file and select code to explain.');
                return;
            }
            const selection = editor.selection;
            const text = editor.document.getText(selection);
            if (!text || !text.trim()) {
                vscode.window.showInformationMessage('IsoCode: Select some code first, then run Explain Selection.');
                return;
            }
            const prompt = `Explain the following code:\n\n\`\`\`\n${text.trim()}\n\`\`\``;
            sidebarProvider.appendToPrompt(prompt);
            await vscode.commands.executeCommand('workbench.view.extension.isocode-sidebar-view');
        })
    );
}

export function deactivate() {}
