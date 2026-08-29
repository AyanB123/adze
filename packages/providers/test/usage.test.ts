import { describe, expect, it } from 'vitest';
import { toProtocolUsage } from '../src/usage.js';

/**
 * The mapping that decides whether every cost figure in the project is correct.
 *
 * The AI SDK reports `inputTokens` as the whole prompt with the cache split in
 * `inputTokenDetails`; the protocol's `inputTokens` and `cachedInputTokens` are
 * disjoint. Copying the field across counts cached tokens twice, and at the >85%
 * steady-state hit rate the epoch design targets, that overstates prompt cost by
 * roughly 1.85x — plausible-looking and matching no invoice.
 */
describe('toProtocolUsage', () => {
  it('does not count cached tokens twice', () => {
    // Anthropic's adapter shape: total = noCache + cacheWrite + cacheRead.
    const usage = toProtocolUsage({
      inputTokens: 10_000,
      inputTokenDetails: { noCacheTokens: 1_500, cacheReadTokens: 8_000, cacheWriteTokens: 500 },
      outputTokens: 300,
      outputTokenDetails: { textTokens: 300, reasoningTokens: 0 },
      totalTokens: 10_300,
    });

    expect(usage.cachedInputTokens).toBe(8_000);
    // Everything billed at the full rate: uncached prompt plus the cache write.
    expect(usage.inputTokens).toBe(2_000);
    // The two buckets reconstruct the provider's own prompt total exactly.
    expect(usage.inputTokens + usage.cachedInputTokens).toBe(10_000);
    expect(usage.outputTokens).toBe(300);
  });

  it('derives the cache hit rate from the split rather than from a provider field', () => {
    const usage = toProtocolUsage({
      inputTokens: 1_000,
      inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 900 },
      outputTokens: 10,
    });

    expect(usage.cacheHitRate).toBeCloseTo(0.9, 10);
  });

  it('reports a zero hit rate when nothing was cached', () => {
    const usage = toProtocolUsage({ inputTokens: 500, outputTokens: 20 });

    expect(usage.inputTokens).toBe(500);
    expect(usage.cachedInputTokens).toBe(0);
    expect(usage.cacheHitRate).toBe(0);
  });

  it('sums the detail fields when a provider reports no prompt total', () => {
    const usage = toProtocolUsage({
      inputTokenDetails: { noCacheTokens: 120, cacheReadTokens: 80, cacheWriteTokens: 30 },
      outputTokens: 5,
    });

    // noCache + cacheWrite at the full rate, cacheRead discounted.
    expect(usage.inputTokens).toBe(150);
    expect(usage.cachedInputTokens).toBe(80);
  });

  it('reports reasoning tokens only when there are some', () => {
    const withReasoning = toProtocolUsage({
      inputTokens: 10,
      outputTokens: 100,
      outputTokenDetails: { textTokens: 60, reasoningTokens: 40 },
    });
    const without = toProtocolUsage({
      inputTokens: 10,
      outputTokens: 100,
      outputTokenDetails: { textTokens: 100, reasoningTokens: 0 },
    });

    expect(withReasoning.reasoningTokens).toBe(40);
    // Absent rather than an explicit zero: a trajectory full of zeroes is noise, and
    // `computeCost` deliberately does not add reasoning on top of output.
    expect('reasoningTokens' in without).toBe(false);
  });

  it('returns a well-formed zero record when a provider reports no usage at all', () => {
    const usage = toProtocolUsage(undefined);

    expect(usage).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      cacheHitRate: 0,
    });
  });

  it('treats a negative or non-finite count as absent rather than propagating it', () => {
    // A provider using -1 for "not measured" must not become a negative cost, and a
    // NaN reaching the spend budget makes every comparison false — a ceiling that can
    // never be exhausted.
    const usage = toProtocolUsage({
      inputTokens: Number.NaN,
      inputTokenDetails: { cacheReadTokens: -1 },
      outputTokens: Number.POSITIVE_INFINITY,
    });

    expect(usage.inputTokens).toBe(0);
    expect(usage.cachedInputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(Number.isFinite(usage.cacheHitRate)).toBe(true);
  });

  it('clamps rather than going negative when a provider reports inconsistent numbers', () => {
    // A cache read larger than the reported prompt total cannot be true, but it must
    // not produce a negative input bucket: every consumer assumes both are >= 0.
    const usage = toProtocolUsage({
      inputTokens: 100,
      inputTokenDetails: { cacheReadTokens: 400 },
      outputTokens: 1,
    });

    expect(usage.inputTokens).toBe(0);
    expect(usage.cachedInputTokens).toBe(400);
  });

  it('rounds fractional counts, because a token is not divisible', () => {
    const usage = toProtocolUsage({ inputTokens: 10.4, outputTokens: 3.6 });

    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(4);
  });
});
