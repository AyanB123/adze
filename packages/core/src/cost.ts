/**
 * Cost accounting.
 *
 * Cost per task is the axis an open-source tool can credibly win, so cost is a
 * first-class engine output rather than a surface's arithmetic. The one thing this
 * file exists to get right is the cache split: cache economics move effective cost
 * by more than 10×, and a total that folds cached tokens in at the full rate
 * diverges from the invoice by that factor.
 *
 * **Prices are injected, never bundled.** A price table compiled into the engine
 * is wrong the week after it ships, and a wrong cost figure is worse than no cost
 * figure because it is quoted. The consequence is deliberate and enforced
 * upstream: a `maxSpendUsd` budget without a price sheet is an error at submit
 * rather than a budget that silently does not apply (ADR-0003 — every budget is
 * enforced).
 */

import type { Cost, Usage } from '@adze/protocol';

/** Per-million-token prices for one model. */
export interface PriceSheet {
  /** ISO 4217. Providers price in USD today; the field exists so that is checkable. */
  readonly currency: string;
  readonly inputPerMTok: number;
  /**
   * Cache *reads*. Typically a fraction of the input rate, which is the entire
   * reason the context assembler works in epochs.
   */
  readonly cachedInputPerMTok: number;
  readonly outputPerMTok: number;
}

const PER_MILLION = 1_000_000;

/**
 * Cost of one usage record.
 *
 * `reasoningTokens` is deliberately not added on top. Providers that report it
 * bill it within the output count, so adding it would double-charge; a provider
 * that ever bills it separately needs its own field, not a silent reinterpretation
 * of this one.
 */
export function computeCost(usage: Usage, prices: PriceSheet): Cost {
  const inputUsd = (usage.inputTokens / PER_MILLION) * prices.inputPerMTok;
  const cachedInputUsd = (usage.cachedInputTokens / PER_MILLION) * prices.cachedInputPerMTok;
  const outputUsd = (usage.outputTokens / PER_MILLION) * prices.outputPerMTok;
  return {
    currency: prices.currency,
    inputUsd,
    cachedInputUsd,
    outputUsd,
    totalUsd: inputUsd + cachedInputUsd + outputUsd,
  };
}

/**
 * Add two usage records, recomputing the cache hit rate from the summed split.
 *
 * Averaging two rates would be wrong whenever the steps differ in size, which is
 * always — a 40-token step and a 40 000-token step do not contribute equally to
 * "what fraction of this turn's prompt was cached".
 */
export function addUsage(a: Usage, b: Usage): Usage {
  const inputTokens = a.inputTokens + b.inputTokens;
  const cachedInputTokens = a.cachedInputTokens + b.cachedInputTokens;
  const reasoning = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  const prompt = inputTokens + cachedInputTokens;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    cacheHitRate: prompt === 0 ? 0 : cachedInputTokens / prompt,
  };
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  cacheHitRate: 0,
};

/**
 * Every token the turn touched.
 *
 * Cached prompt tokens are counted. They are cheaper, not free, and they still
 * occupy the context window — excluding them would let a `maxTokens` budget be
 * satisfied by a conversation that no longer fits in the model.
 */
export function totalTokens(usage: Usage): number {
  return usage.inputTokens + usage.cachedInputTokens + usage.outputTokens;
}
