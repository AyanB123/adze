/**
 * Locating an applied edit in the file, and computing its inverse.
 *
 * ### Why this is harder than it should be
 *
 * The engine writes the file itself. `edit.proposed` and `edit.applied` are both
 * emitted *after* the write has already landed on disk, so a surface never sees a
 * proposal it could accept or reject beforehand, and never gets a chance to capture
 * the pre-edit bytes. That is a protocol gap, recorded in this package's README.
 *
 * What is derivable from the protocol alone is the inverse of a search/replace
 * edit: each block's `replace` text now sits in the file where its `search` text
 * used to, so replacing the former with the latter restores the original — provided
 * the replacement can be located unambiguously.
 *
 * ### Ambiguity is a refusal, never a guess
 *
 * If `replace` occurs more than once, this module refuses. Taking the first match
 * would revert the wrong region, and the corruption would be invisible and
 * unreproducible — the same reasoning that makes an ambiguous match an error in the
 * applier rather than a coin flip. Every refusal is named, so the surface can say
 * why instead of failing quietly.
 *
 * Everything here is pure: string in, plan out. No editor, no filesystem.
 */

import type { ApplyTelemetry, EditBlock, ProposedEdit } from '@adze/protocol';

export interface Span {
  readonly start: number;
  readonly end: number;
}

export type LocateFailure =
  /** The text is not in the file. It was changed again, or never landed. */
  | 'not-found'
  /** More than one occurrence. Reverting would be a guess. */
  | 'ambiguous'
  /** Nothing to search for — an empty replacement locates everywhere and nowhere. */
  | 'not-derivable';

export type LocateOutcome =
  | { readonly ok: true; readonly span: Span }
  | { readonly ok: false; readonly reason: LocateFailure };

/** Count occurrences without building an array, so a big file stays cheap. */
function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * Find `needle` in `text`, requiring exactly one occurrence.
 *
 * An empty needle is `not-derivable` rather than "found at 0": a deletion's
 * replacement text is empty, and there is no position in the file that identifies
 * where the deleted text used to be.
 */
export function locateUnique(text: string, needle: string): LocateOutcome {
  if (needle === '') return { ok: false, reason: 'not-derivable' };
  const occurrences = countOccurrences(text, needle);
  if (occurrences === 0) return { ok: false, reason: 'not-found' };
  if (occurrences > 1) return { ok: false, reason: 'ambiguous' };
  const start = text.indexOf(needle);
  return { ok: true, span: { start, end: start + needle.length } };
}

export interface LocatedEdit {
  readonly span: Span;
  /** The text now occupying the span. */
  readonly current: string;
  /** What was there before, and what a revert would restore. */
  readonly original: string;
}

export type RevertRefusal =
  | LocateFailure
  /**
   * The applier rewrote the whole file, so the original content is not recoverable
   * from the proposal — a whole-file tier carries the new text, not the old.
   */
  | 'whole-file'
  /** Two blocks resolved to overlapping spans, so applying both is not well defined. */
  | 'overlapping';

export type RevertPlan =
  | { readonly ok: true; readonly operations: readonly LocatedEdit[] }
  | { readonly ok: false; readonly reason: RevertRefusal; readonly message: string };

function refusalMessage(path: string, reason: RevertRefusal): string {
  switch (reason) {
    case 'not-found':
      return (
        `Cannot revert ${path}: the text Adze inserted is no longer in the file. ` +
        `It has been changed since. Use Undo (Ctrl+Z) if this was the last change.`
      );
    case 'ambiguous':
      return (
        `Cannot revert ${path}: the text Adze inserted appears more than once, so ` +
        `reverting would have to guess which occurrence to restore. Refusing instead. ` +
        `Use Undo (Ctrl+Z).`
      );
    case 'not-derivable':
      return (
        `Cannot revert ${path}: the edit deleted text, and the protocol does not carry ` +
        `where it used to be. Use Undo (Ctrl+Z).`
      );
    case 'whole-file':
      return (
        `Cannot revert ${path}: the applier rewrote the whole file, and the previous ` +
        `contents are not part of what the engine reported. Use Undo (Ctrl+Z).`
      );
    case 'overlapping':
      return (
        `Cannot revert ${path}: two of the edits resolved to overlapping regions, so ` +
        `undoing them in sequence is not well defined. Refusing instead of guessing.`
      );
  }
}

function overlaps(operations: readonly LocatedEdit[]): boolean {
  const sorted = [...operations].sort((a, b) => a.span.start - b.span.start);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous === undefined || current === undefined) continue;
    if (current.span.start < previous.span.end) return true;
  }
  return false;
}

function locateBlocks(
  text: string,
  edits: readonly EditBlock[],
):
  | { readonly ok: true; readonly located: LocatedEdit[] }
  | { readonly ok: false; readonly reason: LocateFailure } {
  const located: LocatedEdit[] = [];
  for (const edit of edits) {
    const outcome = locateUnique(text, edit.replace);
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    located.push({ span: outcome.span, current: edit.replace, original: edit.search });
  }
  return { ok: true, located };
}

/**
 * Plan the inverse of an applied edit.
 *
 * `telemetry` is required rather than optional because it is the only thing that
 * says which tier actually ran, and a whole-file rewrite is not invertible. Reading
 * the tier from the report instead of inferring it from the proposal's shape is the
 * difference between refusing correctly and corrupting a file.
 *
 * Operations come back sorted **descending by offset**, so a caller applying them
 * in order does not have to adjust for its own edits.
 */
export function planRevert(
  text: string,
  proposal: ProposedEdit,
  telemetry: ApplyTelemetry,
): RevertPlan {
  if (telemetry.tier !== 'search-replace') {
    return {
      ok: false,
      reason: 'whole-file',
      message: refusalMessage(proposal.path, 'whole-file'),
    };
  }
  if (proposal.edits.length === 0) {
    return {
      ok: false,
      reason: 'not-derivable',
      message: refusalMessage(proposal.path, 'not-derivable'),
    };
  }

  const outcome = locateBlocks(text, proposal.edits);
  if (!outcome.ok) {
    return {
      ok: false,
      reason: outcome.reason,
      message: refusalMessage(proposal.path, outcome.reason),
    };
  }
  if (overlaps(outcome.located)) {
    return {
      ok: false,
      reason: 'overlapping',
      message: refusalMessage(proposal.path, 'overlapping'),
    };
  }

  return {
    ok: true,
    operations: [...outcome.located].sort((a, b) => b.span.start - a.span.start),
  };
}

/**
 * Where an applied edit currently sits, for decoration.
 *
 * Advisory rather than strict: a block that cannot be located is skipped and
 * counted, because highlighting is a hint and a stale highlight is worse than a
 * missing one. Reverting uses {@link planRevert}, which refuses instead.
 */
export interface HighlightResult {
  readonly spans: readonly Span[];
  /** Blocks that could not be located, with why. Surfaced so the count is honest. */
  readonly unlocated: readonly LocateFailure[];
}

export function highlightSpans(text: string, proposal: ProposedEdit): HighlightResult {
  const spans: Span[] = [];
  const unlocated: LocateFailure[] = [];
  for (const edit of proposal.edits) {
    const outcome = locateUnique(text, edit.replace);
    if (outcome.ok) spans.push(outcome.span);
    else unlocated.push(outcome.reason);
  }
  return { spans, unlocated };
}
