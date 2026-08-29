/**
 * Structure-aware chunking.
 *
 * Chunks are cut on symbol boundaries, not on fixed token windows, so a chunk is
 * a function rather than the tail of one function plus the head of the next.
 * ADR-0006 calls this out specifically: a fixed window splits a definition from
 * its signature roughly half the time, and a retrieved half-function is worse
 * than useless because it reads as complete.
 *
 * A token budget still applies, because a 3000-line generated file has to fit
 * somewhere. When the budget forces a cut inside a symbol, the chunk says so:
 * `kind` becomes `symbol-part` and `boundary` becomes `line`. A consumer can then
 * tell a whole function from a fragment without re-parsing.
 *
 * Chunks also carry the {@link SymbolExtraction.extractor} level their boundaries
 * came from, so "these boundaries came from a real parse" and "these came from
 * the regex scanner" stay distinguishable downstream.
 */

import { estimateTokens, indexLines, isBlank, type LineSpan } from './text.js';
import type { Chunk, ChunkOptions, SymbolExtractor, SymbolInfo } from './types.js';

const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_MIN_SPAN_TOKENS = 12;
/** Guards against a pathological symbol tree; real nesting is 2-3 deep. */
const MAX_NESTING_DEPTH = 8;

interface ResolvedOptions {
  readonly maxTokens: number;
  readonly minSpanTokens: number;
  readonly includeSpans: boolean;
}

/** Join lines `[startLine, endLine]`, both 1-based and inclusive. */
function sliceText(lines: readonly LineSpan[], startLine: number, endLine: number): string {
  const parts: string[] = [];
  for (let line = startLine; line <= endLine; line++) {
    const span = lines[line - 1];
    if (span === undefined) break;
    parts.push(span.text);
  }
  return parts.join('\n');
}

/** True when `child` sits strictly inside `parent`. */
function isNestedIn(child: SymbolInfo, parent: SymbolInfo): boolean {
  const wider =
    child.range.startIndex >= parent.range.startIndex &&
    child.range.endIndex <= parent.range.endIndex;
  if (!wider) return false;
  return (
    child.range.startIndex > parent.range.startIndex || child.range.endIndex < parent.range.endIndex
  );
}

/** Symbols not contained in any other symbol, in source order. */
function topLevelSymbols(symbols: readonly SymbolInfo[]): SymbolInfo[] {
  return symbols
    .filter((candidate) => !symbols.some((other) => isNestedIn(candidate, other)))
    .sort((a, b) => a.range.startIndex - b.range.startIndex);
}

/** Direct children of `parent`: nested in it, and in nothing else nested in it. */
function directChildren(parent: SymbolInfo, symbols: readonly SymbolInfo[]): SymbolInfo[] {
  const nested = symbols.filter((candidate) => isNestedIn(candidate, parent));
  return nested
    .filter((candidate) => !nested.some((other) => isNestedIn(candidate, other)))
    .sort((a, b) => a.range.startIndex - b.range.startIndex);
}

interface Builder {
  readonly path: string;
  readonly lines: readonly LineSpan[];
  readonly extractor: SymbolExtractor;
  readonly options: ResolvedOptions;
  readonly out: Chunk[];
}

function pushChunk(
  builder: Builder,
  startLine: number,
  endLine: number,
  fields: Omit<Chunk, 'path' | 'startLine' | 'endLine' | 'text' | 'estimatedTokens' | 'extractor'>,
): void {
  // Clamp to the file. `sliceText` already stops at the last line, so without
  // this a symbol range that overruns the file — which an external
  // `RetrievalProvider` can hand us — would produce a chunk whose reported
  // endLine does not match its text, and re-slicing the file from those numbers
  // would give a different span than the chunk actually holds.
  const lastLine = builder.lines.length;
  const from = Math.max(1, startLine);
  const to = Math.min(endLine, lastLine);
  if (to < from) return;
  const text = sliceText(builder.lines, from, to);
  if (isBlank(text)) return;
  builder.out.push({
    path: builder.path,
    startLine: from,
    endLine: to,
    text,
    estimatedTokens: estimateTokens(text),
    extractor: builder.extractor,
    ...fields,
  });
}

/**
 * Emit the code between symbols: imports, top-level statements, a class header.
 *
 * Split at line boundaries because there is no better boundary available — this
 * is precisely the material that has no symbol structure.
 */
function emitSpan(builder: Builder, startLine: number, endLine: number): void {
  if (!builder.options.includeSpans) return;
  if (endLine < startLine) return;

  let chunkStart = startLine;
  let tokens = 0;
  for (let line = startLine; line <= endLine; line++) {
    const span = builder.lines[line - 1];
    if (span === undefined) break;
    const lineTokens = estimateTokens(span.text) + 1;
    if (tokens > 0 && tokens + lineTokens > builder.options.maxTokens) {
      pushChunk(builder, chunkStart, line - 1, { kind: 'span', boundary: 'line' });
      chunkStart = line;
      tokens = 0;
    }
    tokens += lineTokens;
  }
  pushChunk(builder, chunkStart, endLine, { kind: 'span', boundary: 'line' });
}

