import { describe, expect, it, vi } from 'vitest';
import type { CancellationToken, InlineCompletionContext, Position } from '../src/host/api.js';
import {
  buildCompletionRequest,
  extractCompletion,
  shouldRequestCompletion,
} from '../src/inline/prompt.js';
import { AdzeInlineCompletionProvider } from '../src/inline/provider.js';
import type { InlineCompletionSettings } from '../src/settings.js';
import { createFakeHost, fakeDocument } from './fake-vscode.js';

const INPUT = {
  text: 'function add(a: number, b: number) {\n  return \n}\n',
  offset: 46,
  languageId: 'typescript',
  fileName: '/w/add.ts',
  maxPrefixBytes: 4096,
};

describe('shouldRequestCompletion', () => {
  it('refuses at the very top of an empty file', () => {
    // A completion there is a guess at what the user is about to write, and it would
    // still cost a full turn.
    expect(shouldRequestCompletion({ ...INPUT, text: '   \n', offset: 0 })).toBe(false);
    expect(shouldRequestCompletion({ ...INPUT, text: '\n\n\n', offset: 3 })).toBe(false);
  });

  it('accepts once there is code before the cursor', () => {
    expect(shouldRequestCompletion(INPUT)).toBe(true);
  });
});

describe('buildCompletionRequest', () => {
  it('splits the document at the cursor', () => {
    const request = buildCompletionRequest(INPUT);
    expect(request.prefix.endsWith('return ')).toBe(true);
    expect(request.suffix.startsWith('\n}')).toBe(true);
  });

  it('describes the suffix inside the prompt, because the protocol has no field for it', () => {
    const request = buildCompletionRequest(INPUT);
    expect(request.prompt).toContain('<before-cursor>');
    expect(request.prompt).toContain('<after-cursor>');
    expect(request.prompt).toContain('typescript');
    expect(request.prompt).toContain('/w/add.ts');
  });

  it('bounds the prefix by the configured budget', () => {
    const text = 'x'.repeat(10_000);
    const request = buildCompletionRequest({
      ...INPUT,
      text,
      offset: text.length,
      maxPrefixBytes: 512,
    });
    expect(request.prefix).toHaveLength(512);
  });

  it('bounds the suffix more tightly than the prefix', () => {
    const text = 'a'.repeat(4_000);
    const request = buildCompletionRequest({
      ...INPUT,
      text,
      offset: 2_000,
      maxPrefixBytes: 400,
    });
    expect(request.prefix).toHaveLength(400);
    expect(request.suffix).toHaveLength(100);
  });
});

describe('extractCompletion', () => {
  it('returns plain text unchanged apart from trailing whitespace', () => {
    expect(extractCompletion('a + b;', 'return ')).toBe('a + b;');
  });

  it('unwraps a single code fence', () => {
    expect(extractCompletion('```ts\na + b;\n```', 'return ')).toBe('a + b;');
  });

  it('preserves leading indentation, which is part of the completion', () => {
    expect(extractCompletion('    return a;', 'if (x) {\n')).toBe('    return a;');
  });

  it('refuses an empty or whitespace-only answer', () => {
    expect(extractCompletion('', 'x')).toBeUndefined();
    expect(extractCompletion('   \n\n', 'x')).toBeUndefined();
    expect(extractCompletion('```\n\n```', 'x')).toBeUndefined();
  });

  it('refuses an answer that repeats the line already before the cursor', () => {
    // Inserting a duplicate of the current line is the most common way ghost text
    // goes wrong, and the most annoying.
    expect(extractCompletion('return a + b;', 'function f() {\n  return ')).toBeUndefined();
  });
});

function settings(overrides: Partial<InlineCompletionSettings> = {}): InlineCompletionSettings {
  return { enabled: true, debounceMs: 1, maxPrefixBytes: 4096, ...overrides };
}

const CONTEXT: InlineCompletionContext = { triggerKind: 0 };

function token(cancelled = false): CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
}

const POSITION: Position = { line: 1, character: 9 };

describe('AdzeInlineCompletionProvider', () => {
  const document = fakeDocument('/w/add.ts', INPUT.text);

  it('issues no request at all while the feature is disabled', async () => {
    const host = createFakeHost();
    const complete = vi.fn(async () => 'a + b;');
    const provider = new AdzeInlineCompletionProvider({
      vscode: host.vscode,
      engine: { busy: false, complete },
      settings: () => settings({ enabled: false }),
      sleep: async () => undefined,
    });

    expect(
      await provider.provideInlineCompletionItems(document, POSITION, CONTEXT, token()),
    ).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it('skips rather than queues while a turn is in flight', async () => {
    const host = createFakeHost();
    const complete = vi.fn(async () => 'a + b;');
    const provider = new AdzeInlineCompletionProvider({
      vscode: host.vscode,
      engine: { busy: true, complete },
      settings: () => settings(),
      sleep: async () => undefined,
    });

    expect(
      await provider.provideInlineCompletionItems(document, POSITION, CONTEXT, token()),
    ).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not bill for a suggestion cancelled during the debounce', async () => {
    const host = createFakeHost();
    const complete = vi.fn(async () => 'a + b;');
    const cancellable = {
      isCancellationRequested: false,
      onCancellationRequested: token().onCancellationRequested,
    };
    const provider = new AdzeInlineCompletionProvider({
      vscode: host.vscode,
      engine: { busy: false, complete },
      settings: () => settings({ debounceMs: 50 }),
      sleep: async () => {
        cancellable.isCancellationRequested = true;
      },
    });

    expect(
      await provider.provideInlineCompletionItems(document, POSITION, CONTEXT, cancellable),
    ).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it('returns one item on the happy path', async () => {
    const host = createFakeHost();
    const provider = new AdzeInlineCompletionProvider({
      vscode: host.vscode,
      engine: { busy: false, complete: async () => '```ts\na + b;\n```' },
      settings: () => settings(),
      sleep: async () => undefined,
    });

    const items = await provider.provideInlineCompletionItems(document, POSITION, CONTEXT, token());
    expect(items).toHaveLength(1);
    expect(items?.[0]?.insertText).toBe('a + b;');
  });

  it('stays silent when the engine fails, rather than notifying per keystroke', async () => {
    const host = createFakeHost();
    const provider = new AdzeInlineCompletionProvider({
      vscode: host.vscode,
      engine: {
        busy: false,
        complete: async () => {
          throw new Error('no API key configured');
        },
      },
      settings: () => settings(),
      sleep: async () => undefined,
    });

    expect(
      await provider.provideInlineCompletionItems(document, POSITION, CONTEXT, token()),
    ).toBeUndefined();
    expect(host.messages).toEqual([]);
  });
});
