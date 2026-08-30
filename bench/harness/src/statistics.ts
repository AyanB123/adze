/**
 * The statistics `docs/benchmarks/strategy.md` requires, and the shapes that make
 * the forbidden alternatives unrepresentable.
 *
 * The policy is `mean ± SEM over ≥3 attempts, never max-over-N`. Two things follow
 * from writing that as code rather than as prose in a review checklist.
 *
 * First, **fewer than three attempts does not produce an estimate at all.** It
 * produces `insufficient-attempts`, which carries no number. A single-run figure
 * cannot be smuggled into a report as `mean` with a `sem` of zero, because there is
 * no code path that constructs a `PassRateEstimate` from one attempt.
 *
 * Second, **there is no `max` function in this module.** Best-of-N is a legitimate
 * mode and ADR-0011 permits it when visibly labelled, but it is not computed here,
 * so nothing downstream can reach for it by accident. `looksLikeMaxOverN` exists for
 * the case the rule was actually written against: a hand-edited `result.json` whose
 * headline was filled in from the best attempt. It is a detector, not a calculator.
 */

/** ADR-0011: at least three attempts, because a single-run number is not a result. */
export const MIN_ATTEMPTS = 3;

/**
 * A pass rate with its uncertainty. Constructible only by `estimatePassRate`, which
 * is what makes `n >= MIN_ATTEMPTS` an invariant of the type rather than a rule
 * someone remembers.
 */
export interface PassRateEstimate {
  /** Number of attempts — full passes over the task set, not tasks. */
  readonly n: number;
  /** Per-attempt pass rates in [0, 1], retained so the mean is checkable. */
  readonly attemptRates: readonly number[];
  /** Mean of `attemptRates`, in [0, 1]. */
  readonly mean: number;
  /**
   * Standard error of the mean, in [0, 1]. Sample standard deviation with Bessel's
   * correction over `n - 1`, divided by `sqrt(n)`.
   */
  readonly sem: number;
  /** Sample standard deviation, in [0, 1]. Reported so the SEM is reproducible. */
  readonly stdDev: number;
}

export type AttemptSummary =
  | { readonly kind: 'estimate'; readonly estimate: PassRateEstimate }
  | {
      readonly kind: 'insufficient-attempts';
      readonly n: number;
      readonly required: number;
      readonly reason: string;
    };

export class StatisticsError extends Error {}

/**
 * Mean ± SEM over per-attempt pass rates.
 *
 * The input is one rate per attempt, not one boolean per task. That distinction is
 * the whole point: SWE-rebench publishes `51.7% ±0.84` for Cursor, where the
 * interval is across repeated passes over the task set. A binomial interval computed
 * from a single pass would be narrower and would describe sampling of tasks rather
 * than variance of the agent, which is the quantity that actually moves.
 */
export function estimatePassRate(attemptRates: readonly number[]): AttemptSummary {
  for (const [index, rate] of attemptRates.entries()) {
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new StatisticsError(
        `attemptRates[${index}] must be a finite number in [0, 1], got ${String(rate)}`,
      );
    }
  }

  const n = attemptRates.length;
  if (n < MIN_ATTEMPTS) {
    return {
      kind: 'insufficient-attempts',
      n,
      required: MIN_ATTEMPTS,
      reason:
        `${n} attempt(s) is below the ${MIN_ATTEMPTS} that docs/benchmarks/strategy.md ` +
        'requires. No estimate is produced, because a single-run number is not a result.',
    };
  }

  const mean = attemptRates.reduce((sum, rate) => sum + rate, 0) / n;
  const variance = attemptRates.reduce((sum, rate) => sum + (rate - mean) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);

  return {
    kind: 'estimate',
    estimate: { n, attemptRates: [...attemptRates], mean, sem: stdDev / Math.sqrt(n), stdDev },
  };
}

/**
 * Pass rate of one attempt over a task set. A convenience for turning per-task
 * outcomes into the one number an attempt contributes.
 *
 * Returns `null` for an empty task set rather than `0`, because zero tasks passing
 * out of zero is not a failure and rendering it as `0%` would read as one.
 */
export function attemptRate(taskOutcomes: readonly boolean[]): number | null {
  if (taskOutcomes.length === 0) return null;
  return taskOutcomes.filter((passed) => passed).length / taskOutcomes.length;
}

/**
 * Whether a reported headline looks like it was taken from the best attempt rather
 * than from the mean.
 *
 * This exists because the max-over-N rule is not really aimed at a function call —
 * nobody writes `Math.max` and thinks they are following the policy. It is aimed at
 * a `result.json` whose headline was filled in by hand from the run that went best.
 * `validatePublication` calls this and blocks the report, so the check runs on the
 * artifact rather than on the author's intent.
 *
 * Only meaningful when the attempts actually differ: with zero variance the mean and
 * the max coincide and there is nothing to detect, so that case is not an accusation.
 */
export function looksLikeMaxOverN(
  reportedMean: number,
  attemptRates: readonly number[],
  tolerance = 1e-9,
): boolean {
  if (attemptRates.length < 2) return false;

  let max = Number.NEGATIVE_INFINITY;
  let min = Number.POSITIVE_INFINITY;
  let sum = 0;
  for (const rate of attemptRates) {
    if (rate > max) max = rate;
    if (rate < min) min = rate;
    sum += rate;
  }
  // Identical attempts: mean === max legitimately. Not a finding.
  if (max - min <= tolerance) return false;

  const mean = sum / attemptRates.length;
  return Math.abs(reportedMean - max) <= tolerance && Math.abs(reportedMean - mean) > tolerance;
}

/** `51.7% ± 0.84` — percentage points, matching how the public boards print it. */
export function formatMeanSem(estimate: PassRateEstimate): string {
  return `${(estimate.mean * 100).toFixed(1)}% ± ${(estimate.sem * 100).toFixed(2)}`;
}

/**
 * `solves per million completion tokens`.
 *
 * A headline metric rather than a footnote, per `docs/benchmarks/strategy.md`: the
 * competitive claim is on the joint accuracy-and-cost curve, because Cursor sits
 * behind Claude Code and Codex on capability while costing a fraction as much.
 *
 * Returns `null` when no completion tokens were recorded. Zero tokens with a nonzero
 * solve count would divide to `Infinity`, which would render as an unbeatable score.
 */
export function solvesPerMillionCompletionTokens(
  solves: number,
  completionTokens: number,
): number | null {
  if (completionTokens <= 0) return null;
  return solves / (completionTokens / 1_000_000);
}
