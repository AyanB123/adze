/**
 * The machine-readable report shape.
 *
 * `docs/benchmarks/strategy.md` names this file as the schema for `result.json`, so
 * this is the definition that document refers to.
 *
 * Two things here are policy rather than data modelling.
 *
 * `inputSource` is required and there is no default. ADR-0011 forbids describing a
 * metric as "per model" when only one synthetic source of inputs exists, and a
 * suite run on hand-written edits measures the applier rather than model behaviour.
 * Making the field mandatory means a report cannot be produced without stating
 * which one it measured.
 *
 * `severeFailures` is separate from the failure list. A case written to be refused
 * that instead applied is the corruption class — the applier accepted an edit it
 * should have rejected — and it must not average into a pass rate alongside a
 * cosmetic mismatch.
 */

import type { ApplyFailureReason, ApplyTier, MatchStrategy } from '@adze/apply';

export const REPORT_SCHEMA_VERSION = 1;

/**
 * How a case turned out. Distinct kinds because each one means something different
 * about the applier, and collapsing them would discard the signal.
 */
export type CaseOutcome =
  /** The expectation was met, including any asserted strategy, tier, or validator. */
  | 'pass'
  /** Applied, but the resulting file differs from the expectation. */
  | 'wrong-output'
  /** Expected a file, got a refusal. A valid edit was rejected. */
  | 'unexpected-refusal'
  /**
   * Expected a refusal, got an applied edit. **The severe one.** This is the
   * corruption class: the applier wrote something it was supposed to decline.
   */
  | 'unexpected-success'
  /** Refused, but for a different reason than the case asserts. */
  | 'wrong-reason'
  /** Right output, reached by a different match strategy than asserted. */
  | 'wrong-strategy'
  /** Right output, produced by a different tier than asserted. */
  | 'wrong-tier'
  /** Right output, but a different validator level ran than asserted. */
  | 'wrong-validator'
  /** The harness itself failed. Counted separately; never a pass or a fail. */
  | 'harness-error';

export interface CaseResult {
  readonly id: string;
  readonly file: string;
  readonly description: string;
  readonly outcome: CaseOutcome;
  readonly tags: readonly string[];
  /** Language as detected from the case path, which is what the validator saw. */
  readonly language: string;
  readonly durationMs: number;
  /** What the applier reported. Absent only for a harness error. */
  readonly actual?: {
    readonly ok: boolean;
    readonly tier: ApplyTier;
    readonly strategy?: MatchStrategy;
    readonly validator: 'tree-sitter' | 'structural' | 'none';
    readonly validationOk: boolean;
    readonly reason?: ApplyFailureReason;
    readonly message?: string;
    readonly tiersAttempted: number;
  };
  /** Present for every non-pass: what was expected, in one line. */
  readonly detail?: string;
}

export interface Breakdown {
  readonly total: number;
  readonly passed: number;
  /** Pass rate in [0, 1], or `null` when the denominator is zero. */
  readonly passRate: number | null;
}

export interface BenchReport {
  readonly schemaVersion: number;
  readonly suite: string;
  readonly harnessVersion: string;
  /** The exact command that produced this report. */
  readonly invocation: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;

  readonly environment: {
    readonly node: string;
    readonly platform: string;
    readonly arch: string;
  };

  /**
   * What produced the edits under test. Required, and the honest value for the
   * committed suite is `synthetic`: the cases are hand-written, so the numbers
   * measure the applier and say nothing about any model.
   */
  readonly inputSource: 'synthetic' | 'model' | 'mixed';
  /**
   * Model pins, when `inputSource` is not `synthetic`. Empty for the committed
   * suite — and an empty list is the report stating that there was no model,
   * rather than the field being quietly absent.
   */
  readonly models: readonly string[];
  /**
   * Attempts per case. 1 for a deterministic suite. ADR-0011's mean-over-≥3-attempts
   * rule exists for stochastic sampling; repeating a deterministic run three times
   * would produce a zero-variance interval that looks like rigour and is not.
   */
  readonly attempts: number;
  readonly deterministic: boolean;

  readonly totals: {
    readonly cases: number;
    readonly passed: number;
    readonly failed: number;
    readonly harnessErrors: number;
    /** Pass rate in [0, 1], or `null` when no cases ran. */
    readonly passRate: number | null;
  };

  /** Keyed by `ApplyTier`. The per-tier half of "success rate per model per tier". */
  readonly byTier: Readonly<Record<string, Breakdown>>;
  /** Keyed by `MatchStrategy`, plus `none` for results that located nothing. */
  readonly byStrategy: Readonly<Record<string, Breakdown>>;
  /** Keyed by validator level. Evidence about how much was really parsed. */
  readonly byValidator: Readonly<Record<string, Breakdown>>;
  /** Keyed by tag. */
  readonly byTag: Readonly<Record<string, Breakdown>>;
  /** Keyed by `ApplyFailureReason`: how often each refusal reason was produced. */
  readonly refusalReasons: Readonly<Record<string, number>>;

  /**
   * Cases that applied when they should have been refused. Listed separately and
   * first, because this is the class of failure that corrupts a file.
   */
  readonly severeFailures: readonly CaseResult[];
  readonly results: readonly CaseResult[];
}

export function emptyBreakdown(): Breakdown {
  return { total: 0, passed: 0, passRate: null };
}

export function addToBreakdown(current: Breakdown | undefined, passed: boolean): Breakdown {
  const base = current ?? emptyBreakdown();
  const total = base.total + 1;
  const passedCount = base.passed + (passed ? 1 : 0);
  return { total, passed: passedCount, passRate: passedCount / total };
}

/** `null` renders as `n/a` rather than as `0%`, which would read as a total failure. */
export function formatRate(rate: number | null): string {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}
