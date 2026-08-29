/**
 * A hand-written VS Code host.
 *
 * The reason this file exists instead of `@vscode/test-electron`: everything worth
 * testing in this extension — event mapping, revert planning, approval decisions,
 * settings resolution — is decided before any real editor is involved, and none of
 * it needs a downloaded VS Code build to check. What genuinely requires a live host
 * (does the decoration paint, does the webview script load under the CSP) is listed
 * as manual verification in the package README rather than faked here, because a
 * fake that "passes" for those would be worse than admitting they are manual.
 *
 * Only the members `src/host/api.ts` declares are implemented.
 */

import type {
  ConfigurationChangeEvent,
  DecorationOptions,
  Disposable,
  ExtensionContext,
  MessageOptions,
  Position,
  QuickPickItem,
  Range,
  Selection,
  StatusBarItem,
  TextDocument,
  TextEditor,
  TextEditorDecorationType,
  Uri,
  VscodeApi,
  WorkspaceConfiguration,
  WorkspaceEdit,
  WorkspaceFolder,
} from '../src/host/api.js';

export function fakeUri(fsPath: string): Uri {
  return { fsPath, scheme: 'file', toString: () => `file://${fsPath.replaceAll('\\', '/')}` };
}

/** A document over a real string, so `positionAt`/`offsetAt` are genuinely exercised. */
export function fakeDocument(
  fsPath: string,
  text: string,
  languageId = 'typescript',
): TextDocument {
  const lines = text.split('\n');
  return {
    uri: fakeUri(fsPath),
    languageId,
    lineCount: lines.length,
    isUntitled: false,
    getText: (range?: Range) => {
      if (range === undefined) return text;
      const start = offsetOf(lines, range.start);
      const end = offsetOf(lines, range.end);
      return text.slice(start, end);
    },
    positionAt: (offset: number) => positionOf(lines, offset),
    offsetAt: (position: Position) => offsetOf(lines, position),
  };
}

function positionOf(lines: readonly string[], offset: number): Position {
  let remaining = offset;
  for (let line = 0; line < lines.length; line += 1) {
    const length = (lines[line] ?? '').length;
    if (remaining <= length) return { line, character: remaining };
    remaining -= length + 1;
  }
  const last = lines.length - 1;
  return { line: last, character: (lines[last] ?? '').length };
}

function offsetOf(lines: readonly string[], position: Position): number {
  let offset = 0;
  for (let line = 0; line < position.line && line < lines.length; line += 1) {
    offset += (lines[line] ?? '').length + 1;
  }
  return offset + position.character;
}

export interface RecordedEdit {
  readonly uri: Uri;
  readonly range: Range;
  readonly text: string;
}

export interface FakeEditor extends TextEditor {
  readonly decorations: DecorationOptions[][];
}

export function fakeEditor(document: TextDocument, selection?: Selection): FakeEditor {
  const decorations: DecorationOptions[][] = [];
  return {
    document,
    selection: selection ?? {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
      isEmpty: true,
    },
    setDecorations: (_type: TextEditorDecorationType, ranges) => {
      decorations.push([...ranges] as DecorationOptions[]);
    },
    revealRange: () => undefined,
    decorations,
  };
}

export function fakeConfiguration(
  values: Readonly<Record<string, unknown>>,
): WorkspaceConfiguration {
  return {
    get: <T>(section: string): T | undefined => values[section] as T | undefined,
  };
}

export interface ShownMessage {
  readonly level: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly options: MessageOptions | undefined;
  readonly items: readonly string[];
}

export interface FakeHost {
  vscode: VscodeApi;
  readonly context: ExtensionContext;
  readonly messages: ShownMessage[];
  readonly appliedEdits: RecordedEdit[];
  readonly contextKeys: Map<string, unknown>;
  readonly statusItems: StatusBarItem[];
  /** Answer the next modal with this label. `undefined` means dismissed. */
  answer: string | undefined;
  editors: FakeEditor[];
  configuration: Readonly<Record<string, unknown>>;
  folders: readonly WorkspaceFolder[] | undefined;
  applyEditResult: boolean;
}

const noopDisposable: Disposable = { dispose: () => undefined };

function fakeWorkspaceEdit(sink: RecordedEdit[]): WorkspaceEdit {
  return {
    replace: (uri, range, newText) => {
      sink.push({ uri, range, text: newText });
    },
    insert: (uri, position, newText) => {
      sink.push({ uri, range: { start: position, end: position }, text: newText });
    },
    delete: (uri, range) => {
      sink.push({ uri, range, text: '' });
    },
  };
}

