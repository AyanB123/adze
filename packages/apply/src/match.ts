// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: the match strategies are deliberately explicit about every rejection path. Collapsing the guard clauses would hide exactly the cases that must not silently succeed.

/**
 * Match strategies for locating a search block inside a file.
 *
 * Strategies escalate in tolerance but never into guessing. There is no
 * edit-distance or "closest match" strategy, because a near-miss on source code
 * is a different program. Ambiguity is always reported, never resolved silently.
 */

import type { MatchStrategy } from './types.js';

/** Internal match, carrying the indent information needed to re-indent a replacement. */
export interface RawMatch {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly strategy: MatchStrategy;
  /**
   * Leading whitespace found at the match site. Only set for
   * `indentation-tolerant`, where the replacement must be re-indented to match.
   */
  readonly foundIndent?: string;
  /** Leading whitespace of the search block's first non-blank line. */
  readonly searchIndent?: string;
}

interface LineIndex {
  /** Line text without its terminator. */
  readonly text: string;
  /** Character offset of the first character of the line. */
  readonly start: number;
  /** Character offset just past the line's terminator (or EOF). */
  readonly end: number;
}

/** Split text into lines while retaining exact offsets, so splices stay byte-accurate. */
export function indexLines(text: string): LineIndex[] {
  const lines: LineIndex[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      const hasCr = i > 0 && text[i - 1] === '\r';
      lines.push({ text: text.slice(start, hasCr ? i - 1 : i), start, end: i + 1 });
      start = i + 1;
    }
  }
  // Always push the remainder. For text ending in a newline this is an empty
  // final line, which mirrors how splitting behaves and keeps offsets valid.
  lines.push({ text: text.slice(start), start, end: text.length });
  return lines;
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/** Collapse runs of internal whitespace and trim the ends. */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function leadingWhitespace(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m?.[0] ?? '';
}

function isBlank(s: string): boolean {
  return s.trim().length === 0;
}

/** Strategy 1: byte-identical. Character-level, so it handles mid-line matches. */
function exactMatches(haystack: string, needle: string): RawMatch[] {
  const out: RawMatch[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    out.push({
      start: idx,
      end: idx + needle.length,
      line: lineNumberAt(haystack, idx),
      strategy: 'exact',
    });
    from = idx + Math.max(1, needle.length);
  }
  return out;
}

/**
 * Line-oriented matching with a pluggable comparator.
 *
 * Models emit edits as blocks of lines, so line alignment is the natural unit
 * once we stop requiring byte equality.
 */
function lineBasedMatches(
  haystack: string,
  needle: string,
  strategy: MatchStrategy,
  compare: (haystackLine: string, needleLine: string) => boolean,
): RawMatch[] {
  const hLines = indexLines(haystack);
  const nLines = needle.split(/\r?\n/);
  // A trailing newline in the search block yields a final empty element that is
  // an artifact of splitting, not a line the model intended to match.
  if (nLines.length > 1 && nLines[nLines.length - 1] === '') nLines.pop();
  if (nLines.length === 0) return [];

  const out: RawMatch[] = [];
  for (let i = 0; i + nLines.length <= hLines.length; i++) {
    let all = true;
    for (let j = 0; j < nLines.length; j++) {
      const h = hLines[i + j];
      const n = nLines[j];
      if (h === undefined || n === undefined || !compare(h.text, n)) {
        all = false;
        break;
      }
    }
    if (!all) continue;
    const first = hLines[i];
    const last = hLines[i + nLines.length - 1];
    if (first === undefined || last === undefined) continue;
    out.push({
      start: first.start,
      // Stop at the last line's content end, not past its terminator, so the
      // caller controls whether the newline is replaced.
      end: last.start + last.text.length,
      line: i + 1,
      strategy,
    });
  }
  return out;
}

/**
 * Strategy 2: ignore differences in *internal* whitespace runs only.
 *
 * Leading indentation must still match exactly. This matters for correctness,
 * not just for strategy ordering: if this strategy ignored indentation it would
 * match a block at any nesting level while discarding the indent information
 * needed to re-indent the replacement, silently inserting wrongly-indented code.
 * Indent shifts are `indentation-tolerant`'s job, and it carries that information.
 */
function whitespaceNormalizedMatches(haystack: string, needle: string): RawMatch[] {
  return lineBasedMatches(haystack, needle, 'whitespace-normalized', (h, n) => {
    if (isBlank(h) && isBlank(n)) return true;
    return (
      leadingWhitespace(h) === leadingWhitespace(n) &&
      normalizeWhitespace(h) === normalizeWhitespace(n)
    );
  });
}

/**
 * Strategy 3: allow a uniform indent shift.
 *
 * This is the common real-world failure: a model quotes a block correctly but
 * from a different nesting level than the file actually has. The relative
 * indentation inside the block must still match exactly — only the shared
 * prefix is allowed to differ.
 */
