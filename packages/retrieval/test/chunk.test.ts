/**
 * Structure-aware chunking tests.
 *
 * The property that matters: **a chunk is a function, not the tail of one plus
 * the head of the next.** A fixed token window splits a definition from its
 * signature about half the time, and a retrieved half-function is worse than
 * useless because it reads as complete. So the assertions here are mostly about
 * boundaries, and about the honesty of the two fields that let a consumer tell a
 * whole symbol from a fragment: `kind` and `boundary`.
 *
 * The second property is the budget. A 3000-line generated file has to fit
 * somewhere, and when the budget forces a cut the chunk must say so rather than
 * quietly presenting a fragment as a symbol.
 */

import { describe, expect, it } from 'vitest';
import { chunkFile } from '../src/chunk.js';
import { languageForPath } from '../src/languages.js';
import { extractSymbolsHeuristic } from '../src/symbols.js';
import { estimateTokens } from '../src/text.js';
import type { Chunk, SymbolInfo } from '../src/types.js';

function extract(path: string, source: string) {
  const definition = languageForPath(path);
  if (definition === undefined) throw new Error(`no language for ${path}`);
  return extractSymbolsHeuristic(path, source, definition);
}

/** Lines `[start, end]` of `source`, 1-based inclusive — what a chunk should hold. */
function linesOf(source: string, start: number, end: number): string {
  return source
    .split('\n')
    .slice(start - 1, end)
    .join('\n');
}

function symbolChunks(chunks: readonly Chunk[]): Chunk[] {
  return chunks.filter((c) => c.kind === 'symbol');
}

const TWO_FUNCTIONS = [
  "import { work } from './work.js';",
  '',
  'export function first(a: number): number {',
  '  return work(a) + 1;',
  '}',
  '',
  'export function second(b: number): number {',
  '  return work(b) + 2;',
  '}',
  '',
].join('\n');

describe('chunkFile — symbol boundaries', () => {
  const extraction = extract('src/a.ts', TWO_FUNCTIONS);
  const chunks = chunkFile('src/a.ts', TWO_FUNCTIONS, extraction);

  it('gives each function its own chunk, cut on symbol boundaries', () => {
    const symbols = symbolChunks(chunks);
    expect(symbols.map((c) => c.symbol?.name)).toEqual(['first', 'second']);
    for (const chunk of symbols) {
      expect(chunk.boundary).toBe('symbol');
      expect(chunk.part).toBeUndefined();
    }
  });

  it('never puts the end of one function and the start of the next in one chunk', () => {
    for (const chunk of chunks) {
      const holdsFirst = chunk.text.includes('function first');
      const holdsSecond = chunk.text.includes('function second');
      expect(holdsFirst && holdsSecond).toBe(false);
    }
  });

  it('reproduces the source lines exactly', () => {
    const first = symbolChunks(chunks)[0];
    expect(first?.startLine).toBe(3);
    expect(first?.endLine).toBe(5);
    expect(first?.text).toBe(linesOf(TWO_FUNCTIONS, 3, 5));
  });

  it('emits the code between symbols as a span, not as a symbol', () => {
    const spans = chunks.filter((c) => c.kind === 'span');
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.some((c) => c.text.includes('import'))).toBe(true);
    for (const span of spans) {
      expect(span.boundary).toBe('line');
      expect(span.symbol).toBeUndefined();
    }
  });

  it('covers every line of the file exactly once', () => {
    const covered = new Set<number>();
    for (const chunk of chunks) {
      for (let line = chunk.startLine; line <= chunk.endLine; line++) {
        expect(covered.has(line)).toBe(false);
        covered.add(line);
      }
    }
    // Blank-only regions are dropped rather than chunked, so check the content.
    for (const [index, text] of TWO_FUNCTIONS.split('\n').entries()) {
      if (text.trim().length > 0) expect(covered.has(index + 1)).toBe(true);
    }
  });

  it('carries the extractor level its boundaries came from', () => {
    for (const chunk of chunks) expect(chunk.extractor).toBe('heuristic');
  });

  it('reports the extractor as given, even when it is a real parse', () => {
    const chunks2 = chunkFile('src/a.ts', TWO_FUNCTIONS, {
      symbols: extraction.symbols,
      extractor: 'tree-sitter',
    });
    for (const chunk of chunks2) expect(chunk.extractor).toBe('tree-sitter');
  });

  it('omits spans when asked to', () => {
    const only = chunkFile('src/a.ts', TWO_FUNCTIONS, extraction, { includeSpans: false });
    expect(only.every((c) => c.kind === 'symbol')).toBe(true);
    expect(only).toHaveLength(2);
  });
});

