/**
 * Usage mapping, and the one arithmetic mistake that would corrupt every cost figure.
 *
 * The AI SDK reports `inputTokens` as the **total** prompt size, with the cache split
 * in `inputTokenDetails`. Every one of the three providers builds it that way — the
 * Anthropic adapter sums `input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens`, and the OpenAI adapters take the prompt total and derive
 * `noCache` by subtraction.
 *
 * `@adze/protocol`'s {@link Usage} means something different: `inputTokens` and
 * `cachedInputTokens` are **disjoint**, so the prompt is their sum. Copying the SDK's
 * `inputTokens` straight across therefore counts every cached token twice — once at
 * the full rate and once at the cache rate. Cache reads run about 10% of input, and
 * the steady-state target is a hit rate above 85%, so at that hit rate the naive
 * mapping reports roughly 1.85× the real prompt cost. It would look plausible. It
 * would be wrong in the direction that flatters nobody and matches no invoice.
 *
 * So: `cachedInputTokens` is the cache **read** count, and `inputTokens` is
 * everything else in the prompt.
 *
 * ### Where cache writes go, and what that costs us
 *
 * Cache *writes* are a third bucket in the SDK and the protocol has no field for one.
 * They are billed above the base input rate — Anthropic charges 1.25× for a 5-minute
 * write and 2× for an hour, OpenAI 1.25× where it charges at all — so they belong in
 * the full-rate bucket rather than the discounted one. Folding them into
 * `inputTokens` prices them at 1.0× instead of 1.25×, which makes reported cost a
 * **lower bound on the step that opens a cache epoch and exact on every step after
 * it**. That residual is stated in `catalog.json` under `notModelled` and is bounded:
 * at most 0.25× the write tokens' base cost, once per epoch.
 *
 * Deriving `inputTokens` as `total - cacheRead` rather than as `noCache + cacheWrite`
 * is deliberate. Both are correct for all three current adapters, but subtraction
 * from the total also holds for a future adapter that reports a total and a read
 * count without breaking out writes, and it can never produce a prompt total that
 * disagrees with the provider's.
 */

import { makeUsage, type Usage } from '@adze/protocol';

/**
 * The shape this module consumes.
 *
 * Declared structurally rather than imported as `LanguageModelUsage` so the mapping
 * is testable against a literal and does not depend on the SDK's type being
 * constructible by hand. Every field is optional because the SDK types them as
 * `number | undefined` — a provider that reports no usage at all is a real case, and
 * one that must produce zeroes rather than `NaN`.
 */
export interface SdkUsage {
  readonly inputTokens?: number | undefined;
  readonly inputTokenDetails?:
    | {
        readonly noCacheTokens?: number | undefined;
        readonly cacheReadTokens?: number | undefined;
        readonly cacheWriteTokens?: number | undefined;
      }
    | undefined;
  readonly outputTokens?: number | undefined;
  readonly outputTokenDetails?:
    | {
        readonly textTokens?: number | undefined;
        readonly reasoningTokens?: number | undefined;
      }
    | undefined;
  readonly totalTokens?: number | undefined;
}

function nonNegative(value: number | undefined): number {
  // Negative or non-finite is treated as absent. A provider reporting -1 for "not
  // measured" must not become a negative cost, and a NaN here propagates silently
  // into a spend budget that can never be exhausted.
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

/**
 * Map the SDK's usage record onto the protocol's disjoint split.
 *
 * `cacheHitRate` is not computed here; {@link makeUsage} derives it from the split so
 * there is exactly one implementation of that ratio in the codebase.
 */
export function toProtocolUsage(usage: SdkUsage | undefined): Usage {
  if (usage === undefined) {
    return makeUsage({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  }

  const details = usage.inputTokenDetails;
  const cachedInputTokens = nonNegative(details?.cacheReadTokens);
  const promptTotal = nonNegative(usage.inputTokens);

  // Subtraction from the total, with the sum of the detail fields as the fallback for
  // a provider that reports details but no total. `Math.max(0, …)` guards the case
  // where a provider's own numbers do not add up: clamping keeps the split disjoint
  // and non-negative, which is what every downstream consumer assumes.
  const derived =
    promptTotal > 0
      ? promptTotal - cachedInputTokens
      : nonNegative(details?.noCacheTokens) + nonNegative(details?.cacheWriteTokens);
  const inputTokens = Math.max(0, derived);

  const reasoningTokens = nonNegative(usage.outputTokenDetails?.reasoningTokens);

  return makeUsage({
    inputTokens,
    cachedInputTokens,
    outputTokens: nonNegative(usage.outputTokens),
    // Reported only when non-zero. `computeCost` deliberately does not add it on top
    // of output — providers bill it inside the output count — so this field is
    // informational, and a stream of explicit zeroes in a trajectory is noise.
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  });
}