/** Split an over-budget symbol at line boundaries, marked as parts. */
function emitSymbolParts(builder: Builder, symbol: SymbolInfo): void {
  const { startLine, endLine } = symbol.range;
  const ranges: Array<readonly [number, number]> = [];
  let chunkStart = startLine;
  let tokens = 0;

  for (let line = startLine; line <= endLine; line++) {
    const span = builder.lines[line - 1];
    if (span === undefined) break;
    const lineTokens = estimateTokens(span.text) + 1;
    // `tokens > 0` guarantees progress: a single line above the budget still
    // becomes one part rather than an empty one followed by an infinite loop.
    if (tokens > 0 && tokens + lineTokens > builder.options.maxTokens) {
      ranges.push([chunkStart, line - 1]);
      chunkStart = line;
      tokens = 0;
    }
    tokens += lineTokens;
  }
  ranges.push([chunkStart, endLine]);

  for (const [index, range] of ranges.entries()) {
    pushChunk(builder, range[0], range[1], {
      kind: 'symbol-part',
      boundary: 'line',
      symbol,
      part: { index: index + 1, of: ranges.length },
    });
  }
}

function emitSymbol(
  builder: Builder,
  symbol: SymbolInfo,
  allSymbols: readonly SymbolInfo[],
  depth: number,
): void {
  const { startLine, endLine } = symbol.range;
  const text = sliceText(builder.lines, startLine, endLine);

  if (estimateTokens(text) <= builder.options.maxTokens) {
    pushChunk(builder, startLine, endLine, { kind: 'symbol', boundary: 'symbol', symbol });
    return;
  }

  const children = depth < MAX_NESTING_DEPTH ? directChildren(symbol, allSymbols) : [];
  if (children.length === 0) {
    emitSymbolParts(builder, symbol);
    return;
  }

  // Over budget but structured: descend. A class becomes its methods, each of
  // which is still a whole symbol.
  let cursor = startLine;
  for (const child of children) {
    if (child.range.startLine > cursor) emitSpan(builder, cursor, child.range.startLine - 1);
    emitSymbol(builder, child, allSymbols, depth + 1);
    cursor = Math.max(cursor, child.range.endLine + 1);
  }
  if (cursor <= endLine) emitSpan(builder, cursor, endLine);
}

/**
 * Merge an undersized span into the span before it.
 *
 * A trailing `}` or a lone `export {}` is not worth a chunk of its own, and a
 * one-line chunk dilutes ranking. Only adjacent spans merge: merging a span into
 * a symbol would break the boundary guarantee that makes a symbol chunk useful.
 */
function mergeSmallSpans(chunks: readonly Chunk[], options: ResolvedOptions): Chunk[] {
  const out: Chunk[] = [];
  for (const chunk of chunks) {
    const previous = out[out.length - 1];
    const mergeable =
      previous !== undefined &&
      previous.kind === 'span' &&
      chunk.kind === 'span' &&
      chunk.estimatedTokens < options.minSpanTokens &&
      previous.endLine + 1 === chunk.startLine &&
      previous.estimatedTokens + chunk.estimatedTokens <= options.maxTokens;

    if (!mergeable || previous === undefined) {
      out.push(chunk);
      continue;
    }
    const text = `${previous.text}\n${chunk.text}`;
    out[out.length - 1] = {
      ...previous,
      endLine: chunk.endLine,
      text,
      estimatedTokens: estimateTokens(text),
    };
  }
  return out;
}

/**
 * Chunk a file on the boundaries the given extraction found.
 *
 * With an empty symbol list this degrades to line-budgeted spans, which is the
 * correct behaviour for a file whose language has no extractor: still chunked,
 * still bounded, and honest via `extractor: 'none'` that no structure was used.
 */
export function chunkFile(
  path: string,
  source: string,
  extraction: {
    readonly symbols: readonly SymbolInfo[];
    readonly extractor: SymbolExtractor;
  },
  options: ChunkOptions = {},
): Chunk[] {
  const resolved: ResolvedOptions = {
    maxTokens: Math.max(1, options.maxTokens ?? DEFAULT_MAX_TOKENS),
    minSpanTokens: Math.max(0, options.minSpanTokens ?? DEFAULT_MIN_SPAN_TOKENS),
    includeSpans: options.includeSpans ?? true,
  };

  const lines = indexLines(source);
  const builder: Builder = {
    path,
    lines,
    extractor: extraction.extractor,
    options: resolved,
    out: [],
  };

  const tops = topLevelSymbols(extraction.symbols);
  let cursor = 1;
  for (const symbol of tops) {
    if (symbol.range.startLine > cursor) emitSpan(builder, cursor, symbol.range.startLine - 1);
    emitSymbol(builder, symbol, extraction.symbols, 0);
    cursor = Math.max(cursor, symbol.range.endLine + 1);
  }
  if (cursor <= lines.length) emitSpan(builder, cursor, lines.length);

  return mergeSmallSpans(builder.out, resolved);
}