function indentationTolerantMatches(haystack: string, needle: string): RawMatch[] {
  const hLines = indexLines(haystack);
  const nLines = needle.split(/\r?\n/);
  if (nLines.length > 1 && nLines[nLines.length - 1] === '') nLines.pop();
  if (nLines.length === 0) return [];

  const firstContentIdx = nLines.findIndex((l) => !isBlank(l));
  if (firstContentIdx === -1) return [];
  const anchorLine = nLines[firstContentIdx];
  if (anchorLine === undefined) return [];
  const searchIndent = leadingWhitespace(anchorLine);

  const out: RawMatch[] = [];
  for (let i = 0; i + nLines.length <= hLines.length; i++) {
    const anchorHay = hLines[i + firstContentIdx];
    if (anchorHay === undefined || isBlank(anchorHay.text)) continue;
    const foundIndent = leadingWhitespace(anchorHay.text);

    let all = true;
    for (let j = 0; j < nLines.length; j++) {
      const h = hLines[i + j];
      const n = nLines[j];
      if (h === undefined || n === undefined) {
        all = false;
        break;
      }
      if (isBlank(n)) {
        if (!isBlank(h.text)) {
          all = false;
          break;
        }
        continue;
      }
      // Re-base the needle line onto the indentation actually found.
      const rebased = n.startsWith(searchIndent)
        ? foundIndent + n.slice(searchIndent.length)
        : foundIndent + n.trimStart();
      if (h.text.trimEnd() !== rebased.trimEnd()) {
        all = false;
        break;
      }
    }
    if (!all) continue;

    const first = hLines[i];
    const last = hLines[i + nLines.length - 1];
    if (first === undefined || last === undefined) continue;
    out.push({
      start: first.start,
      end: last.start + last.text.length,
      line: i + 1,
      strategy: 'indentation-tolerant',
      foundIndent,
      searchIndent,
    });
  }
  return out;
}

/**
 * True for a line whose only content is an elision marker, optionally behind a
 * comment prefix: `...`, `// ...`, `# ...`, `/* ... *\/`, `<!-- ... -->`.
 */
function isElisionLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  const withoutPrefix = t.replace(/^(?:\/\/+|#+|--+|;+|\/\*+|\*+|<!--)\s*/, '');
  return /^\.{3,}/.test(withoutPrefix);
}

/**
 * Strategy 4: match on a unique first and last line, splice the interior.
 *
 * This exists for one specific case: a model that deliberately elided the middle
 * of a block. It therefore requires an explicit elision marker in the interior,
 * plus *unique* anchors. Without the marker requirement this strategy would
 * match almost any three-line block whose end lines happen to be unique, which
 * is far too aggressive for something that replaces everything in between.
 */
function anchoredMatches(haystack: string, needle: string): RawMatch[] {
  const hLines = indexLines(haystack);
  const nLines = needle.split(/\r?\n/);
  if (nLines.length > 1 && nLines[nLines.length - 1] === '') nLines.pop();
  if (nLines.length < 3) return [];

  // Require the model to have signalled elision explicitly.
  if (!nLines.slice(1, -1).some(isElisionLine)) return [];

  const firstNeedle = nLines[0];
  const lastNeedle = nLines[nLines.length - 1];
  if (firstNeedle === undefined || lastNeedle === undefined) return [];
  const firstKey = normalizeWhitespace(firstNeedle);
  const lastKey = normalizeWhitespace(lastNeedle);
  if (firstKey.length === 0 || lastKey.length === 0) return [];

  const startIdxs: number[] = [];
  const endIdxs: number[] = [];
  for (let i = 0; i < hLines.length; i++) {
    const l = hLines[i];
    if (l === undefined) continue;
    const key = normalizeWhitespace(l.text);
    if (key === firstKey) startIdxs.push(i);
    if (key === lastKey) endIdxs.push(i);
  }
  // Anchors must be unambiguous, otherwise we would be guessing at the span.
  if (startIdxs.length !== 1 || endIdxs.length !== 1) return [];

  const s = startIdxs[0];
  const e = endIdxs[0];
  if (s === undefined || e === undefined || e <= s) return [];

  const first = hLines[s];
  const last = hLines[e];
  if (first === undefined || last === undefined) return [];
  return [
    {
      start: first.start,
      end: last.start + last.text.length,
      line: s + 1,
      strategy: 'anchored',
    },
  ];
}

/** Strategies in escalation order. The first level that yields any match wins. */
const STRATEGIES: readonly ((h: string, n: string) => RawMatch[])[] = [
  exactMatches,
  whitespaceNormalizedMatches,
  indentationTolerantMatches,
  anchoredMatches,
];

export interface FindResult {
  readonly matches: readonly RawMatch[];
  /** The strategy level that produced `matches`, if any matched. */
  readonly strategy?: MatchStrategy;
}

/**
 * Locate a search block, escalating strategies until one matches.
 *
 * Returns *all* matches at the first successful level rather than picking one.
 * Deciding between multiple matches is the caller's problem, and by default it
 * is an error — see ADR-0005.
 */
export function findMatch(haystack: string, needle: string): FindResult {
  if (needle.length === 0) return { matches: [] };
  for (const strategy of STRATEGIES) {
    const matches = strategy(haystack, needle);
    if (matches.length > 0) {
      const first = matches[0];
      if (first === undefined) continue;
      return { matches, strategy: first.strategy };
    }
  }
  return { matches: [] };
}

/**
 * Re-indent replacement text for a match found via indentation tolerance.
 *
 * Without this, an indent-tolerant match would insert correctly-located but
 * wrongly-indented code — which parses in braces languages and silently breaks
 * Python.
 */
export function reindentReplacement(replacement: string, match: RawMatch): string {
  const { foundIndent, searchIndent } = match;
  if (foundIndent === undefined || searchIndent === undefined) return replacement;
  if (foundIndent === searchIndent) return replacement;
  return replacement
    .split(/\r?\n/)
    .map((line) => {
      if (isBlank(line)) return line;
      const stripped = line.startsWith(searchIndent)
        ? line.slice(searchIndent.length)
        : line.trimStart();
      return foundIndent + stripped;
    })
    .join('\n');
}
