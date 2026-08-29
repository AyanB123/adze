/**
 * The status bar: which model is in force, and what the last run cost.
 *
 * The token split and the cache hit rate are reported together, every time, because
 * a cost figure without the hit rate cannot be checked — the same total can come
 * from a cold run at full rate or a warm one at a tenth of it, and those are
 * different facts about the tool. Cache economics move effective cost by more than
 * 10×, which is why the split is in the protocol rather than left to each surface.
 *
 * **An unpriced model reports `unknown`, never `$0.00`.** Every local and
 * OpenAI-compatible endpoint is unpriced, and zero would read as free.
 *
 * Pure formatting. The text goes into a status bar item elsewhere.
 */

import type { Cost, StopReason, Usage } from '@adze/protocol';

export interface StatusPresentation {
  /** Status bar label. May contain codicons in `$(name)` form. */
  readonly text: string;
  readonly tooltip: string;
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * Six decimal places, because a cheap model on a short task costs less than a cent
 * and `$0.00` for a real charge makes the number useless for the comparison it
 * exists to support.
 */
function money(amount: number, currency: string): string {
  return `${amount.toFixed(6)} ${currency}`;
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

/** `provider/model`, or a plain marker when nothing is configured yet. */
export function modelLabel(model: string | undefined): string {
  return model === undefined || model.trim() === '' ? 'no model' : model;
}

export function idleStatus(model: string | undefined): StatusPresentation {
  return {
    text: `$(sparkle) Adze: ${modelLabel(model)}`,
    tooltip: `Adze is idle. Model: ${modelLabel(model)}.`,
  };
}

export function runningStatus(model: string | undefined, steps: number): StatusPresentation {
  return {
    text: `$(loading~spin) Adze: step ${steps}`,
    tooltip: `Adze is running on ${modelLabel(model)}. Step ${steps}.`,
  };
}

export function blockedStatus(summary: string): StatusPresentation {
  return { text: '$(error) Adze: not configured', tooltip: summary };
}

export interface FinishedRun {
  readonly model: string | undefined;
  readonly stopReason: StopReason;
  readonly steps: number;
  readonly usage: Usage;
  /** Undefined when the price table has no rates for the model. */
  readonly cost: Cost | undefined;
  readonly droppedEvents: number;
}

function usageLines(usage: Usage): readonly string[] {
  return [
    // The split, not a single total. Folding cached tokens into input double-counts
    // them and makes the cost below diverge from the invoice by the cache discount.
    `input (full rate): ${count(usage.inputTokens)}`,
    `input (cached):    ${count(usage.cachedInputTokens)}`,
    `output:            ${count(usage.outputTokens)}`,
    ...(usage.reasoningTokens === undefined
      ? []
      : [`  of which reasoning: ${count(usage.reasoningTokens)}`]),
    `cache hit rate:    ${percent(usage.cacheHitRate)}`,
  ];
}

function costLines(cost: Cost | undefined): readonly string[] {
  if (cost === undefined) {
    return [
      'cost: unknown',
      'No prices for this model in the table, so no cost is reported.',
      'Zero would read as free; add rates to packages/providers/src/catalog.json.',
    ];
  }
  return [
    `cost (input):  ${money(cost.inputUsd, cost.currency)}`,
    `cost (cached): ${money(cost.cachedInputUsd, cost.currency)}`,
    `cost (output): ${money(cost.outputUsd, cost.currency)}`,
    `cost (total):  ${money(cost.totalUsd, cost.currency)}`,
  ];
}

const STOP_ICONS: Record<StopReason, string> = {
  'end-turn': '$(check)',
  'max-steps': '$(watch)',
  'budget-exhausted': '$(watch)',
  cancelled: '$(circle-slash)',
  // A refusal is the safety mechanism working, not a crash. Its own icon, so it is
  // not read as an error in the one place a user glances at.
  refused: '$(shield)',
  error: '$(error)',
};

export function finishedStatus(run: FinishedRun): StatusPresentation {
  const total =
    run.cost === undefined ? 'cost unknown' : money(run.cost.totalUsd, run.cost.currency);
  const tooltip = [
    `Adze finished: ${run.stopReason}`,
    `model: ${modelLabel(run.model)}`,
    `steps: ${run.steps}`,
    '',
    ...usageLines(run.usage),
    '',
    ...costLines(run.cost),
    ...(run.droppedEvents > 0
      ? ['', `${run.droppedEvents} event(s) were dropped; the transcript is incomplete.`]
      : []),
  ].join('\n');

  return {
    text: `${STOP_ICONS[run.stopReason]} Adze: ${total} · ${percent(run.usage.cacheHitRate)} cached`,
    tooltip,
  };
}
