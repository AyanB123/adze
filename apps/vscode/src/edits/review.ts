/**
 * Inline review of edits the engine has already written.
 *
 * The achievable extension-API version of a streaming diff, and the honest framing
 * of what it is: the engine writes the file itself, and both `edit.proposed` and
 * `edit.applied` arrive after the write, so this is a **review-after-write** surface
 * rather than an accept-before-write one. Deep view-zone diffing belongs to the IDE
 * fork (ADR-0010); decorations plus a `WorkspaceEdit` are what a stable extension
 * API can do well.
 *
 * `Accept` clears the highlight. `Revert` computes the inverse edit and refuses
 * rather than guessing when the inverse is not derivable — see `locate.ts`. The
 * refusal message is shown to the user, because a revert button that quietly does
 * nothing is worse than one that says why it will not.
 */

import type { ApplyTelemetry, ProposedEdit } from '@adze/protocol';
import type {
  DecorationOptions,
  TextDocument,
  TextEditor,
  TextEditorDecorationType,
  VscodeApi,
} from '../host/api.js';
import { highlightSpans, planRevert, type RevertPlan } from './locate.js';
import { resolveEditPath, samePath } from './paths.js';

interface ReviewEntry {
  readonly absolutePath: string;
  readonly proposal: ProposedEdit;
  readonly telemetry: ApplyTelemetry;
}

export interface EditReviewOptions {
  readonly vscode: VscodeApi;
  readonly workspaceRoot: string;
  readonly platform: string;
  /** Drives the `adze.hasReviewableEdits` context key for menus and keybindings. */
  readonly onReviewableChanged: (hasAny: boolean) => void;
}

/** The telemetry, spelled out. A surface may choose not to show it; it may not invent it. */
function hoverFor(telemetry: ApplyTelemetry): string {
  const parts = [`Adze applied this edit (tier ${telemetry.tier}`];
  if (telemetry.strategy !== undefined) parts.push(`, strategy ${telemetry.strategy}`);
  parts.push(`, validator ${telemetry.validation.validator})`);
  return parts.join('');
}

export class EditReview {
  private readonly options: EditReviewOptions;
  private readonly decoration: TextEditorDecorationType;
  private entries: ReviewEntry[] = [];

  constructor(options: EditReviewOptions) {
    this.options = options;
    const { vscode } = options;
    this.decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    });
  }

  dispose(): void {
    this.decoration.dispose();
  }

  /** Record an applied edit as awaiting review. */
  record(proposal: ProposedEdit, telemetry: ApplyTelemetry): void {
    this.entries.push({
      absolutePath: resolveEditPath(this.options.workspaceRoot, proposal.path),
      proposal,
      telemetry,
    });
    this.options.onReviewableChanged(true);
  }

  /** Forget everything. Called when a new turn starts. */
  reset(): void {
    this.entries = [];
    this.options.onReviewableChanged(false);
    this.clearVisibleDecorations();
  }

  hasReviewableIn(document: TextDocument): boolean {
    return this.entriesFor(document.uri.fsPath).length > 0;
  }

  /** Repaint decorations for one editor. Advisory: an unlocatable block is skipped. */
  refresh(editor: TextEditor): void {
    const entries = this.entriesFor(editor.document.uri.fsPath);
    if (entries.length === 0) {
      editor.setDecorations(this.decoration, []);
      return;
    }
    const text = editor.document.getText();
    const decorations: DecorationOptions[] = [];
    for (const entry of entries) {
      const hoverMessage = hoverFor(entry.telemetry);
      for (const span of highlightSpans(text, entry.proposal).spans) {
        decorations.push({
          range: {
            start: editor.document.positionAt(span.start),
            end: editor.document.positionAt(span.end),
          },
          hoverMessage,
        });
      }
    }
    editor.setDecorations(this.decoration, decorations);
  }

  refreshAll(): void {
    for (const editor of this.options.vscode.window.visibleTextEditors) this.refresh(editor);
  }

  /** Mark the file reviewed and drop its highlight. */
  accept(editor: TextEditor): number {
    const removed = this.forget(editor.document.uri.fsPath);
    editor.setDecorations(this.decoration, []);
    return removed;
  }

  /**
   * Undo the recorded edits in one editor.
   *
   * Returns the plan so the caller can report a refusal verbatim. A refusal leaves
   * the entries in place: the user may fix the ambiguity and try again.
   */
  async revert(editor: TextEditor): Promise<RevertPlan | undefined> {
    const entries = this.entriesFor(editor.document.uri.fsPath);
    if (entries.length === 0) return undefined;

    const { vscode } = this.options;
    const text = editor.document.getText();
    const edit = new vscode.WorkspaceEdit();

    for (const entry of entries) {
      const plan = planRevert(text, entry.proposal, entry.telemetry);
      if (!plan.ok) return plan;
      for (const operation of plan.operations) {
        edit.replace(
          editor.document.uri,
          new vscode.Range(
            editor.document.positionAt(operation.span.start).line,
            editor.document.positionAt(operation.span.start).character,
            editor.document.positionAt(operation.span.end).line,
            editor.document.positionAt(operation.span.end).character,
          ),
          operation.original,
        );
      }
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      return {
        ok: false,
        reason: 'not-found',
        message: `VS Code declined to apply the revert to ${editor.document.uri.fsPath}.`,
      };
    }
    this.accept(editor);
    return { ok: true, operations: [] };
  }

  private entriesFor(fsPath: string): readonly ReviewEntry[] {
    return this.entries.filter((entry) =>
      samePath(entry.absolutePath, fsPath, this.options.platform),
    );
  }

  private forget(fsPath: string): number {
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (entry) => !samePath(entry.absolutePath, fsPath, this.options.platform),
    );
    this.options.onReviewableChanged(this.entries.length > 0);
    return before - this.entries.length;
  }

  private clearVisibleDecorations(): void {
    for (const editor of this.options.vscode.window.visibleTextEditors) {
      editor.setDecorations(this.decoration, []);
    }
  }
}
