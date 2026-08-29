/**
 * The extension's orchestrator.
 *
 * Owns the engine host, the view model, the status bar, and edit review; every
 * VS Code call it makes goes through the injected {@link VscodeApi}, so the whole
 * thing is constructible in a test. What it deliberately does not own is rendering:
 * the webview renders the view model, the status bar renders formatted strings from
 * `status.ts`, and neither the engine nor this file emits display-intended output.
 *
 * Two behaviours here are load-bearing rather than convenient:
 *
 * - **A settings problem blocks the run.** Not a warning that scrolls past. See
 *   `settings.ts` for why the fail-closed direction is the only safe one.
 * - **Changing sandbox, approvals, model, or instructions tears down the session.**
 *   The session was created with the old values and the engine reports what is
 *   actually in force; leaving it alive would make the status bar and the approval
 *   prompts describe settings the user has already changed, which is the worst
 *   possible lie in a security display. The next submit builds a fresh session.
 */

import type {
  AdzeEvent,
  ApprovalRequest,
  ApprovalResponse,
  ProposedEdit,
  SandboxEnforcement,
} from '@adze/protocol';
import { NEVER_POLICY_NOTE, policyDecision, presentApproval, responseFor } from './approval.js';
import { ChatViewProvider } from './chat/view.js';
import { type ChatViewModel, INITIAL_VIEW_MODEL, reduce } from './chat/view-model.js';
import { EditReview } from './edits/review.js';
import { EngineHost } from './engine/host.js';
import { describeFailure, formatNotice } from './failure.js';
import type { ExtensionContext, StatusBarItem, TextEditor, VscodeApi } from './host/api.js';
import {
  blocksRun,
  CONFIG_SECTION,
  describeProblems,
  type ResolvedSettings,
  resolveSettings,
} from './settings.js';
import {
  blockedStatus,
  finishedStatus,
  idleStatus,
  runningStatus,
  type StatusPresentation,
} from './status.js';

/** Settings whose change invalidates a live session. See the file comment. */
const SESSION_SCOPED_KEYS = [
  `${CONFIG_SECTION}.model`,
  `${CONFIG_SECTION}.sandbox`,
  `${CONFIG_SECTION}.approvals`,
  `${CONFIG_SECTION}.instructions`,
];

export interface ControllerOptions {
  readonly vscode: VscodeApi;
  readonly context: ExtensionContext;
  readonly nonceBytes: () => Uint8Array;
  /** Defaults to `process.platform`. Injectable so both enforcement branches are testable. */
  readonly platform?: string;
}

export class Controller {
  private readonly vscode: VscodeApi;
  private readonly context: ExtensionContext;
  private readonly platform: string;
  private readonly statusItem: StatusBarItem;
  private readonly chatView: ChatViewProvider;
  private readonly review: EditReview;
  private readonly proposals = new Map<string, ProposedEdit>();

  private chatHost: EngineHost | undefined;
  private completionHost: EngineHost | undefined;
  private state: ChatViewModel = INITIAL_VIEW_MODEL;
  private warnedAboutContainment = false;
  private warnedAboutNeverPolicy = false;

