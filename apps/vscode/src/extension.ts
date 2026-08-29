/**
 * Activation.
 *
 * Called by `runtime/entry.cjs` with the `vscode` namespace as its first argument —
 * nothing in this package imports that module, so everything below is constructible
 * against a fake host. See `src/host/api.ts` for why.
 *
 * Activation is **lazy**: `package.json` declares only `onView:adze.chatView`, and
 * VS Code adds an implicit `onCommand:` event for each contributed command. Opening
 * an editor does not start Adze, so an installed-but-unused extension costs nothing
 * at startup. The consequence, stated plainly rather than hidden: **ghost text is
 * only available once the extension has activated** — that is, after the Adze view
 * has been opened or any Adze command has run in the window. Activating on startup
 * to avoid that would make every user pay for a feature that is off by default.
 *
 * Nothing here reaches the network. The only outbound traffic this extension can
 * cause is the model request the engine makes to the provider the user configured.
 */

import { randomBytes } from 'node:crypto';
import { CHAT_VIEW_ID } from './chat/view.js';
import { selectionPrompt } from './commands/selection.js';
import { Controller } from './controller.js';
import type { ExtensionContext, TextEditor, VscodeApi } from './host/api.js';
import { AdzeInlineCompletionProvider } from './inline/provider.js';

/** 18 bytes is 24 base64url characters, comfortably above the CSP nonce floor. */
const NONCE_BYTES = 18;

let active: Controller | undefined;

function requireEditor(vscode: VscodeApi): TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor !== undefined) return editor;
  void vscode.window.showErrorMessage('Adze: open a file first — there is no active editor.');
  return undefined;
}

function applyToSelection(vscode: VscodeApi, controller: Controller): void {
  const editor = requireEditor(vscode);
  if (editor === undefined) return;
  if (editor.selection.isEmpty) {
    void vscode.window.showErrorMessage(
      'Adze: select the code you want changed, then run Apply to Selection.',
    );
    return;
  }
  const prompt = selectionPrompt({
    fileName: editor.document.uri.fsPath,
    languageId: editor.document.languageId,
    startLine: editor.selection.start.line + 1,
    endLine: editor.selection.end.line + 1,
    selectedText: editor.document.getText(editor.selection),
  });
  void controller.submit(prompt);
}

export function activate(vscode: VscodeApi, context: ExtensionContext): void {
  const controller = new Controller({
    vscode,
    context,
    nonceBytes: () => new Uint8Array(randomBytes(NONCE_BYTES)),
  });
  active = controller;
  controller.activate();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, controller.viewProvider),

    // The view container's own `.focus` command is registered by VS Code from the
    // `views` contribution, so revealing the panel does not need a private channel.
    vscode.commands.registerCommand('adze.startChat', () => {
      void vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand('adze.applyToSelection', () => {
      applyToSelection(vscode, controller);
    }),
    vscode.commands.registerCommand('adze.cancelRun', () => {
      controller.cancel();
    }),
    vscode.commands.registerCommand('adze.acceptEdits', () => {
      controller.acceptEdits();
    }),
    vscode.commands.registerCommand('adze.revertEdits', () => {
      void controller.revertEdits();
    }),

    // Registered unconditionally and gated inside the provider, which returns nothing
    // while `adze.inlineCompletion.enabled` is false. Re-registering on every settings
    // change would be a second place for the feature to be half-on.
    vscode.languages.registerInlineCompletionItemProvider(
      [{ scheme: 'file' }],
      new AdzeInlineCompletionProvider({
        vscode,
        engine: controller,
        settings: () => controller.inlineSettings(),
      }),
    ),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      controller.refreshReview(editor);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      controller.onConfigurationChanged((section) => event.affectsConfiguration(section));
    }),
  );

  controller.refreshReview(vscode.window.activeTextEditor);
}

export async function deactivate(): Promise<void> {
  const controller = active;
  active = undefined;
  await controller?.dispose();
}
