/**
 * Tests for the statistics `docs/benchmarks/strategy.md` requires.
 *
 * These assert the *shape* of the guarantee as much as the arithmetic. The policy is
 * `mean ± SEM over ≥3 attempts, never max-over-N`, and the module's claim is that the
 * forbidden alternatives are unrepresentable rather than merely discouraged. A test
 * that only checked the mean of three numbers would pass against an implementation
 * that happily returned a zero-SEM estimate from one attempt, which is the exact
 * failure the policy exists to stop.
 */

import { describe, expect, it } from 'vitest';
import {
  attemptRate,
  estimatePassRate,
  formatMeanSem,
  looksLikeMaxOverN,
  MIN_ATTEMPTS,
  StatisticsError,
  solvesPerMillionCompletionTokens,
} from '../src/statistics.js';

/** Narrow to the estimate branch, failing the test rather than asserting non-null. */
function estimateOf(rates: readonly number[]) {
  const summary = estimatePassRate(rates);
  if (summary.kind !== 'estimate') {
    throw new Error(`expected an estimate from ${rates.length} attempts, got ${summary.kind}`);
  }
  return summary.estimate;
}

describe('the three-attempt minimum', () => {
  it('is three, and is the number the policy names', () => {
    expect(MIN_ATTEMPTS).toBe(3);
  });

  for (const n of [0, 1, 2]) {
    it(`produces no estimate at all from ${n} attempt(s)`, () => {
      const summary = estimatePassRate(Array.from({ length: n }, () => 0.5));

      expect(summary.kind).toBe('insufficient-attempts');
      if (summary.kind !== 'insufficient-attempts') return;

      // The point of the discriminated union: there is no `mean` on this branch, so a
      // single-run figure cannot be read out of it as though it were a result.
      expect(summary).not.toHaveProperty('estimate');
      expect(summary.n).toBe(n);
      expect(summary.required).toBe(MIN_ATTEMPTS);
      expect(summary.reason).toContain('not a result');
    });
  }

  it('produces an estimate at exactly three attempts', () => {
    expect(estimatePassRate([0.5, 0.5, 0.5]).kind).toBe('estimate');
  });
});

describe('mean and SEM', () => {
  it('computes the mean, sample standard deviation, and SEM', () => {
    const estimate = estimateOf([0.4, 0.5, 0.6]);

    expect(estimate.n).toBe(3);
    expect(estimate.mean).toBeCloseTo(0.5, 12);
    // Bessel's correction: variance over n - 1, so stdDev is 0.1 rather than 0.0816.
    expect(estimate.stdDev).toBeCloseTo(0.1, 12);
    expect(estimate.sem).toBeCloseTo(0.1 / Math.sqrt(3), 12);
  });

  it('reports a zero interval for identical attempts rather than hiding it', () => {
    // A deterministic suite repeated three times lands here. The number is honest and
    // uninformative, which is why report-schema.ts declines to repeat a deterministic
    // run at all instead of printing this.
    const estimate = estimateOf([0.5, 0.5, 0.5]);

    expect(estimate.mean).toBe(0.5);
    expect(estimate.sem).toBe(0);
    expect(estimate.stdDev).toBe(0);
  });

  it('retains the per-attempt rates so the mean is checkable', () => {
    const estimate = estimateOf([0.4, 0.5, 0.6]);
    expect(estimate.attemptRates).toEqual([0.4, 0.5, 0.6]);
  });

  it('copies the input, so a later mutation cannot rewrite a published estimate', () => {
    const rates = [0.4, 0.5, 0.6];
    const estimate = estimateOf(rates);
    rates[0] = 0.99;

    expect(estimate.attemptRates).toEqual([0.4, 0.5, 0.6]);
  });

  it('rejects a rate outside [0, 1] instead of producing a nonsense interval', () => {
    expect(() => estimatePassRate([0.5, 1.5, 0.5])).toThrow(StatisticsError);
    expect(() => estimatePassRate([0.5, -0.1, 0.5])).toThrow(StatisticsError);
  });

  it('rejects a non-finite rate, naming the offending index', () => {
    expect(() => estimatePassRate([0.5, Number.NaN, 0.5])).toThrow(/attemptRates\[1\]/);
    expect(() => estimatePassRate([0.5, Number.POSITIVE_INFINITY, 0.5])).toThrow(StatisticsError);
  });

  it('formats as percentage points, the way the public boards print it', () => {
    expect(formatMeanSem(estimateOf([0.4, 0.5, 0.6]))).toBe('50.0% ± 5.77');
  });
});

describe('one attempt over a task set', () => {
  it('is the fraction of tasks that passed', () => {
    expect(attemptRate([true, true, false, false])).toBe(0.5);
  });

  it('is null for an empty task set, not zero', () => {
    // Zero of zero tasks passing is not a failure, and rendering it as 0% would read
    // as a total failure to anyone quoting the number.
    expect(attemptRate([])).toBeNull();
  });
});

describe('detecting a headline taken from the best attempt', () => {
  it('flags a mean that equals the max when the attempts actually differ', () => {
    // The failure this is aimed at: a result.json whose headline was filled in by
    // hand from the run that went best.
    expect(looksLikeMaxOverN(0.6, [0.4, 0.5, 0.6])).toBe(true);
  });

  it('does not flag the honest mean', () => {
    expect(looksLikeMaxOverN(0.5, [0.4, 0.5, 0.6])).toBe(false);
  });

  it('does not accuse anyone when every attempt is identical', () => {
    // With zero variance the mean and the max coincide legitimately, so reporting the
    // max is reporting the mean. Flagging it would be a false positive on a
    // deterministic suite.
    expect(looksLikeMaxOverN(0.5, [0.5, 0.5, 0.5])).toBe(false);
  });

  it('says nothing about a single attempt, where there is no max to prefer', () => {
    expect(looksLikeMaxOverN(0.5, [0.5])).toBe(false);
    expect(looksLikeMaxOverN(0.5, [])).toBe(false);
  });
});

describe('solves per million completion tokens', () => {
  it('is solves divided by completion tokens in millions', () => {
    expect(solvesPerMillionCompletionTokens(50, 2_000_000)).toBe(25);
  });

  it('is null when no completion tokens were recorded', () => {
    // Dividing by zero would render as an unbeatable score rather than as missing
    // data, and this is a headline metric.
    expect(solvesPerMillionCompletionTokens(50, 0)).toBeNull();
    expect(solvesPerMillionCompletionTokens(50, -1)).toBeNull();
  });
});
