/**
 * The end-of-run summary: usage, cost, and cache hit rate.
 *
 * All three, every time, and cache hit rate is not a footnote. Cache economics move
 * effective cost by more than 10×, which makes a cost figure without the hit rate
 * unverifiable — the same total can come from a cold run at full rate or a warm one at a
 * tenth of it, and those are different facts about the tool. ADR-0011 makes the split a
 * first-class metric for exactly that reason, and `solves per million completion tokens` a
 * headline rather than an appendix.
 *
 * **An unpriced model reports `unknown`, never `$0.00`.** Every local endpoint is unpriced,
 * and printing zero would read as free.
 */

import { computeCost, type PriceSheet, totalTokens } from '@adze/core';
import type { ModelSelection, StopReason, Usage } from '@adze/protocol';
import { field, type Io, type Style } from '../output.js';

export interface RunSummary {
  readonly model: ModelSelection;
  readonly stopReason: StopReason;
  readonly steps: number;
  readonly usage: Usage;
  /** `undefined` when the price table has no rates for the model. */
  readonly prices: PriceSheet | undefined;
  readonly durationMs: number;
  readonly approvals: number;
  /** Non-zero means events were lost and the transcript is incomplete. */
  readonly droppedEvents: number;
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * Format a cost.
 *
 * Six decimal places because a cheap model on a short task costs less than a cent, and
 * `$0.00` for a real charge is the kind of rounding that makes a cost report useless for
 * the comparison it exists to support.
 */
function usd(amount: number, currency: string): string {
  return `${amount.toFixed(6)} ${currency}`;
}

/** The machine-readable form. Same numbers, no rendering decisions. */
export function summaryJson(summary: RunSummary): Record<string, unknown> {
  const cost =
    summary.prices === undefined ? undefined : computeCost(summary.usage, summary.prices);
  return {
    model: summary.model,
    stopReason: summary.stopReason,
    steps: summary.steps,
    durationMs: summary.durationMs,
    approvalsRequested: summary.approvals,
    usage: {
      ...summary.usage,
      totalTokens: totalTokens(summary.usage),
    },
    // Explicitly null rather than absent, so a consumer can tell "no rates for this model"
    // from "the field was not emitted".
    cost: cost ?? null,
    costKnown: cost !== undefined,
    ...(summary.droppedEvents > 0 ? { droppedEvents: summary.droppedEvents } : {}),
  };
}

export function renderSummary(summary: RunSummary, io: Io, style: Style): void {
  const { usage } = summary;
  const cost = summary.prices === undefined ? undefined : computeCost(usage, summary.prices);

  io.err(`\n${style.bold('Summary')}\n`);
  io.err(`${field('model', `${summary.model.provider}/${summary.model.model}`)}\n`);
  io.err(`${field('stop reason', summary.stopReason)}\n`);
  io.err(`${field('steps', String(summary.steps))}\n`);
  io.err(`${field('wall clock', `${(summary.durationMs / 1000).toFixed(1)}s`)}\n`);

  io.err(`\n${style.bold('Tokens')}\n`);
  // The split, not a single total. Folding cached tokens into input double-counts them and
  // makes the cost below diverge from the invoice by the cache discount.
  io.err(`${field('input (full rate)', usage.inputTokens.toLocaleString('en-US'))}\n`);
  io.err(`${field('input (cached)', usage.cachedInputTokens.toLocaleString('en-US'))}\n`);
  io.err(`${field('output', usage.outputTokens.toLocaleString('en-US'))}\n`);
  if (usage.reasoningTokens !== undefined) {
    io.err(`${field('  of which reasoning', usage.reasoningTokens.toLocaleString('en-US'))}\n`);
  }
  io.err(`${field('total', totalTokens(usage).toLocaleString('en-US'))}\n`);
  io.err(`${field('cache hit rate', percent(usage.cacheHitRate))}\n`);

  io.err(`\n${style.bold('Cost')}\n`);
  if (cost === undefined) {
    // Named, with the reason and the fix. A price table that silently reports zero for an
    // unpriced model is worse than one that admits it does not know.
    io.err(`${field('total', style.warn('unknown'))}\n`);
    io.err(
      `\n  ${style.dim(`No prices for '${summary.model.provider}/${summary.model.model}' in the table.`)}\n` +
        `  ${style.dim('Add them to packages/providers/src/catalog.json — it is data, not code.')}\n`,
    );
  } else {
    io.err(`${field('input (full rate)', usd(cost.inputUsd, cost.currency))}\n`);
    io.err(`${field('input (cached)', usd(cost.cachedInputUsd, cost.currency))}\n`);
    io.err(`${field('output', usd(cost.outputUsd, cost.currency))}\n`);
    io.err(`${field('total', style.bold(usd(cost.totalUsd, cost.currency)))}\n`);
    if (usage.cachedInputTokens > 0) {
      io.err(
        `\n  ${style.dim('Cache writes are billed above the base input rate and the protocol has no')}\n` +
          `  ${style.dim('bucket for them, so this total is a lower bound on the step that opened the')}\n` +
          `  ${style.dim('cache epoch and exact after it. See packages/providers/README.md.')}\n`,
      );
    }
  }

  if (summary.approvals > 0) {
    io.err(`\n${field('approvals requested', String(summary.approvals))}\n`);
  }
  if (summary.droppedEvents > 0) {
    // Reported, not smoothed over: a partial transcript is indistinguishable from a model
    // that stopped early unless the gap is named.
    io.err(
      `\n${style.bad(`${summary.droppedEvents} event(s) were dropped; this transcript is incomplete.`)}\n`,
    );
  }
}
