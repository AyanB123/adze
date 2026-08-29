/**
 * Public types for the three-tier edit applier.
 *
 * Design rationale: docs/architecture/adr/0005-edit-application.md
 */

/** Which tier produced a result. Tiers escalate in cost, not in looseness. */
export type ApplyTier = 'search-replace' | 'whole-file' | 'fast-apply';

/**
 * How a search block was located, in escalation order.
 *
 * We never relax past `anchored`. There is deliberately no fuzzy/edit-distance
 * strategy: a near-miss on source code is a different program, and "closest
 * match" is how files get corrupted in a way nobody can reproduce.
 */
export type MatchStrategy =
  /** Byte-identical. */
  | 'exact'
  /** Runs of intra-line whitespace collapsed before comparing. */
  | 'whitespace-normalized'
  /** Content matches after removing a uniform indent shift. */
  | 'indentation-tolerant'
  /** Unique first and last line matched; interior spliced. */
  | 'anchored';

/** Why an apply attempt was rejected. Each maps to a distinct user-facing fix. */
export type ApplyFailureReason =
  /** The search text was not found by any strategy. */
  | 'not-found'
  /**
   * The search text matched in more than one place. This is an error, never a
   * guess — silently picking the first match is a corruption vector.
   */
  | 'ambiguous'
  /** The edit produced a file that no longer parses. */
  | 'parse-broken'
  /** File exceeded the configured whole-file rewrite threshold. */
  | 'file-too-large'
  /** The requested tier is not configured (e.g. no fast-apply provider). */
  | 'tier-unavailable'
  /** Search and replace text were identical, so the edit is a no-op. */
  | 'no-op';

/** A single search/replace instruction. */
export interface EditBlock {
  /** Text to locate. Empty string means "insert at top of file". */
  readonly search: string;
  /** Replacement text. Empty string means "delete the matched region". */
  readonly replace: string;
  /**
   * Optional 1-based occurrence selector. When omitted, a non-unique match is
   * an `ambiguous` failure rather than a silent choice of the first.
   */
  readonly occurrence?: number;
}

export interface ApplyRequest {
  /** Path, used only for language detection and reporting. Not read from disk. */
  readonly path: string;
  /** Current file contents. */
  readonly original: string;
  /** Edits to apply, in order. */
  readonly edits: readonly EditBlock[];
  /** Whole-file replacement, used by the whole-file tier. */
  readonly replacement?: string;
}

/** Where a match was found, for reporting and for ambiguity diagnostics. */
export interface MatchLocation {
  /** 0-based character offset into the original text. */
  readonly start: number;
  /** 0-based character offset, exclusive. */
  readonly end: number;
  /** 1-based line number of `start`. */
  readonly line: number;
  readonly strategy: MatchStrategy;
}

export interface ValidationResult {
  readonly ok: boolean;
  /**
   * Which validator ran. `structural` is the always-available fallback;
   * `tree-sitter` is a real parse; `none` means the language is unknown and we
   * declined to guess.
   */
  readonly validator: 'tree-sitter' | 'structural' | 'none';
  readonly message?: string;
  /** 1-based line where validation failed, when known. */
  readonly line?: number;
}

/**
 * Per-attempt telemetry. Aggregated across runs this is what produces
 * "apply success rate per model per tier" — a metric no other open-source tool
 * publishes. See docs/benchmarks/strategy.md.
 */
export interface ApplyTelemetry {
  readonly tier: ApplyTier;
  readonly strategy?: MatchStrategy;
  readonly validation: ValidationResult;
  readonly durationMs: number;
  /** Number of tiers attempted before this result, including this one. */
  readonly tiersAttempted: number;
  readonly editCount: number;
  readonly bytesChanged: number;
}

export type ApplyResult =
  | {
      readonly ok: true;
      readonly content: string;
      readonly telemetry: ApplyTelemetry;
      readonly locations: readonly MatchLocation[];
    }
  | {
      readonly ok: false;
      readonly reason: ApplyFailureReason;
      readonly message: string;
      /** Populated for `ambiguous` so the caller can disambiguate. */
      readonly candidates?: readonly MatchLocation[];
      readonly telemetry: ApplyTelemetry;
    };

/**
 * Tier 3. Deliberately an interface rather than a dependency: every known
 * fast-apply implementation is a proprietary hosted API, and Adze must work
 * fully without one. Its output is parse-validated like any other model output.
 */
export interface FastApplyProvider {
  readonly name: string;
  apply(request: ApplyRequest): Promise<string>;
}

export interface ApplyOptions {
  /**
   * Tiers to attempt, in order. Defaults to search-replace then whole-file.
   * `fast-apply` is only reachable when `fastApplyProvider` is set.
   */
  readonly tiers?: readonly ApplyTier[];
  /** Byte ceiling for whole-file rewrite. Default 256 KiB. */
  readonly maxWholeFileBytes?: number;
  readonly fastApplyProvider?: FastApplyProvider;
  /**
   * Skip parse validation. Off by default and strongly discouraged: validation
   * is the cheapest correctness check available and the difference between
   * "the agent made a mistake" and "the agent broke my build".
   */
  readonly skipValidation?: boolean;
  /** Override language detection, which is normally inferred from `path`. */
  readonly language?: string;
}