  constructor(options: ControllerOptions) {
    this.vscode = options.vscode;
    this.context = options.context;
    this.platform = options.platform ?? process.platform;

    this.statusItem = this.vscode.window.createStatusBarItem(
      this.vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusItem.command = 'adze.startChat';

    this.chatView = new ChatViewProvider({
      vscode: this.vscode,
      context: this.context,
      nonceBytes: options.nonceBytes,
      host: {
        submit: (prompt) => {
          void this.submit(prompt);
        },
        cancel: () => this.cancel(),
        currentState: () => this.state,
      },
    });

    this.review = new EditReview({
      vscode: this.vscode,
      workspaceRoot: this.workspaceRoot() ?? process.cwd(),
      platform: this.platform,
      onReviewableChanged: (hasAny) => {
        void this.vscode.commands.executeCommand('setContext', 'adze.hasReviewableEdits', hasAny);
      },
    });
  }

  get viewProvider(): ChatViewProvider {
    return this.chatView;
  }

  /** Paint the initial status and publish the context keys. */
  activate(): void {
    this.refreshStatus();
    this.statusItem.show();
    void this.setRunningContext(false);
  }

  async dispose(): Promise<void> {
    this.statusItem.dispose();
    this.review.dispose();
    await this.chatHost?.dispose();
    await this.completionHost?.dispose();
  }

  // ------------------------------------------------------------- settings

  settings(): ResolvedSettings {
    return resolveSettings(this.vscode.workspace.getConfiguration(CONFIG_SECTION)).settings;
  }

  inlineSettings(): ResolvedSettings['inlineCompletion'] {
    return this.settings().inlineCompletion;
  }

  /** Rebuild on a settings change, tearing down a session whose settings moved. */
  onConfigurationChanged(affects: (section: string) => boolean): void {
    if (!affects(CONFIG_SECTION)) return;
    if (SESSION_SCOPED_KEYS.some((key) => affects(key))) {
      void this.resetSessions();
    }
    this.refreshStatus();
  }

  private async resetSessions(): Promise<void> {
    const chat = this.chatHost;
    const completion = this.completionHost;
    this.chatHost = undefined;
    this.completionHost = undefined;
    this.warnedAboutContainment = false;
    await chat?.dispose();
    await completion?.dispose();
  }

  // ------------------------------------------------------------ workspace

  private workspaceRoot(): string | undefined {
    return this.vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /**
   * The workspace root, or a reported failure.
   *
   * Named rather than silently no-oping: an agent with no workspace root has nothing
   * to read and nowhere to write, and "nothing happened" is the least useful thing
   * this extension could do.
   */
  private requireWorkspaceRoot(): string | undefined {
    const root = this.workspaceRoot();
    if (root !== undefined) return root;
    void this.vscode.window.showErrorMessage(
      'Adze needs an open folder: the engine is given a workspace root explicitly, and there is none. Open a folder and try again.',
    );
    return undefined;
  }

  // --------------------------------------------------------------- status

  private enforcement(): SandboxEnforcement {
    return this.chatHost?.enforcement ?? 'gate-only';
  }

  private modelLabelFor(): string | undefined {
    const live = this.chatHost?.model;
    if (live !== undefined) return `${live.provider}/${live.model}`;
    return this.settings().modelRef;
  }

  private refreshStatus(): void {
    const resolution = resolveSettings(this.vscode.workspace.getConfiguration(CONFIG_SECTION));
    if (blocksRun(resolution)) {
      this.applyStatus(blockedStatus(describeProblems(resolution.problems)));
      return;
    }
    if (this.state.status === 'running') {
      this.applyStatus(runningStatus(this.modelLabelFor(), this.state.steps));
      return;
    }
    const usage = this.state.usage;
    const stopReason = this.state.stopReason;
    if (usage !== undefined && stopReason !== undefined) {
      this.applyStatus(
        finishedStatus({
          model: this.modelLabelFor(),
          stopReason,
          steps: this.state.steps,
          usage,
          cost: this.chatHost?.costFor(usage),
          droppedEvents: this.state.droppedEvents,
        }),
      );
      return;
    }
    this.applyStatus(idleStatus(this.modelLabelFor()));
  }

  private applyStatus(presentation: StatusPresentation): void {
    this.statusItem.text = presentation.text;
    this.statusItem.tooltip = presentation.tooltip;
  }

  private setRunningContext(running: boolean): PromiseLike<unknown> {
    return this.vscode.commands.executeCommand('setContext', 'adze.running', running);
  }

  // ---------------------------------------------------------------- turns

  private host(root: string): EngineHost {
    this.chatHost ??= new EngineHost({
      workspaceRoot: root,
      platform: this.platform,
      onEvent: (event) => this.onEvent(event),
      requestApproval: (request) => this.requestApproval(request),
    });
    return this.chatHost;
  }

  async submit(prompt: string): Promise<void> {
    const root = this.requireWorkspaceRoot();
    if (root === undefined) return;

    const resolution = resolveSettings(this.vscode.workspace.getConfiguration(CONFIG_SECTION));
    if (blocksRun(resolution)) {
      // Blocking rather than best-effort. A ceiling nobody can read is not a ceiling.
      void this.vscode.window.showErrorMessage(
        `Adze will not start a turn while these settings are invalid:\n${describeProblems(resolution.problems)}`,
      );
      return;
    }

    const host = this.host(root);
    if (host.running) {
      void this.vscode.window.showInformationMessage(
        'Adze is already running a turn in this session. Cancel it first, or wait for it to finish.',
      );
      return;
    }

    this.chatView.reveal();
    void this.setRunningContext(true);
    try {
      await host.submit(prompt, resolution.settings);
    } catch (error) {
      this.reportFailure(error);
    } finally {
      void this.setRunningContext(false);
      this.refreshStatus();
    }
  }

  cancel(): void {
    const cancelled = this.chatHost?.cancel() ?? false;
    if (!cancelled) {
      // Not an error: a cancel racing a completion is normal.
      void this.vscode.window.showInformationMessage('Adze has no run in flight to cancel.');
    }
  }

  private reportFailure(error: unknown): void {
    const notice = describeFailure(error);
    // Never a stack trace. The configuration case names the environment variable,
    // which is the highest-value error message this extension has.
    void this.vscode.window.showErrorMessage(formatNotice(notice), { modal: false });
    this.chatView.post({ type: 'notice', level: 'error', text: formatNotice(notice) });
  }

  // --------------------------------------------------------------- events

  private onEvent(event: AdzeEvent): void {
    this.state = reduce(this.state, event);
    if (event.type === 'turn.started') {
      this.proposals.clear();
      this.review.reset();
    }
    if (event.type === 'edit.proposed') {
      this.proposals.set(event.proposal.editId, event.proposal);
    }
    if (event.type === 'edit.applied') {
      // `edit.applied` carries telemetry and locations but not the blocks, so the
      // proposal has to be paired by `editId` to make the change reviewable.
      const proposal = this.proposals.get(event.applied.editId);
      if (proposal !== undefined) this.review.record(proposal, event.applied.telemetry);
      this.review.refreshAll();
    }
    this.chatView.post({ type: 'state', state: this.state });
    this.refreshStatus();
  }

  // ------------------------------------------------------------ approvals

  private async requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    const { approvals } = this.settings();
    const automatic = policyDecision(approvals, request);
    if (automatic !== undefined) {
      this.noteNeverPolicy();
      return automatic;
    }

    const showNote = this.enforcement() === 'gate-only' && !this.warnedAboutContainment;
    const presentation = presentApproval(request, this.enforcement(), showNote);
    if (showNote) this.warnedAboutContainment = true;

    // Modal: this is a security decision, and a toast that can be missed is not a
    // question. Dismissal returns undefined, which `responseFor` treats as deny.
    const picked = await this.vscode.window.showWarningMessage(
      `${presentation.title}: ${presentation.summary}`,
      { modal: true, detail: presentation.detail },
      ...presentation.items,
    );
    return responseFor(request, picked);
  }

  /** Said once per session. Repeating it is how it stops being read. */
  private noteNeverPolicy(): void {
    if (this.warnedAboutNeverPolicy) return;
    this.warnedAboutNeverPolicy = true;
    void this.vscode.window.showWarningMessage(`Adze refused an action: ${NEVER_POLICY_NOTE}.`);
  }

  // ---------------------------------------------------------- edit review

  refreshReview(editor: TextEditor | undefined): void {
    if (editor !== undefined) this.review.refresh(editor);
  }

  acceptEdits(): void {
    const editor = this.vscode.window.activeTextEditor;
    if (editor === undefined) return;
    const cleared = this.review.accept(editor);
    if (cleared === 0) {
      void this.vscode.window.showInformationMessage('Adze has no edits awaiting review here.');
    }
  }

  async revertEdits(): Promise<void> {
    const editor = this.vscode.window.activeTextEditor;
    if (editor === undefined) return;
    const plan = await this.review.revert(editor);
    if (plan === undefined) {
      void this.vscode.window.showInformationMessage('Adze has no edits awaiting review here.');
      return;
    }
    if (!plan.ok) {
      // The refusal, verbatim. A revert that quietly does nothing is worse than one
      // that says why it will not.
      void this.vscode.window.showWarningMessage(plan.message);
    }
  }

  // --------------------------------------------------------- ghost text

  /**
   * True while any turn is in flight.
   *
   * Part of the {@link InlineCompletionEngine} seam, so the provider can skip rather
   * than queue: the engine refuses a second turn in one session, and a completion is
   * not worth interrupting a chat turn for.
   */
  get busy(): boolean {
    return (this.chatHost?.running ?? false) || (this.completionHost?.running ?? false);
  }

  async complete(prompt: string): Promise<string> {
    const root = this.workspaceRoot();
    if (root === undefined) return '';
    // A dedicated session, so completion prompts never enter the chat history the
    // user is having. Sharing one would make every suggestion part of the
    // conversation and quietly grow the cached prefix.
    this.completionHost ??= new EngineHost({
      workspaceRoot: root,
      platform: this.platform,
      onEvent: () => undefined,
      // Ghost text asks for nothing that needs approval, and a modal in the middle of
      // typing would be indefensible. Anything that does ask is denied.
      requestApproval: async (request) => ({
        requestId: request.requestId,
        decision: 'deny',
        note: 'ghost text does not prompt for approval',
      }),
    });
    if (this.completionHost.running) return '';
    return await this.completionHost.collectText(prompt, this.settings());
  }
}
