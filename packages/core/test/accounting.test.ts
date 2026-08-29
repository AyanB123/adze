import { describe, expect, it } from 'vitest';
import { BudgetTracker } from '../src/budget.js';
import { addUsage, computeCost, type PriceSheet, totalTokens, ZERO_USAGE } from '../src/cost.js';
import { EventLog, TurnEmitter } from '../src/events.js';
import { randomIdFactory, sequentialIdFactory } from '../src/ids.js';

const PRICES: PriceSheet = {
  currency: 'USD',
  inputPerMTok: 3,
  cachedInputPerMTok: 0.3,
  outputPerMTok: 15,
};

describe('cost accounting', () => {
  it('prices the cache split separately', () => {
    const cost = computeCost(
      {
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheHitRate: 0.5,
      },
      PRICES,
    );
    expect(cost.inputUsd).toBeCloseTo(3, 10);
    expect(cost.cachedInputUsd).toBeCloseTo(0.3, 10);
    expect(cost.outputUsd).toBeCloseTo(15, 10);
    expect(cost.totalUsd).toBeCloseTo(18.3, 10);
  });

  it('does not bill reasoning tokens twice', () => {
    // Providers that report them bill them within the output count.
    const withReasoning = computeCost(
      {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
        reasoningTokens: 500_000,
        cacheHitRate: 0,
      },
      PRICES,
    );
    expect(withReasoning.totalUsd).toBeCloseTo(15, 10);
  });

  it('adds usage and recomputes the rate from the sum', () => {
    const total = addUsage(
      { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, cacheHitRate: 0 },
      { inputTokens: 100, cachedInputTokens: 39_900, outputTokens: 10, cacheHitRate: 0.9975 },
    );
    // Averaging the two rates would give ~0.499; weighting by tokens gives 39900/40100.
    expect(total.cacheHitRate).toBeCloseTo(39_900 / 40_100, 10);
  });

  it('sums reasoning tokens only when present', () => {
    expect(addUsage(ZERO_USAGE, ZERO_USAGE).reasoningTokens).toBeUndefined();
    expect(addUsage(ZERO_USAGE, { ...ZERO_USAGE, reasoningTokens: 5 }).reasoningTokens).toBe(5);
  });

  it('counts cached prompt tokens in the total', () => {
    // Cheaper, not free, and they still occupy the context window: excluding them would
    // let a token budget be satisfied by a conversation that no longer fits.
    expect(
      totalTokens({ inputTokens: 1, cachedInputTokens: 2, outputTokens: 3, cacheHitRate: 0 }),
    ).toBe(6);
  });
});

