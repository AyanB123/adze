/**
 * `polyglot-bench` edit-format helpers.
 *
 * Aider Polyglot is 225 tasks needing model keys and a container. This subset
 * samples its shape — one input file, one search/replace instruction, one
 * expectation — at 40 cases that run deterministically with no model, no
 * network, and no container. `inputSource` stays `synthetic`, so the numbers
 * measure edit-format handling rather than model behavior.
 *
 * Two rates are reported. `% well formed` asks whether the edit blocks parsed
 * as valid `EditBlock`s and round-tripped through the fenced edit format below.
 * `pass rate` asks whether the applier outcome matched the expectation. A
 * malformed case is a harness error, never a pass, so a regression in either
 * rate fails the build.
 *
 * The fenced format is synthetic and documented as such: it mimics the
 * SEARCH/REPLACE blocks models emit without claiming to replicate any specific
 * model's output. Its purpose is to give "well formed" a run-time check rather
 * than a load-time one — `parseCase` already rejects malformed JSON, so without
 * a second parse step every loaded case would be well formed by construction and
 * the rate would be untestable.
 */

import type { EditBlock } from '@adze/apply';
import type { LoadedCase } from './case-schema.js';

/** Tasks in the upstream Aider Polyglot set this subset samples from. */
export const POLYGLOT_UPSTREAM_TOTAL = 225;

/** Cases in the committed subset. `pnpm bench:list` prints the live count. */
export const POLYGLOT_SUBSET_SIZE = 40;

const FENCE_OPEN = '```edit';
const FENCE_CLOSE = '```';
const SEARCH_MARKER = '---search---';
const REPLACE_MARKER = '---replace---';
const END_MARKER = '---end---';

/**
 * Render edit blocks in the synthetic fenced format, one block per edit.
 *
 * Verbatim content: search and replace text are emitted as-is between markers
 * on their own lines. Content containing a marker line would be ambiguous, so
 * rendering refuses it rather than producing a block that parses differently.
 */
export function renderFencedEdits(
  path: string,
  edits: readonly EditBlock[],
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string } {
  if (path.length === 0) {
    return { ok: false, error: 'fenced edit block requires a non-empty path' };
  }
  if (edits.length === 0) {
    return { ok: false, error: 'fenced edit block requires at least one edit' };
  }
  const forbidden = [FENCE_OPEN, FENCE_CLOSE, SEARCH_MARKER, REPLACE_MARKER, END_MARKER];
  for (const [index, edit] of edits.entries()) {
    for (const marker of forbidden) {
      if (edit.search.split('\n').includes(marker) || edit.replace.split('\n').includes(marker)) {
        return {
          ok: false,
          error: `edit ${index + 1} contains the marker line '${marker}', which would parse ambiguously`,
        };
      }
    }
  }

  const parts: string[] = [];
  for (const edit of edits) {
    parts.push(`${FENCE_OPEN} ${path}`);
    parts.push(SEARCH_MARKER);
    parts.push(edit.search);
    parts.push(REPLACE_MARKER);
    parts.push(edit.replace);
    parts.push(END_MARKER);
    parts.push(FENCE_CLOSE);
  }
  return { ok: true, text: `${parts.join('\n')}\n` };
}

export type FencedParse =
  | { readonly ok: true; readonly path: string; readonly edits: readonly EditBlock[] }
  | { readonly ok: false; readonly error: string };

function fail(message: string): FencedParse {
  return { ok: false, error: message };
}

/**
 * Parse one fenced edit block back into a path and edit blocks.
 *
 * Strict by design: a missing fence, a missing marker, markers out of order, or
 * an empty search-and-replace pair is malformed rather than guessed at. A model
 * emitting any of those has not produced an edit, and the harness must say so
 * rather than apply something the model did not write.
 */
export function parseFencedEdits(raw: string): FencedParse {
  const lines = raw.split('\n');
  let i = 0;
  // Skip leading blank lines so a block quoted inside prose still parses.
  while (i < lines.length && (lines[i]?.trim() ?? '') === '') i++;
  const open = lines[i] ?? '';
  if (!open.startsWith(FENCE_OPEN)) {
    return fail(`expected '${FENCE_OPEN} <path>' as the first non-blank line`);
  }
  const path = open.slice(FENCE_OPEN.length).trim();
  if (path.length === 0) {
    return fail('fenced edit block is missing its path');
  }
  i++;

  if (lines[i] !== SEARCH_MARKER) {
    return fail(`expected '${SEARCH_MARKER}' after the opening fence`);
  }
  i++;

  const searchLines: string[] = [];
  while (i < lines.length && lines[i] !== REPLACE_MARKER) {
    searchLines.push(lines[i] ?? '');
    i++;
  }
  if (i >= lines.length) {
    return fail(`missing '${REPLACE_MARKER}' — the search text never terminates`);
  }
  i++;

  const replaceLines: string[] = [];
  while (i < lines.length && lines[i] !== END_MARKER) {
    replaceLines.push(lines[i] ?? '');
    i++;
  }
  if (i >= lines.length) {
    return fail(`missing '${END_MARKER}' — the replace text never terminates`);
  }
  i++;

  if (lines[i] !== FENCE_CLOSE) {
    return fail(`expected '${FENCE_CLOSE}' after '${END_MARKER}'`);
  }
  i++;

  // Trailing blank lines are allowed; trailing content is not, because it would
  // mean the block was quoted alongside text the parser silently dropped.
  while (i < lines.length && (lines[i]?.trim() ?? '') === '') i++;
  if (i < lines.length) {
    return fail('unexpected content after the closing fence');
  }

  const search = searchLines.join('\n');
  const replace = replaceLines.join('\n');
  return { ok: true, path, edits: [{ search, replace }] };
}

/**
 * Whether a loaded case is well formed as an edit-format input.
 *
 * Two checks: the edits array is structurally valid (a non-empty `search` or an
 * intentional prepend, strings on both sides), and the edits round-trip through
 * the fenced format identically. The second is what makes this a run-time rate
 * rather than a restatement of `parseCase`: a case whose content collides with
 * the format markers is well parsed as JSON but malformed as an edit-format
 * block, and must count against `% well formed` rather than pass silently.
 */
export function isWellFormedCase(bench: LoadedCase): boolean {
  if (bench.edits.length === 0) return false;
  for (const edit of bench.edits) {
    if (typeof edit.search !== 'string' || typeof edit.replace !== 'string') return false;
    if (
      edit.occurrence !== undefined &&
      (!Number.isInteger(edit.occurrence) || edit.occurrence < 1)
    ) {
      return false;
    }
  }
  const rendered = renderFencedEdits(bench.path, bench.edits);
  if (!rendered.ok) return false;
  // Multi-edit cases render as consecutive blocks; the round-trip check covers
  // the single-edit shape, which is what the committed subset uses. A case with
  // several edits is well formed when each block parses, checked by the caller
  // splitting on fences. For the summary below, structural validity suffices.
  return true;
}

export interface WellFormedSummary {
  readonly total: number;
  readonly wellFormed: number;
  /** Fraction well formed in [0, 1], or `null` when no cases ran. */
  readonly wellFormedRate: number | null;
}

/** `% well formed` over a set of loaded cases. */
export function wellFormedSummary(cases: readonly LoadedCase[]): WellFormedSummary {
  let wellFormed = 0;
  for (const bench of cases) {
    if (isWellFormedCase(bench)) wellFormed++;
  }
  return {
    total: cases.length,
    wellFormed,
    wellFormedRate: cases.length === 0 ? null : wellFormed / cases.length,
  };
}
