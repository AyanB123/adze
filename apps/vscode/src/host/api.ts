/**
 * The slice of the VS Code API this extension is allowed to touch.
 *
 * Nothing under `src/` imports the `vscode` module. The namespace is `require`d
 * once in `runtime/entry.cjs` and passed in as {@link VscodeApi}, which buys three
 * things:
 *
 * 1. **Testability.** Every module below can be exercised against a hand-written
 *    fake, so the logic that decides what to render, what to revert, and whether to
 *    grant an approval is unit-tested with no VS Code process involved. Downloading
 *    a VS Code test host to assert that a pure function maps an event correctly is
 *    the wrong trade.
 * 2. **An auditable API budget.** ADR-0010 keeps this surface on stable public API;
 *    deep view-zone diffing and workbench overlays are IDE-fork territory. A
 *    hand-declared slice makes an accidental dependency on a proposed API a visible
 *    edit to this file rather than an invisible import.
 * 3. **No install step.** `@types/vscode` is not installed in this workspace, and
 *    this file is the honest alternative to pretending it is.
 *
 * Every member below mirrors the real signature it stands in for. TypeScript cannot
 * check that, because the runtime object crosses an untyped boundary in the entry
 * shim, so **a wrong declaration here is a runtime bug**. Treat edits accordingly:
 * change one member at a time and check it against the published API.
 */

// --------------------------------------------------------------- primitives

export interface Disposable {
  dispose(): void;
}

export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface Selection extends Range {
  readonly isEmpty: boolean;
}

export interface Uri {
  readonly fsPath: string;
  readonly scheme: string;
  toString(): string;
}

export interface ThemeColor {
  readonly id: string;
}

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): Disposable;
}

// ------------------------------------------------------------------ editors

export interface TextDocument {
  readonly uri: Uri;
  readonly languageId: string;
  readonly lineCount: number;
  readonly isUntitled: boolean;
  getText(range?: Range): string;
  positionAt(offset: number): Position;
  offsetAt(position: Position): number;
}

export interface DecorationRenderOptions {
  readonly isWholeLine?: boolean;
  readonly backgroundColor?: string | ThemeColor;
  readonly borderWidth?: string;
  readonly borderStyle?: string;
  readonly borderColor?: string | ThemeColor;
  readonly overviewRulerColor?: string | ThemeColor;
}

export interface TextEditorDecorationType extends Disposable {
  readonly key: string;
}

export interface DecorationOptions {
  readonly range: Range;
  readonly hoverMessage?: string;
}

export interface TextEditor {
  readonly document: TextDocument;
  readonly selection: Selection;
  setDecorations(
    decorationType: TextEditorDecorationType,
    rangesOrOptions: readonly Range[] | readonly DecorationOptions[],
  ): void;
  revealRange(range: Range): void;
}

export interface WorkspaceEdit {
  replace(uri: Uri, range: Range, newText: string): void;
  insert(uri: Uri, position: Position, newText: string): void;
  delete(uri: Uri, range: Range): void;
}

// ----------------------------------------------------------------- webviews

export interface WebviewOptions {
  readonly enableScripts?: boolean;
  readonly localResourceRoots?: readonly Uri[];
}

export interface Webview {
  html: string;
  options: WebviewOptions;
  /**
   * The origin to name in a `Content-Security-Policy` so the webview may load its
   * own local resources and nothing else.
   */
  readonly cspSource: string;
  asWebviewUri(localResource: Uri): Uri;
  postMessage(message: unknown): PromiseLike<boolean>;
  onDidReceiveMessage(listener: (message: unknown) => void): Disposable;
}

export interface WebviewView {
  readonly webview: Webview;
  readonly visible: boolean;
  show(preserveFocus?: boolean): void;
  onDidDispose(listener: () => void): Disposable;
}

export interface WebviewViewProvider {
  resolveWebviewView(webviewView: WebviewView): void | PromiseLike<void>;
}

// ------------------------------------------------------------------- prompts

export interface QuickPickItem {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
}

export interface QuickPickOptions {
  readonly title?: string;
  readonly placeHolder?: string;
  readonly ignoreFocusOut?: boolean;
}

export interface MessageOptions {
  readonly modal?: boolean;
  readonly detail?: string;
}