describe('chunkFile — the token budget', () => {
  it('keeps a symbol whole while it fits', () => {
    const extraction = extract('a.ts', TWO_FUNCTIONS);
    const chunks = chunkFile('a.ts', TWO_FUNCTIONS, extraction, { maxTokens: 512 });
    for (const chunk of symbolChunks(chunks)) {
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(512);
      expect(chunk.kind).toBe('symbol');
    }
  });

  it('descends into a class rather than cutting it, when it is over budget', () => {
    const body = Array.from({ length: 12 }, (_, i) => `    step${i}();`).join('\n');
    const source = [
      'export class Big {',
      `  alpha(): void {`,
      body,
      '  }',
      '',
      '  beta(): void {',
      body,
      '  }',
      '}',
      '',
    ].join('\n');
    const extraction = extract('a.ts', source);
    // Small enough that the class does not fit but each method does.
    const chunks = chunkFile('a.ts', source, extraction, { maxTokens: 80 });

    const methods = symbolChunks(chunks).map((c) => c.symbol?.name);
    expect(methods).toContain('alpha');
    expect(methods).toContain('beta');
    // Each method arrived whole, on a symbol boundary.
    for (const chunk of symbolChunks(chunks)) expect(chunk.boundary).toBe('symbol');
  });

  it('marks a symbol it had to cut as a part, on a line boundary', () => {
    const body = Array.from({ length: 60 }, (_, i) => `  doStepNumber${i}(withArgument${i});`).join(
      '\n',
    );
    const source = ['export function huge(): void {', body, '}', ''].join('\n');
    const extraction = extract('a.ts', source);
    const chunks = chunkFile('a.ts', source, extraction, { maxTokens: 60 });

    const parts = chunks.filter((c) => c.kind === 'symbol-part');
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      // This is the honesty bit: a fragment is never labelled a whole symbol.
      expect(part.boundary).toBe('line');
      expect(part.symbol?.name).toBe('huge');
      expect(part.part?.of).toBe(parts.length);
    }
    expect(parts.map((p) => p.part?.index)).toEqual(
      Array.from({ length: parts.length }, (_, i) => i + 1),
    );
  });

  it('keeps parts contiguous and in order, losing no lines', () => {
    const body = Array.from({ length: 40 }, (_, i) => `  line${i}();`).join('\n');
    const source = ['export function huge(): void {', body, '}', ''].join('\n');
    const extraction = extract('a.ts', source);
    const parts = chunkFile('a.ts', source, extraction, { maxTokens: 40 }).filter(
      (c) => c.kind === 'symbol-part',
    );
    for (const [index, part] of parts.entries()) {
      if (index === 0) continue;
      const previous = parts[index - 1];
      expect(part.startLine).toBe((previous?.endLine ?? 0) + 1);
    }
    const rejoined = parts.map((p) => p.text).join('\n');
    expect(rejoined).toBe(linesOf(source, 1, source.split('\n').length - 1));
  });

  it('respects the budget for every chunk that has more than one line to give', () => {
    const body = Array.from({ length: 80 }, (_, i) => `  statement${i}();`).join('\n');
    const source = ['function huge() {', body, '}', ''].join('\n');
    const extraction = extract('a.ts', source);
    const chunks = chunkFile('a.ts', source, extraction, { maxTokens: 50 });
    for (const chunk of chunks) {
      if (chunk.startLine === chunk.endLine) continue;
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(50);
    }
  });

  it('emits one over-budget chunk rather than looping on a single huge line', () => {
    // Progress must be guaranteed: a line that alone exceeds the budget becomes
    // one chunk, and the alternative is an empty chunk followed by a hang.
    const source = `const x = "${'y'.repeat(4000)}";\n`;
    const chunks = chunkFile('a.ts', source, { symbols: [], extractor: 'none' }, { maxTokens: 10 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.estimatedTokens).toBeGreaterThan(10);
  });

  it('estimates tokens from the chunk text it actually holds', () => {
    const extraction = extract('a.ts', TWO_FUNCTIONS);
    for (const chunk of chunkFile('a.ts', TWO_FUNCTIONS, extraction)) {
      expect(chunk.estimatedTokens).toBe(estimateTokens(chunk.text));
    }
  });
});