export function createFakeHost(): FakeHost {
  const messages: ShownMessage[] = [];
  const appliedEdits: RecordedEdit[] = [];
  const contextKeys = new Map<string, unknown>();
  const statusItems: StatusBarItem[] = [];

  const host: FakeHost = {
    messages,
    appliedEdits,
    contextKeys,
    statusItems,
    answer: undefined,
    editors: [],
    configuration: {},
    folders: [{ uri: fakeUri('/workspace'), name: 'workspace' }],
    applyEditResult: true,
    // Assigned below; declared here so the object is complete.
    vscode: undefined as unknown as VscodeApi,
    context: {
      subscriptions: [],
      extensionUri: fakeUri('/ext'),
    },
  };

  const record = (level: ShownMessage['level']) => {
    return (message: string, options?: MessageOptions, ...items: readonly string[]) => {
      messages.push({ level, message, options, items });
      return Promise.resolve(host.answer);
    };
  };

  host.vscode = {
    window: {
      get activeTextEditor() {
        return host.editors[0];
      },
      get visibleTextEditors() {
        return host.editors;
      },
      onDidChangeActiveTextEditor: () => noopDisposable,
      showErrorMessage: record('error'),
      showWarningMessage: record('warning'),
      showInformationMessage: record('info'),
      showQuickPick: <T extends QuickPickItem>(items: readonly T[]) =>
        Promise.resolve(items.find((item) => item.label === host.answer)),
      createStatusBarItem: () => {
        const item: StatusBarItem = {
          text: '',
          tooltip: undefined,
          command: undefined,
          show: () => undefined,
          hide: () => undefined,
          dispose: () => undefined,
        };
        statusItems.push(item);
        return item;
      },
      createTextEditorDecorationType: () => ({ key: 'fake', dispose: () => undefined }),
      registerWebviewViewProvider: () => noopDisposable,
      showTextDocument: () => Promise.reject(new Error('not used in tests')),
    },
    workspace: {
      get workspaceFolders() {
        return host.folders;
      },
      get textDocuments() {
        return host.editors.map((editor) => editor.document);
      },
      getConfiguration: () => fakeConfiguration(host.configuration),
      openTextDocument: () => Promise.reject(new Error('not used in tests')),
      applyEdit: () => Promise.resolve(host.applyEditResult),
      onDidChangeConfiguration: (_listener: (event: ConfigurationChangeEvent) => void) =>
        noopDisposable,
    },
    commands: {
      registerCommand: () => noopDisposable,
      executeCommand: <T>(command: string, ...rest: readonly unknown[]) => {
        if (command === 'setContext' && typeof rest[0] === 'string') {
          contextKeys.set(rest[0], rest[1]);
        }
        return Promise.resolve(undefined as T);
      },
    },
    languages: {
      registerInlineCompletionItemProvider: () => noopDisposable,
    },
    Uri: {
      file: fakeUri,
      joinPath: (base: Uri, ...segments: readonly string[]) =>
        fakeUri([base.fsPath, ...segments].join('/')),
    },
    Range: class {
      readonly start: Position;
      readonly end: Position;
      constructor(
        startLine: number,
        startCharacter: number,
        endLine: number,
        endCharacter: number,
      ) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      }
    },
    Position: class {
      constructor(
        readonly line: number,
        readonly character: number,
      ) {}
    },
    WorkspaceEdit: class {
      private readonly edit = fakeWorkspaceEdit(appliedEdits);
      replace(uri: Uri, range: Range, newText: string): void {
        this.edit.replace(uri, range, newText);
      }
      insert(uri: Uri, position: Position, newText: string): void {
        this.edit.insert(uri, position, newText);
      }
      delete(uri: Uri, range: Range): void {
        this.edit.delete(uri, range);
      }
    },
    ThemeColor: class {
      constructor(readonly id: string) {}
    },
    InlineCompletionItem: class {
      readonly insertText: string;
      // Assigned only when present: `exactOptionalPropertyTypes` distinguishes an
      // absent `range` from one set to undefined.
      readonly range?: Range;
      constructor(insertText: string, range?: Range) {
        this.insertText = insertText;
        if (range !== undefined) this.range = range;
      }
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
  };

  return host;
}