describe('BudgetTracker', () => {
  it('is unexhausted with no budget at all', () => {
    const tracker = new BudgetTracker({}, undefined);
    tracker.recordStep();
    tracker.recordUsage({
      inputTokens: 1e9,
      cachedInputTokens: 0,
      outputTokens: 1e9,
      cacheHitRate: 0,
    });
    expect(tracker.check()).toBeUndefined();
  });

  it('flags an unenforceable spend budget rather than ignoring it', () => {
    expect(new BudgetTracker({ maxSpendUsd: 1 }, undefined).spendUnenforceable).toBe(true);
    expect(new BudgetTracker({ maxSpendUsd: 1 }, PRICES).spendUnenforceable).toBe(false);
    expect(new BudgetTracker({}, undefined).spendUnenforceable).toBe(false);
  });

  it('reports steps before tokens when both are exhausted', () => {
    // A fixed order so a trajectory that crosses two ceilings on the same step still
    // attributes the stop the same way on a rerun.
    const tracker = new BudgetTracker({ maxSteps: 1, maxTokens: 1 }, undefined);
    tracker.recordStep();
    tracker.recordUsage({ inputTokens: 5, cachedInputTokens: 0, outputTokens: 5, cacheHitRate: 0 });
    expect(tracker.check()?.kind).toBe('steps');
  });

  it('maps steps to max-steps and the rest to budget-exhausted', () => {
    const steps = new BudgetTracker({ maxSteps: 1 }, undefined);
    steps.recordStep();
    expect(steps.check()?.stopReason).toBe('max-steps');

    const tokens = new BudgetTracker({ maxTokens: 5 }, undefined);
    tokens.recordUsage({ inputTokens: 5, cachedInputTokens: 0, outputTokens: 1, cacheHitRate: 0 });
    expect(tokens.check()?.stopReason).toBe('budget-exhausted');
  });

  it('tracks wall clock against an injected clock', () => {
    let now = 0;
    const tracker = new BudgetTracker({ maxWallClockMs: 100 }, undefined, { now: () => now });
    now = 50;
    expect(tracker.check()).toBeUndefined();
    expect(tracker.remainingWallClockMs()).toBe(50);
    now = 150;
    expect(tracker.check()?.kind).toBe('wall-clock');
    expect(tracker.remainingWallClockMs()).toBe(0);
  });

  it('returns undefined remaining time when the clock is unbounded', () => {
    expect(new BudgetTracker({}, undefined).remainingWallClockMs()).toBeUndefined();
  });

  it('computes spend only when prices exist', () => {
    const priced = new BudgetTracker({ maxSpendUsd: 100 }, PRICES);
    priced.recordUsage({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      cacheHitRate: 0,
    });
    expect(priced.spendUsd).toBeCloseTo(3, 10);
    expect(new BudgetTracker({}, undefined).spendUsd).toBe(0);
  });

  it('includes the limit and the observed value in the message', () => {
    const tracker = new BudgetTracker({ maxSteps: 2 }, undefined);
    tracker.recordStep();
    tracker.recordStep();
    const exhausted = tracker.check();
    expect(exhausted?.limit).toBe(2);
    expect(exhausted?.observed).toBe(2);
    expect(exhausted?.message).toContain('2 of 2');
  });
});

describe('id factories', () => {
  it('sequential ids are deterministic per prefix', () => {
    const next = sequentialIdFactory();
    expect([next('t'), next('t'), next('s')]).toEqual(['t_1', 't_2', 's_1']);
  });

  it('random ids are prefixed and unique', () => {
    const next = randomIdFactory();
    const ids = new Set(Array.from({ length: 500 }, () => next('x')));
    expect(ids.size).toBe(500);
    expect([...ids].every((id) => id.startsWith('x_'))).toBe(true);
  });
});

describe('EventLog and TurnEmitter', () => {
  it('assigns contiguous sequence numbers per turn', () => {
    const log = new EventLog();
    const a = new TurnEmitter(log.sink, 's', 't1');
    const b = new TurnEmitter(log.sink, 's', 't2');
    a.turnStarted('m', 0, []);
    b.turnStarted('m', 0, []);
    a.textDelta('x');
    b.textDelta('y');
    expect(log.ofType('text.delta').map((e) => [e.turnId, e.seq])).toEqual([
      ['t1', 1],
      ['t2', 1],
    ]);
    expect(log.sequenceIsContiguous()).toBe(true);
  });

  it('does not burn a sequence number on an empty delta', () => {
    const log = new EventLog();
    const emitter = new TurnEmitter(log.sink, 's', 't');
    emitter.textDelta('');
    emitter.textDelta('real');
    expect(log.all()).toHaveLength(1);
    expect(log.all()[0]?.seq).toBe(0);
  });

  it('stamps session and turn on every event', () => {
    const log = new EventLog();
    const emitter = new TurnEmitter(log.sink, 'sess', 'turn');
    emitter.turnStarted('m', 0, []);
    emitter.turnCompleted('end-turn', 'm', ZERO_USAGE, 1);
    expect(log.all().every((e) => e.sessionId === 'sess' && e.turnId === 'turn')).toBe(true);
  });

  it('reports a broken sequence', () => {
    // The guard behind the guard: a surface relies on contiguity to notice a dropped
    // event, so the checker itself has to be able to fail.
    const log = new EventLog();
    log.sink({
      type: 'text.delta',
      sessionId: 's',
      turnId: 't',
      seq: 5,
      text: 'out of order',
    });
    expect(log.sequenceIsContiguous()).toBe(false);
  });
});
