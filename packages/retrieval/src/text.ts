/**
 * Small text utilities shared by the symbol, chunking, and ranking layers.
 *
 * These live in one place because line/offset conversion is the sort of thing
 * that gets reimplemented slightly differently in three files and then disagrees
 * about whether a column is 0- or 1-based.
 */

export interface LineSpan {
  /** Line text without its terminator. */
  readonly text: string;
  /** 0-based character offset of the first character of the line. */
  readonly start: number;
  /** 0-based character offset just past the line's content (before `\r\n`). */
  readonly end: number;
}

/** Split text into lines, retaining exact character offsets. */
export function indexLines(text: string): LineSpan[] {
  const lines: LineSpan[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      const hasCr = i > 0 && text[i - 1] === '\r';
      lines.push({ text: text.slice(start, hasCr ? i - 1 : i), start, end: hasCr ? i - 1 : i });
      start = i + 1;
    }
  }
  if (start <= text.length) lines.push({ text: text.slice(start), start, end: text.length });
  return lines;
}

/** Leading spaces and tabs, as a string so tab width is never assumed. */
export function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/**
 * Indentation width, counting a tab as one unit.
 *
 * Comparing widths only ever happens within a single file, and mixing tabs and
 * spaces at the same nesting level is already a syntax error in Python — the
 * only indentation-sensitive language in the registry.
 */
export function indentWidth(line: string): number {
  return leadingWhitespace(line).length;
}

export function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/**
 * Estimate token count at four characters per token.
 *
 * Deliberately an estimate: shipping a real tokenizer would mean shipping a
 * vocabulary per model family, and chunk budgets do not need that precision.
 * Named `estimate` so no caller mistakes it for an exact count.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Normalise a path to forward slashes, so results compare equal across OSes. */
export function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/');
}
