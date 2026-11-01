import * as vscode from 'vscode';

/**
 * Claude Grasp stores its data with the SQLite built into Node ≥ 22.13. An editor whose
 * runtime lacks it gets a clear message instead of a stack trace.
 */
function hasSqlite(): boolean {
  try {
    return !!process.getBuiltinModule?.('node:sqlite');
  } catch {
    return false;
  }
}

export async function activate(context: vscode.ExtensionContext) {
  if (!hasSqlite()) {
    void vscode.window.showErrorMessage(`Claude Grasp needs a newer VS Code (its Node ${process.versions.node} has no built-in SQLite). Please update VS Code.`);
    return;
  }
  // Loaded only after the check, so nothing touches node:sqlite before it.
  const { start } = await import('./host');
  await start(context);
}

export function deactivate() {}
