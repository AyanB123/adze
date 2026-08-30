/**
 * The retrieval backend adapter.
 *
 * `glob`, `grep`, and `symbols` were dead in the CLI: core declares the seam, ships no
 * implementation, and nothing joined `@adze/retrieval` to it. Driving the agent against a
 * real model made the cost obvious — it called all three, got "no retrieval backend
 * configured" from each, and then guessed file paths.
 *
 * These tests drive the adapter through fakes rather than a real workspace, because what
 * needs asserting is the translation, not ripgrep. `@adze/retrieval` has its own 250 tests
 * for the retrieval half.
 */

import type {
  DefinitionRequest,
  DefinitionResponse,
  RetrievalProvider,
  RetrievalRequest,
  RetrievalResponse,
  RipgrepListFilesOptions,
  SymbolExtractor,
  SymbolKind,
} from '@adze/retrieval';
import { describe, expect, it } from 'vitest';
import { RetrievalSearchBackend } from '../src/agent/search.js';

const ROOT = '/workspace';

function response(overrides: Partial<RetrievalResponse> = {}): RetrievalResponse {
  return {
    results: [],
    truncated: false,
    signalsUsed: [],
    diagnostics: [],
    ranking: {
      k: 60,
      weights: { lexical: 1, symbol: 1, semantic: 0 },
      recencyWeight: 0,
      proximityWeight: 0,
      recencyHalfLifeMs: 1,
    },
    durationMs: 1,
    ...overrides,
  };
}

function definitions(overrides: Partial<DefinitionResponse> = {}): DefinitionResponse {
  return {
    hits: [],
    truncated: false,
    extractors: {},
    filesParsed: 0,
    diagnostics: [],
    durationMs: 1,
    ...overrides,
  };
}

function hit(name: string, extractor: SymbolExtractor, kind: SymbolKind = 'function') {
  return {
    path: `src/${name}.ts`,
    extractor,
    snippet: `export function ${name}() {}`,
    symbol: {
      name,
      kind,
      range: { startLine: 7, startColumn: 1, endLine: 9, endColumn: 2, startIndex: 0, endIndex: 20 },
    },
  };
}

/** A provider that records what it was asked and returns what the test supplies. */
function fakeProvider(replies: {
  readonly search?: RetrievalResponse;
  readonly definitions?: DefinitionResponse;
}): RetrievalProvider & {
  readonly searchCalls: RetrievalRequest[];
  readonly definitionCalls: DefinitionRequest[];
} {
  const searchCalls: RetrievalRequest[] = [];
  const definitionCalls: DefinitionRequest[] = [];
  return {
    searchCalls,
    definitionCalls,
    async capabilities() {
      return {
        lexical: true,
        symbols: true,
        semantic: false,
        symbolExtractor: 'heuristic' as const,
        notes: [],
      };
    },
    async search(request) {
      searchCalls.push(request);
      return replies.search ?? response();
    },
    async definitions(request) {
      definitionCalls.push(request);
      return replies.definitions ?? definitions();
    },
  };
}

function backend(
  provider: RetrievalProvider,
  listFiles?: RetrievalBackendListFiles,
): RetrievalSearchBackend {
  return new RetrievalSearchBackend({
    root: ROOT,
    provider,
    ...(listFiles === undefined ? {} : { listFiles }),
  });
}

type RetrievalBackendListFiles = (
  options: RipgrepListFilesOptions,
) => Promise<{ files: readonly string[]; truncated: boolean }>;