export interface StatusBarItem extends Disposable {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  show(): void;
  hide(): void;
}

// -------------------------------------------------------- inline completions

export interface InlineCompletionItem {
  readonly insertText: string;
  readonly range?: Range;
}

export interface InlineCompletionContext {
  readonly triggerKind: number;
}

export interface InlineCompletionItemProvider {
  provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    context: InlineCompletionContext,
    token: CancellationToken,
  ):
    | readonly InlineCompletionItem[]
    | undefined
    | PromiseLike<readonly InlineCompletionItem[] | undefined>;
}

export interface DocumentFilter {
  readonly scheme?: string;
  readonly language?: string;
}

// ---------------------------------------------------------------- namespaces

export interface WorkspaceFolder {
  readonly uri: Uri;
  readonly name: string;
}

export interface WorkspaceConfiguration {
  get<T>(section: string): T | undefined;
}

export interface ConfigurationChangeEvent {
  affectsConfiguration(section: string): boolean;
}

export interface ExtensionContext {
  readonly subscriptions: Disposable[];
  readonly extensionUri: Uri;
}

export interface WindowApi {
  readonly activeTextEditor: TextEditor | undefined;
  readonly visibleTextEditors: readonly TextEditor[];
  onDidChangeActiveTextEditor(listener: (editor: TextEditor | undefined) => void): Disposable;
  showErrorMessage(
    message: string,
    options?: MessageOptions,
    ...items: readonly string[]
  ): PromiseLike<string | undefined>;
  showWarningMessage(
    message: string,
    options?: MessageOptions,
    ...items: readonly string[]
  ): PromiseLike<string | undefined>;
  showInformationMessage(
    message: string,
    options?: MessageOptions,
    ...items: readonly string[]
  ): PromiseLike<string | undefined>;
  showQuickPick<T extends QuickPickItem>(
    items: readonly T[],
    options?: QuickPickOptions,
  ): PromiseLike<T | undefined>;
  createStatusBarItem(alignment: number, priority?: number): StatusBarItem;
  createTextEditorDecorationType(options: DecorationRenderOptions): TextEditorDecorationType;
  registerWebviewViewProvider(
    viewId: string,
    provider: WebviewViewProvider,
    options?: { readonly webviewOptions?: { readonly retainContextWhenHidden?: boolean } },
  ): Disposable;
  showTextDocument(
    document: TextDocument,
    options?: { readonly preview?: boolean; readonly preserveFocus?: boolean },
  ): PromiseLike<TextEditor>;
}

export interface WorkspaceApi {
  readonly workspaceFolders: readonly WorkspaceFolder[] | undefined;
  readonly textDocuments: readonly TextDocument[];
  getConfiguration(section?: string): WorkspaceConfiguration;
  openTextDocument(uri: Uri): PromiseLike<TextDocument>;
  applyEdit(edit: WorkspaceEdit): PromiseLike<boolean>;
  onDidChangeConfiguration(listener: (event: ConfigurationChangeEvent) => void): Disposable;
}

export interface CommandsApi {
  registerCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable;
  executeCommand<T>(command: string, ...rest: readonly unknown[]): PromiseLike<T>;
}

export interface LanguagesApi {
  registerInlineCompletionItemProvider(
    selector: readonly DocumentFilter[],
    provider: InlineCompletionItemProvider,
  ): Disposable;
}

/** The `vscode` module, as far as this extension is concerned. */
export interface VscodeApi {
  readonly window: WindowApi;
  readonly workspace: WorkspaceApi;
  readonly commands: CommandsApi;
  readonly languages: LanguagesApi;
  readonly Uri: {
    file(path: string): Uri;
    joinPath(base: Uri, ...pathSegments: readonly string[]): Uri;
  };
  readonly Range: new (
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
  ) => Range;
  readonly Position: new (line: number, character: number) => Position;
  readonly WorkspaceEdit: new () => WorkspaceEdit;
  readonly ThemeColor: new (id: string) => ThemeColor;
  readonly InlineCompletionItem: new (insertText: string, range?: Range) => InlineCompletionItem;
  readonly StatusBarAlignment: { readonly Left: number; readonly Right: number };
}
