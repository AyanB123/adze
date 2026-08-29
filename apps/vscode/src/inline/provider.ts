/**
 * Ghost text through `InlineCompletionItemProvider` — stable public API, no
 * proposed API, no workbench patching.
 *
 * The engine seam is deliberately tiny: {@link InlineCompletionEngine} is two
 * members, so this provider is testable against a fake with no model, no network,
 * and no editor. What it has to get right is not the model call but the guards
 * around it, because every one of them is either a correctness or a spend problem:
 *
 * - **Disabled means disabled.** No request at all when the setting is off.
 * - **Debounce, and re-check cancellation after waiting.** VS Code cancels
 *   aggressively as the user types; issuing the request anyway bills for a
 *   suggestion nobody will see.
 * - **Never while a turn is running.** The engine refuses a second turn in one
 *   session, and a completion is not worth interrupting a chat turn for.
 * - **A failure is silent here, and only here.** A notification per keystroke would
 *   be unusable, so the provider returns nothing and the failure is reported by
 *   whoever owns the engine.
 */

import type {
  CancellationToken,
  InlineCompletionContext,
  InlineCompletionItem,
  InlineCompletionItemProvider,
  Position,
  TextDocument,
  VscodeApi,
} from '../host/api.js';
import type { InlineCompletionSettings } from '../settings.js';
import { buildCompletionRequest, extractCompletion, shouldRequestCompletion } from './prompt.js';

export interface InlineCompletionEngine {
  /** True when a turn is already in flight. A completion is skipped rather than queued. */
  readonly busy: boolean;
  /** Run one turn and return the assistant text. Rejects on a provider failure. */
  complete(prompt: string): Promise<string>;
}

export interface InlineProviderOptions {
  readonly vscode: VscodeApi;
  readonly engine: InlineCompletionEngine;
  readonly settings: () => InlineCompletionSettings;
  /** Injectable so tests do not wait in real time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

export class AdzeInlineCompletionProvider implements InlineCompletionItemProvider {
  private readonly options: InlineProviderOptions;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: InlineProviderOptions) {
    this.options = options;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    _context: InlineCompletionContext,
    token: CancellationToken,
  ): Promise<readonly InlineCompletionItem[] | undefined> {
    const settings = this.options.settings();
    if (!settings.enabled) return undefined;
    if (this.options.engine.busy) return undefined;
    if (token.isCancellationRequested) return undefined;

    const input = {
      text: document.getText(),
      offset: document.offsetAt(position),
      languageId: document.languageId,
      fileName: document.uri.fsPath,
      maxPrefixBytes: settings.maxPrefixBytes,
    };
    if (!shouldRequestCompletion(input)) return undefined;

    await this.sleep(settings.debounceMs);
    // Re-checked after the wait: the user has almost certainly typed again, and the
    // request would be billed for a suggestion that is already stale.
    if (token.isCancellationRequested) return undefined;

    const request = buildCompletionRequest(input);
    const answer = await this.attempt(request.prompt);
    if (answer === undefined || token.isCancellationRequested) return undefined;

    const insertText = extractCompletion(answer, request.prefix);
    if (insertText === undefined) return undefined;
    return [new this.options.vscode.InlineCompletionItem(insertText)];
  }

  /** Swallows failures on purpose. See the file comment. */
  private async attempt(prompt: string): Promise<string | undefined> {
    try {
      return await this.options.engine.complete(prompt);
    } catch {
      return undefined;
    }
  }
}