describe('grep crosses the seam without being reinterpreted', () => {
  it('passes literal and regex through as the retrieval mode', async () => {
    const provider = fakeProvider({});
    const search = backend(provider);

    await search.search({ query: 'a.b', mode: 'regex', root: ROOT, maxResults: 10, timeoutMs: 500 });
    await search.search({ query: 'a.b', mode: 'literal', root: ROOT, maxResults: 10, timeoutMs: 500 });

    expect(provider.searchCalls.map((call) => call.mode)).toEqual(['regex', 'literal']);
  });

  it('omits case sensitivity when the caller did not state one', async () => {
    // The provider's own default is `smart`. Defaulting to `insensitive` here would
    // silently change what `grep` matches, which is a behaviour change disguised as glue.
    const provider = fakeProvider({});
    await backend(provider).search({
      query: 'Thing',
      mode: 'literal',
      root: ROOT,
      maxResults: 10,
      timeoutMs: 500,
    });

    expect(provider.searchCalls[0]).not.toHaveProperty('caseSensitivity');
  });

  it('maps a boolean caseSensitive onto the provider vocabulary', async () => {
    const provider = fakeProvider({});
    const search = backend(provider);
    await search.search({ query: 'x', mode: 'literal', root: ROOT, maxResults: 1, timeoutMs: 500, caseSensitive: true });
    await search.search({ query: 'x', mode: 'literal', root: ROOT, maxResults: 1, timeoutMs: 500, caseSensitive: false });

    expect(provider.searchCalls.map((call) => call.caseSensitivity)).toEqual([
      'sensitive',
      'insensitive',
    ]);
  });

  it('carries hits, truncation, and diagnostics across', async () => {
    const provider = fakeProvider({
      search: response({
        truncated: true,
        results: [
          {
            path: 'src/a.ts',
            line: 3,
            column: 5,
            snippet: 'const x = 1;',
            score: 0.9,
            signals: {
              ranks: { lexical: 1 },
              contributions: { lexical: 0.9 },
              fusion: 0.9,
              recency: 0,
              proximity: 0,
            },
          },
        ],
        diagnostics: [{ source: 'lexical', level: 'warning', message: 'timed out after 500ms' }],
      }),
    });

    const outcome = await backend(provider).search({
      query: 'x',
      mode: 'literal',
      root: ROOT,
      maxResults: 10,
      timeoutMs: 500,
    });

    expect(outcome.hits).toEqual([
      { path: 'src/a.ts', line: 3, column: 5, snippet: 'const x = 1;', score: 0.9 },
    ]);
    // Truncation and diagnostics must reach the model: a cut result set that looks
    // complete is the failure mode these fields exist to prevent.
    expect(outcome.truncated).toBe(true);
    expect(outcome.notes).toEqual(['lexical (warning): timed out after 500ms']);
  });

  it('keeps an info diagnostic readable without a severity label', async () => {
    const provider = fakeProvider({
      search: response({
        diagnostics: [{ source: 'semantic', level: 'info', message: 'not indexed' }],
      }),
    });

    const outcome = await backend(provider).search({
      query: 'x',
      mode: 'literal',
      root: ROOT,
      maxResults: 10,
      timeoutMs: 500,
    });

    expect(outcome.notes).toEqual(['semantic: not indexed']);
  });
});

