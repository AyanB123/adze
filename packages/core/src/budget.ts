/**
 * Budget enforcement.
 *
 * ADR-0003: budgets are explicit, and every one is enforced *and* reported. An
 * unenforced budget is a suggestion, and a budget that is enforced but not
 * reported is indistinguishable from a model that stopped early — which is the
 * failure that makes a trajectory unreadable.
 *
 * Four ceilings, and they map onto two protocol stop reasons rather than one.
 * `max-steps` is separate because it is the budget a user sets on purpose and
 * expects to hit; the other three mean something got away from them. Collapsing
 * them would put a routine ceiling and a runaway in the same bucket.
 */

import type { StopReason, TurnBudget, Usage } from '@adze/protocol';
import { computeCost, type PriceSheet, totalTokens } from './cost.js';

export type BudgetKind = 'steps' | 'tokens' | 'wall-clock' | 'spend';

export interface BudgetExhausted {
  readonly kind: BudgetKind;
  readonly stopReason: StopReason;
  /** Written for a model and a log, in that order: what ran out, and at what. */
  readonly message: string;
  readonly limit: number;
  readonly observed: number;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/**
 * Tracks one turn against its budget.
 *
 * Deliberately a small mutable object rather than a functional fold: the loop
 * checks it in three places (before a model call, after usage arrives, and around
 * tool execution) and threading four counters through those call sites is how one
 * of them ends up not checking.
 */
export class BudgetTracker {
  private steps = 0;
  private usage: Usage;
  private readonly startedAt: number;

  constructor(
    private readonly budget: TurnBudget,
    private readonly prices: PriceSheet | undefined,
    private readonly clock: Clock = systemClock,
  ) {
    this.startedAt = clock.now();
    this.usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cacheHitRate: 0 };
  }

  /**
   * True when a `maxSpendUsd` budget cannot be honoured.
   *
   * The caller must refuse the turn rather than run it: accepting a spend ceiling
   * and then not applying it is exactly the "silently grants more than it says"
   * failure the permission model refuses to make, applied to money.
   */
  get spendUnenforceable(): boolean {
    return this.budget.maxSpendUsd !== undefined && this.prices === undefined;
  }

  recordStep(): void {
    this.steps += 1;
  }

  recordUsage(usage: Usage): void {
    this.usage = usage;
  }

  get stepsTaken(): number {
    return this.steps;
  }

  get elapsedMs(): number {
    return this.clock.now() - this.startedAt;
  }

  get spendUsd(): number {
    return this.prices === undefined ? 0 : computeCost(this.usage, this.prices).totalUsd;
  }

  /**
   * The first exhausted ceiling, or `undefined`.
   *
   * Checked in a fixed order so the reported reason is stable across runs. Two
   * ceilings can be crossed by the same step, and a trajectory that attributes the
   * stop to whichever check happened to run first is not diffable.
   */
  check(): BudgetExhausted | undefined {
    const { maxSteps, maxTokens, maxWallClockMs, maxSpendUsd } = this.budget;

    if (maxSteps !== undefined && this.steps >= maxSteps) {
      return {
        kind: 'steps',
        stopReason: 'max-steps',
        message: `step budget exhausted: ${this.steps} of ${maxSteps} model round-trips used`,
        limit: maxSteps,
        observed: this.steps,
      };
    }

    const tokens = totalTokens(this.usage);
    if (maxTokens !== undefined && tokens >= maxTokens) {
      return {
        kind: 'tokens',
        stopReason: 'budget-exhausted',
        message: `token budget exhausted: ${tokens} of ${maxTokens} tokens used (input + cached input + output)`,
        limit: maxTokens,
        observed: tokens,
      };
    }

    const elapsed = this.elapsedMs;
    if (maxWallClockMs !== undefined && elapsed >= maxWallClockMs) {
      return {
        kind: 'wall-clock',
        stopReason: 'budget-exhausted',
        message: `wall-clock budget exhausted: ${elapsed} ms of ${maxWallClockMs} ms used`,
        limit: maxWallClockMs,
        observed: elapsed,
      };
    }

    if (maxSpendUsd !== undefined) {
      const spend = this.spendUsd;
      if (spend >= maxSpendUsd) {
        return {
          kind: 'spend',
          stopReason: 'budget-exhausted',
          message: `spend budget exhausted: ${spend.toFixed(6)} of ${maxSpendUsd.toFixed(6)} USD used`,
          limit: maxSpendUsd,
          observed: spend,
        };
      }
    }

    return undefined;
  }

  /** Milliseconds left on the wall clock, or `undefined` when unbounded. */
  remainingWallClockMs(): number | undefined {
    if (this.budget.maxWallClockMs === undefined) return undefined;
    return Math.max(0, this.budget.maxWallClockMs - this.elapsedMs);
  }
}
