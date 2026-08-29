/**
 * The declarative `apply-bench` case format.
 *
 * A case is an input file, an edit, and an expectation. That is deliberately the
 * whole of it: CONTRIBUTING.md calls an edit-format failure the highest-leverage
 * contribution in the repository and promises it needs no AI expertise, so the
 * format has to be writable by someone who has never read this code.
 *
 * Validated by hand rather than with zod. Cases are usually written by a person
 * transcribing a real failure, so the failure mode to design for is one wrong
 * field in an otherwise plausible file — and a message naming the field and the
 * case beats a schema dump. It also keeps `bench/` from acquiring dependencies of
 * its own, which matters because benchmark code must never influence the product.
 */

import type { ApplyFailureReason, ApplyTier, EditBlock, MatchStrategy } from '@adze/apply';

/**
 * Text as authored in JSON.
 *
 * A string is used verbatim. An array is joined with `\n` and **nothing is
 * added** — so a file ending in a newline is written with a final `""` element.
 * That is more typing than an implicit trailing newline and it is worth it: the
 * presence of a final newline changes what the applier matches, and a case format
 * that quietly inserted one would make some real failures unreproducible.
 */
export type CaseText = string | readonly string[];

export interface CaseExpectation {
  /** `output` asserts the resulting file; `refusal` asserts it must not apply. */
  readonly kind: 'output' | 'refusal';
  /** Required when `kind` is `output`. */
  readonly content?: CaseText;
  /** Required when `kind` is `refusal`. */
  readonly reason?: ApplyFailureReason;
  /**
   * Optional, and the reason this format is more than input/output: a case written
   * to exercise indentation-tolerant matching should assert that the strategy was
   * used, not merely that the answer came out right. Otherwise the case silently
   * stops testing what it was written for the moment matching changes.
   */
  readonly strategy?: MatchStrategy;
  readonly tier?: ApplyTier;
  /** Which validator level must have run. Asserts evidence, not just success. */
  readonly validator?: 'tree-sitter' | 'structural' | 'none';
}

export interface CaseOptions {
  readonly tiers?: readonly ApplyTier[];
  readonly maxWholeFileBytes?: number;
}

export interface BenchCase {
  /** Unique across the suite. Used in reports, filters, and trajectory filenames. */
  readonly id: string;
  /** One line: what this case is testing and why it matters. */
  readonly description: string;
  /** Drives language detection, exactly as a real path would. */
  readonly path: string;
  readonly original: CaseText;
  readonly edits: readonly EditBlock[];
  /** Whole-file replacement, for cases that exercise Tier 2. */
  readonly replacement?: CaseText;
  readonly expect: CaseExpectation;
  readonly options?: CaseOptions;
  /** Free-form grouping, e.g. `matching`, `validation`, `regression`. */
  readonly tags?: readonly string[];
  /**
   * Where the case came from, when it came from a real failure. An issue URL or a
   * model name. This is what turns the suite from a test file into a record.
   */
  readonly source?: string;
}

/** A case plus the file it was loaded from, for error messages that locate it. */
export interface LoadedCase extends BenchCase {
  readonly file: string;
}

export function renderText(text: CaseText): string {
  return typeof text === 'string' ? text : text.join('\n');
}

export class CaseFormatError extends Error {}

function fail(where: string, message: string): never {
  throw new CaseFormatError(`${where}: ${message}`);
}

function asText(value: unknown, where: string, field: string): CaseText {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value as readonly string[];
  }
  return fail(where, `'${field}' must be a string or an array of strings`);
}

const FAILURE_REASONS: readonly ApplyFailureReason[] = [
  'not-found',
  'ambiguous',
  'parse-broken',
  'file-too-large',
  'tier-unavailable',
  'no-op',
];

const TIERS: readonly ApplyTier[] = ['search-replace', 'whole-file', 'fast-apply'];

const STRATEGIES: readonly MatchStrategy[] = [
  'exact',
  'whitespace-normalized',
  'indentation-tolerant',
  'anchored',
];

const VALIDATORS = ['tree-sitter', 'structural', 'none'] as const;