describe('symbols reports the weakest evidence, never the best', () => {
  it('reports heuristic when the heuristic scanner produced any returned hit', async () => {
    // The rule from core's seam: a backend must never widen `heuristic` to `tree-sitter`.
    // A mixed result set is the case where a naive implementation overclaims.
    const provider = fakeProvider({
      definitions: definitions({
        hits: [hit('parsed', 'tree-sitter'), hit('guessed', 'heuristic')],
        extractors: { 'tree-sitter': 1, heuristic: 1 },
      }),
    });

    const outcome = await backend(provider).symbols({
      name: 'x',
      root: ROOT,
      maxResults: 10,
      timeoutMs: 500,
    });

    expect(outcome.extractor).toBe('heuristic');
  });

  it('reports tree-sitter only when every returned hit came from a real parse', async () => {
    const provider = fakeProvider({
      definitions: definitions({
        hits: [hit('a', 'tree-sitter'), hit('b', 'tree-sitter')],
        extractors: { 'tree-sitter': 2 },
      }),
    });

    const outcome = await backend(provider).symbols({
      name: 'x',
      root: ROOT,
      maxResults: 10,
      timeoutMs: 500,
    });

    expect(outcome.extractor).toBe('tree-sitter');
  });

  it('reports none when nothing ran at all', async () => {
    const provider = fakeProvider({ definitions: definitions({ extractors: {} }) });
    const outcome = await backend(provider).symbols({
      name: 'x',
      root: ROOT,
      maxResults: 10,
      timeoutMs: 500,
    });

    expect(outcome.extractor).toBe('none');
  });

  it('falls back to the extractor counts when there were no hits', async () => {
    // No hits is not no evidence: a parse that found nothing is a stronger statement than
    // a language nobody could read, and the model is told which happened.
    const provider = fakeProvider({
      definitions: definitions({ hits: [], extractors: { 'tree-sitter': 4 } }),
    });
    const outcome = await backend(provider).symbols({
      name: 'x',
      root: ROOT,
      maxResults: 10,
      timeoutMs: 500,
    });

    expect(outcome.extractor).toBe('tree-sitter');
  });

  it('flattens a definition hit onto the seam, scope included', async () => {
    const provider = fakeProvider({
      definitions: definitions({
        hits: [
          {
            path: 'src/user.ts',
            extractor: 'tree-sitter',
            snippet: '  save() {}',
            symbol: {
              name: 'save',
              kind: 'method',
              scope: 'UserService',
              range: {
                startLine: 42,
                startColumn: 3,
                endLine: 44,
                endColumn: 4,
                startIndex: 100,
                endIndex: 130,
              },
            },
          },
        ],
        extractors: { 'tree-sitter': 1 },
      }),
    });

    const outcome = await backend(provider).symbols({
      name: 'save',
      root: ROOT,
      maxResults: 10,
      timeoutMs: 500,
    });

    expect(outcome.hits).toEqual([
      {
        path: 'src/user.ts',
        name: 'save',
        kind: 'method',
        line: 42,
        snippet: '  save() {}',
        scope: 'UserService',
      },
    ]);
  });

  it('passes a kind filter through and omits it when absent', async () => {
    const provider = fakeProvider({});
    const search = backend(provider);
    await search.symbols({ name: 'x', root: ROOT, maxResults: 5, timeoutMs: 500, kinds: ['class'] });
    await search.symbols({ name: 'x', root: ROOT, maxResults: 5, timeoutMs: 500 });

    expect(provider.definitionCalls[0]?.kinds).toEqual(['class']);
    expect(provider.definitionCalls[1]).not.toHaveProperty('kinds');
  });
});

describe('glob', () => {
  it('asks ripgrep for the patterns as include filters, under the result ceiling', async () => {
    const seen: RipgrepListFilesOptions[] = [];
    const outcome = await backend(fakeProvider({}), async (options) => {
      seen.push(options);
      return { files: ['src/a.ts', 'src/b.ts'], truncated: true };
    }).glob({ patterns: ['src/**/*.ts'], root: ROOT, maxResults: 2, timeoutMs: 500 });

    expect(seen[0]).toMatchObject({
      cwd: ROOT,
      include: ['src/**/*.ts'],
      maxFiles: 2,
      timeoutMs: 500,
    });
    expect(outcome.paths).toEqual(['src/a.ts', 'src/b.ts']);
    expect(outcome.truncated).toBe(true);
  });

  it('lets a missing ripgrep throw rather than reporting no matches', async () => {
    // Core is explicit: "ripgrep is missing" must never look like "there were no matches".
    // Dispatch turns a throw into a failed call; an empty path list with a note attached
    // still renders as `matches: 0`, which a model reads as evidence of absence.
    const failing = backend(fakeProvider({}), async () => {
      throw new Error('ripgrep is not available');
    });

    await expect(
      failing.glob({ patterns: ['**/*'], root: ROOT, maxResults: 10, timeoutMs: 500 }),
    ).rejects.toThrow('ripgrep is not available');
  });
});