describe('chunkFile — no structure available', () => {
  it('falls back to line-budgeted spans and reports extractor none', () => {
    const source = Array.from({ length: 40 }, (_, i) => `line ${i} of a file with no symbols`).join(
      '\n',
    );
    const chunks = chunkFile(
      'notes.txt',
      source,
      { symbols: [], extractor: 'none' },
      {
        maxTokens: 40,
      },
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.kind).toBe('span');
      expect(chunk.boundary).toBe('line');
      // Honest: no structure was used, and the chunk says so.
      expect(chunk.extractor).toBe('none');
    }
  });

  it('produces nothing for an empty or blank file', () => {
    expect(chunkFile('a.ts', '', { symbols: [], extractor: 'none' })).toHaveLength(0);
    expect(chunkFile('a.ts', '\n\n  \n', { symbols: [], extractor: 'none' })).toHaveLength(0);
  });
});

describe('chunkFile — span merging', () => {
  it('merges a trailing scrap into the span before it', () => {
    const source = ['const a = 1;', 'const b = 2;', '}', ''].join('\n');
    const chunks = chunkFile(
      'a.ts',
      source,
      { symbols: [], extractor: 'none' },
      {
        maxTokens: 4,
        minSpanTokens: 20,
      },
    );
    // With a tiny budget these would be several one-line chunks; merging is what
    // stops a lone `}` becoming a chunk that dilutes ranking.
    expect(chunks.length).toBeLessThan(3);
  });

  it('never merges a span into a symbol', () => {
    // Merging across that boundary would break the guarantee that makes a symbol
    // chunk worth having.
    const extraction = extract('a.ts', TWO_FUNCTIONS);
    const chunks = chunkFile('a.ts', TWO_FUNCTIONS, extraction, { minSpanTokens: 1000 });
    for (const chunk of chunks) {
      if (chunk.kind !== 'symbol') continue;
      expect(chunk.text.includes('import')).toBe(false);
    }
  });
});

describe('chunkFile — nested symbols', () => {
  it('does not emit a nested symbol twice when the parent fits', () => {
    const extraction = extract(
      'a.ts',
      ['export class Small {', '  m(): void {}', '}', ''].join('\n'),
    );
    const chunks = chunkFile(
      'a.ts',
      ['export class Small {', '  m(): void {}', '}', ''].join('\n'),
      extraction,
    );
    const symbols = symbolChunks(chunks);
    // The class fits, so it is one chunk; the method is inside it, not beside it.
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.symbol?.name).toBe('Small');
  });

  it('handles a symbol range that runs past the end of the file', () => {
    // A truncated file can produce a range beyond the last line; chunking must
    // clamp rather than emit undefined text.
    const source = 'function f() {\n';
    const symbol: SymbolInfo = {
      name: 'f',
      kind: 'function',
      range: {
        startLine: 1,
        startColumn: 10,
        endLine: 99,
        endColumn: 1,
        startIndex: 9,
        endIndex: 999,
      },
    };
    const chunks = chunkFile('a.ts', source, { symbols: [symbol], extractor: 'heuristic' });
    expect(chunks).toHaveLength(1);
    // Clamped to the file, and no `undefined` leaked in from indexing past the end.
    expect(chunks[0]?.text).toContain('function f() {');
    expect(chunks[0]?.text).not.toContain('undefined');
    expect(chunks[0]?.endLine).toBeLessThanOrEqual(source.split('\n').length);
  });
});
