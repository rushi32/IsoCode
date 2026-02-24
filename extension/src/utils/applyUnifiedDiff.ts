import * as vscode from 'vscode';
import { applyPatch } from 'diff';
import * as fs from 'fs';
import * as path from 'path';

/** Fix common invalid hunk headers from LLM output (e.g. @@ without line numbers). */
function normalizeUnifiedDiff(diff: string): string {
  let out = diff;
  if (/^@@\s*$/m.test(out) || /^@@\s*\n/.test(out)) {
    out = out.replace(/^@@\s*\n/gm, '@@ -0,0 +0,0 @@\n');
  }
  if (/\nEnd of File\s*"?\s*$/i.test(out)) {
    out = out.replace(/\nEnd of File\s*"?\s*$/i, '\n');
  }
  return out;
}

/**
 * Apply a unified diff to a file. Creates the file (and parent dirs) if it does not exist.
 * Uses workspace root for relative paths.
 */
export async function applyUnifiedDiff(
  filePath: string,
  unifiedDiff: string
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : workspaceRoot
      ? path.join(workspaceRoot, filePath)
      : path.resolve(filePath);

  let original = '';
  try {
    original = fs.readFileSync(absPath, 'utf8');
  } catch {
    const dir = path.dirname(absPath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const normalized = normalizeUnifiedDiff(unifiedDiff);
  let patched = applyPatch(original, normalized);
  if (patched === false) {
    patched = applyPatch(original, unifiedDiff);
  }
  if (patched === false) {
    throw new Error('Diff could not be applied (context mismatch or invalid diff)');
  }

  fs.writeFileSync(absPath, patched, 'utf8');

  const uri = vscode.Uri.file(absPath);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
}
