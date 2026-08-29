import type { Cost } from '@adze/protocol';
import { makeUsage } from '@adze/protocol';
import { describe, expect, it } from 'vitest';
import {
  blockedStatus,
  finishedStatus,
  idleStatus,
  modelLabel,
  runningStatus,
} from '../src/status.js';

const USAGE = makeUsage({ inputTokens: 1_000, cachedInputTokens: 9_000, outputTokens: 500 });

const COST: Cost = {
  currency: 'USD',
  inputUsd: 0.003,
  cachedInputUsd: 0.0027,
  outputUsd: 0.0075,
  totalUsd: 0.0132,
};

describe('modelLabel', () => {
  it('names the absence of a model rather than showing nothing', () => {
    expect(modelLabel(undefined)).toBe('no model');
    expect(modelLabel('  ')).toBe('no model');
    expect(modelLabel('anthropic/x')).toBe('anthropic/x');
  });
});

describe('idleStatus and runningStatus', () => {
  it('shows the model while idle', () => {
    expect(idleStatus('anthropic/x').text).toContain('anthropic/x');
  });

  it('shows the step count while running', () => {
    const status = runningStatus('anthropic/x', 4);
    expect(status.text).toContain('step 4');
    expect(status.tooltip).toContain('anthropic/x');
  });

  it('reports a configuration problem in the status bar, not silently', () => {
    const status = blockedStatus('adze.budget.maxSteps: 0 is not a positive integer.');
    expect(status.text).toContain('not configured');
    expect(status.tooltip).toContain('adze.budget.maxSteps');
  });
});

describe('finishedStatus', () => {
  it('reports cost as unknown for an unpriced model, never as zero', () => {
    // Every local and OpenAI-compatible endpoint is unpriced. Zero would read as free.
    const status = finishedStatus({
      model: 'ollama/llama',
      stopReason: 'end-turn',
      steps: 2,
      usage: USAGE,
      cost: undefined,
      droppedEvents: 0,
    });
    expect(status.text).toContain('cost unknown');
    expect(status.tooltip).toContain('cost: unknown');
    expect(status.tooltip).not.toContain('0.000000');
  });

  it('reports the token split and the cache hit rate together', () => {
    const status = finishedStatus({
      model: 'anthropic/x',
      stopReason: 'end-turn',
      steps: 3,
      usage: USAGE,
      cost: COST,
      droppedEvents: 0,
    });
    // The split, not one total: folding cached tokens into input double-counts them
    // and makes the cost diverge from the invoice by the cache discount.
    expect(status.tooltip).toContain('input (full rate): 1,000');
    expect(status.tooltip).toContain('input (cached):    9,000');
    expect(status.tooltip).toContain('output:            500');
    expect(status.tooltip).toContain('cache hit rate:    90.0%');
    // A cost figure without the hit rate cannot be checked, so both are in the label.
    expect(status.text).toContain('90.0% cached');
  });

  it('prints enough decimal places for a sub-cent charge to be visible', () => {
    const status = finishedStatus({
      model: 'anthropic/x',
      stopReason: 'end-turn',
      steps: 1,
      usage: USAGE,
      cost: { ...COST, totalUsd: 0.000004 },
      droppedEvents: 0,
    });
    expect(status.text).toContain('0.000004');
  });

  it('separates reasoning tokens when the provider bills them apart', () => {
    const usage = makeUsage({
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 20,
      reasoningTokens: 15,
    });
    const status = finishedStatus({
      model: 'anthropic/x',
      stopReason: 'end-turn',
      steps: 1,
      usage,
      cost: undefined,
      droppedEvents: 0,
    });
    expect(status.tooltip).toContain('of which reasoning: 15');
  });

  it('does not render a refusal as an error', () => {
    const refused = finishedStatus({
      model: 'anthropic/x',
      stopReason: 'refused',
      steps: 1,
      usage: USAGE,
      cost: COST,
      droppedEvents: 0,
    });
    const failed = finishedStatus({
      model: 'anthropic/x',
      stopReason: 'error',
      steps: 1,
      usage: USAGE,
      cost: COST,
      droppedEvents: 0,
    });
    // A refusal is the safety mechanism working. Sharing an icon with a crash would
    // make the two indistinguishable in the one place a user glances at.
    expect(refused.text).not.toBe(failed.text);
    expect(refused.tooltip).toContain('refused');
  });

  it('says the transcript is incomplete when events were dropped', () => {
    const status = finishedStatus({
      model: 'anthropic/x',
      stopReason: 'end-turn',
      steps: 1,
      usage: USAGE,
      cost: COST,
      droppedEvents: 2,
    });
    expect(status.tooltip).toContain('2 event(s) were dropped');
  });

  it('gives every stop reason its own label', () => {
    const reasons = [
      'end-turn',
      'max-steps',
      'budget-exhausted',
      'cancelled',
      'refused',
      'error',
    ] as const;
    for (const stopReason of reasons) {
      const status = finishedStatus({
        model: 'm',
        stopReason,
        steps: 1,
        usage: USAGE,
        cost: undefined,
        droppedEvents: 0,
      });
      expect(status.tooltip).toContain(`Adze finished: ${stopReason}`);
    }
  });
});
