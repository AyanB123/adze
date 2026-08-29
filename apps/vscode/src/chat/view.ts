/**
 * The chat sidebar: a webview view in the primary side bar.
 *
 * The provider owns the document and the message plumbing and nothing else. It
 * holds no engine reference — {@link ChatViewHost} is three members — so the panel
 * can be resolved and driven in a test with no engine, and the engine can be driven
 * with no panel.
 *
 * `retainContextWhenHidden` is deliberately **not** set. It keeps a hidden webview's
 * JavaScript context alive, which costs memory for the whole session; the state
 * lives in the extension host and is re-posted when the view becomes visible again,
 * which is cheaper and cannot drift.
 */

import type { ExtensionContext, VscodeApi, WebviewView, WebviewViewProvider } from '../host/api.js';
import { chatHtml, nonceFromBytes } from './html.js';
import { type HostMessage, parseWebviewMessage } from './messages.js';
import type { ChatViewModel } from './view-model.js';

export const CHAT_VIEW_ID = 'adze.chatView';

export interface ChatViewHost {
  submit(prompt: string): void;
  cancel(): void;
  /** The state to paint when a view is (re)created. */
  currentState(): ChatViewModel;
}

export interface ChatViewProviderOptions {
  readonly vscode: VscodeApi;
  readonly context: ExtensionContext;
  readonly host: ChatViewHost;
  /** Cryptographically random bytes for the CSP nonce. Injectable for tests. */
  readonly nonceBytes: () => Uint8Array;
}

export class ChatViewProvider implements WebviewViewProvider {
  private readonly options: ChatViewProviderOptions;
  private view: WebviewView | undefined;

  constructor(options: ChatViewProviderOptions) {
    this.options = options;
  }

  resolveWebviewView(webviewView: WebviewView): void {
    const { vscode, context, host } = this.options;
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');

    webviewView.webview.options = {
      enableScripts: true,
      // The only place local content may be loaded from. Combined with the policy in
      // `html.ts` — `default-src 'none'` and no `connect-src` — the panel cannot
      // reach the network at all.
      localResourceRoots: [mediaRoot],
    };
    webviewView.webview.html = chatHtml({
      nonce: nonceFromBytes(this.options.nonceBytes()),
      cspSource: webviewView.webview.cspSource,
      scriptUri: webviewView.webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.js'))
        .toString(),
      styleUri: webviewView.webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.css'))
        .toString(),
    });

    const subscription = webviewView.webview.onDidReceiveMessage((raw) => {
      // Parsed, never trusted. An unrecognised message is a no-op rather than an
      // argument to `turn.submit`.
      const message = parseWebviewMessage(raw);
      if (message === undefined) return;
      if (message.type === 'submit') host.submit(message.prompt);
      else host.cancel();
    });
    context.subscriptions.push(subscription);

    this.view = webviewView;
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    this.post({ type: 'state', state: host.currentState() });
  }

  /** Post to the panel if one exists. A closed panel is not an error. */
  post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  /** Bring the panel into view, without stealing focus from the editor. */
  reveal(): void {
    this.view?.show(true);
  }
}