function parseEdits(value: unknown, where: string): readonly EditBlock[] {
  if (!Array.isArray(value)) return fail(where, "'edits' must be an array");
  return value.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      return fail(where, `edits[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.search !== 'string') return fail(where, `edits[${i}].search must be a string`);
    if (typeof e.replace !== 'string') return fail(where, `edits[${i}].replace must be a string`);
    if (
      e.occurrence !== undefined &&
      (!Number.isInteger(e.occurrence) || Number(e.occurrence) < 1)
    ) {
      return fail(where, `edits[${i}].occurrence must be a positive integer`);
    }
    return {
      search: e.search,
      replace: e.replace,
      ...(e.occurrence === undefined ? {} : { occurrence: Number(e.occurrence) }),
    };
  });
}

/** Check the `kind`-dependent half: content for an output, reason for a refusal. */
function checkExpectationKind(e: Record<string, unknown>, where: string): void {
  if (e.kind !== 'output' && e.kind !== 'refusal') {
    fail(where, "expect.kind must be 'output' or 'refusal'");
  }

  if (e.kind === 'output') {
    if (e.content === undefined) fail(where, "expect.content is required when kind is 'output'");
    return;
  }

  if (typeof e.reason !== 'string' || !FAILURE_REASONS.includes(e.reason as ApplyFailureReason)) {
    fail(
      where,
      `expect.reason is required when kind is 'refusal' and must be one of ${FAILURE_REASONS.join(', ')}`,
    );
  }
  if (e.content !== undefined) {
    // A refusal has no output. Accepting a content field here would let a case look
    // like it asserted the file was unchanged when it asserted nothing.
    fail(where, "expect.content is meaningless when kind is 'refusal'");
  }
}

/** Check the optional assertions that make a case test more than input and output. */
function checkExpectationAssertions(e: Record<string, unknown>, where: string): void {
  if (e.strategy !== undefined && !STRATEGIES.includes(e.strategy as MatchStrategy)) {
    fail(where, `expect.strategy must be one of ${STRATEGIES.join(', ')}`);
  }
  if (e.tier !== undefined && !TIERS.includes(e.tier as ApplyTier)) {
    fail(where, `expect.tier must be one of ${TIERS.join(', ')}`);
  }
  if (
    e.validator !== undefined &&
    !VALIDATORS.includes(e.validator as (typeof VALIDATORS)[number])
  ) {
    fail(where, `expect.validator must be one of ${VALIDATORS.join(', ')}`);
  }
}

function parseExpectation(value: unknown, where: string): CaseExpectation {
  if (typeof value !== 'object' || value === null) return fail(where, "'expect' must be an object");
  const e = value as Record<string, unknown>;

  checkExpectationKind(e, where);
  checkExpectationAssertions(e, where);

  return {
    kind: e.kind as 'output' | 'refusal',
    ...(e.content === undefined ? {} : { content: asText(e.content, where, 'expect.content') }),
    ...(e.reason === undefined ? {} : { reason: e.reason as ApplyFailureReason }),
    ...(e.strategy === undefined ? {} : { strategy: e.strategy as MatchStrategy }),
    ...(e.tier === undefined ? {} : { tier: e.tier as ApplyTier }),
    ...(e.validator === undefined ? {} : { validator: e.validator as (typeof VALIDATORS)[number] }),
  };
}

function parseOptions(value: unknown, where: string): CaseOptions | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null)
    return fail(where, "'options' must be an object");
  const o = value as Record<string, unknown>;

  let tiers: readonly ApplyTier[] | undefined;
  if (o.tiers !== undefined) {
    if (!Array.isArray(o.tiers) || !o.tiers.every((t) => TIERS.includes(t as ApplyTier))) {
      return fail(where, `options.tiers must be an array of ${TIERS.join(', ')}`);
    }
    tiers = o.tiers as readonly ApplyTier[];
  }

  if (
    o.maxWholeFileBytes !== undefined &&
    (!Number.isInteger(o.maxWholeFileBytes) || Number(o.maxWholeFileBytes) < 0)
  ) {
    return fail(where, 'options.maxWholeFileBytes must be a non-negative integer');
  }

  return {
    ...(tiers === undefined ? {} : { tiers }),
    ...(o.maxWholeFileBytes === undefined
      ? {}
      : { maxWholeFileBytes: Number(o.maxWholeFileBytes) }),
  };
}

/** Parse one case object. `file` appears in every error so a failure is locatable. */
export function parseCase(value: unknown, file: string, index: number): LoadedCase {
  const where = `${file} [case ${index}]`;
  if (typeof value !== 'object' || value === null) return fail(where, 'case must be an object');
  const c = value as Record<string, unknown>;

  if (typeof c.id !== 'string' || c.id.length === 0)
    return fail(where, "'id' must be a non-empty string");
  const at = `${file} [${c.id}]`;
  if (typeof c.description !== 'string' || c.description.length === 0) {
    return fail(at, "'description' must be a non-empty string");
  }
  if (typeof c.path !== 'string' || c.path.length === 0) {
    return fail(at, "'path' must be a non-empty string — it drives language detection");
  }

  const options = parseOptions(c.options, at);
  const tags = c.tags;
  if (tags !== undefined && (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string'))) {
    return fail(at, "'tags' must be an array of strings");
  }
  if (c.source !== undefined && typeof c.source !== 'string') {
    return fail(at, "'source' must be a string");
  }

  return {
    id: c.id,
    file,
    description: c.description,
    path: c.path,
    original: asText(c.original, at, 'original'),
    edits: parseEdits(c.edits, at),
    ...(c.replacement === undefined
      ? {}
      : { replacement: asText(c.replacement, at, 'replacement') }),
    expect: parseExpectation(c.expect, at),
    ...(options === undefined ? {} : { options }),
    ...(tags === undefined ? {} : { tags: tags as readonly string[] }),
    ...(c.source === undefined ? {} : { source: c.source as string }),
  };
}

/** Parse a case file: `{ "cases": [ ... ] }`. */
export function parseCaseFile(text: string, file: string): LoadedCase[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new CaseFormatError(
      `${file} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray((raw as { cases?: unknown }).cases)
  ) {
    throw new CaseFormatError(`${file} must be an object with a 'cases' array`);
  }
  const cases = (raw as { cases: unknown[] }).cases;
  return cases.map((entry, index) => parseCase(entry, file, index));
}
