import { describe, expect, it } from 'vitest';
import { blocksRun, describeProblems, resolveSettings } from '../src/settings.js';
import { fakeConfiguration } from './fake-vscode.js';

describe('resolveSettings', () => {
  it('uses the documented defaults when nothing is set', () => {
    const { settings, problems } = resolveSettings(fakeConfiguration({}));
    expect(problems).toEqual([]);
    expect(settings.sandbox.mode).toBe('workspace-write');
    expect(settings.approvals).toBe('on-request');
    expect(settings.budget).toEqual({});
    expect(settings.modelRef).toBeUndefined();
    expect(settings.inlineCompletion.enabled).toBe(false);
  });

  it('narrows an unrecognised approval policy to never, not to the default', () => {
    // A typo must not resolve to a policy that can grant. `on-request` prompts and can
    // be answered yes; `never` refuses. Narrowing is the only safe direction.
    const { settings, problems } = resolveSettings(
      fakeConfiguration({ 'approvals.policy': 'nevr' }),
    );
    expect(settings.approvals).toBe('never');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.key).toBe('adze.approvals.policy');
  });

  it('narrows an unrecognised sandbox mode to read-only', () => {
    const { settings, problems } = resolveSettings(
      fakeConfiguration({ 'sandbox.mode': 'workspace-writeee' }),
    );
    expect(settings.sandbox.mode).toBe('read-only');
    expect(problems).toHaveLength(1);
  });

  it('accepts every legal sandbox mode and approval policy', () => {
    for (const mode of ['read-only', 'workspace-write', 'full-access'] as const) {
      const resolved = resolveSettings(fakeConfiguration({ 'sandbox.mode': mode }));
      expect(resolved.settings.sandbox.mode).toBe(mode);
      expect(resolved.problems).toEqual([]);
    }
    for (const policy of ['untrusted', 'on-request', 'never'] as const) {
      const resolved = resolveSettings(fakeConfiguration({ 'approvals.policy': policy }));
      expect(resolved.settings.approvals).toBe(policy);
      expect(resolved.problems).toEqual([]);
    }
  });

  it('omits an absent budget rather than defaulting it to zero', () => {
    const { settings } = resolveSettings(
      fakeConfiguration({ 'budget.maxSteps': null, 'budget.maxTokens': null }),
    );
    // Absent means unbounded. A zero ceiling would stop the turn immediately.
    expect(settings.budget).toEqual({});
    expect('maxSteps' in settings.budget).toBe(false);
  });

  it('rejects zero for a step budget instead of reading it as unbounded', () => {
    const { settings, problems } = resolveSettings(fakeConfiguration({ 'budget.maxSteps': 0 }));
    expect(settings.budget.maxSteps).toBeUndefined();
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('positive integer');
  });

  it('accepts zero for a spend budget, where it legitimately means "no spend"', () => {
    const { settings, problems } = resolveSettings(fakeConfiguration({ 'budget.maxSpendUsd': 0 }));
    expect(settings.budget.maxSpendUsd).toBe(0);
    expect(problems).toEqual([]);
  });

  it('reports a non-numeric budget rather than ignoring it', () => {
    const { problems } = resolveSettings(fakeConfiguration({ 'budget.maxTokens': 'lots' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.key).toBe('adze.budget.maxTokens');
  });

  it('rejects a fractional step budget', () => {
    const { problems } = resolveSettings(fakeConfiguration({ 'budget.maxSteps': 2.5 }));
    expect(problems).toHaveLength(1);
  });

  it('treats an empty model or instructions string as unset', () => {
    const { settings } = resolveSettings(fakeConfiguration({ model: '   ', instructions: '' }));
    expect(settings.modelRef).toBeUndefined();
    expect(settings.instructions).toBeUndefined();
  });

  it('trims a model reference', () => {
    const { settings } = resolveSettings(fakeConfiguration({ model: ' anthropic/x ' }));
    expect(settings.modelRef).toBe('anthropic/x');
  });

  it('falls back on an out-of-range debounce and says so', () => {
    const { settings, problems } = resolveSettings(
      fakeConfiguration({ 'inlineCompletion.debounceMs': 10 }),
    );
    expect(settings.inlineCompletion.debounceMs).toBe(500);
    expect(problems).toHaveLength(1);
  });

  it('blocks the run while any setting is invalid', () => {
    const bad = resolveSettings(fakeConfiguration({ 'budget.maxSteps': -4 }));
    expect(blocksRun(bad)).toBe(true);
    const good = resolveSettings(fakeConfiguration({ 'budget.maxSteps': 4 }));
    expect(blocksRun(good)).toBe(false);
  });

  it('describes every problem with its fully qualified key', () => {
    const { problems } = resolveSettings(
      fakeConfiguration({ 'budget.maxSteps': 0, 'approvals.policy': 'sometimes' }),
    );
    const described = describeProblems(problems);
    expect(described).toContain('adze.budget.maxSteps');
    expect(described).toContain('adze.approvals.policy');
    expect(described.split('\n')).toHaveLength(2);
  });

  it('leaves writable roots empty, since widening writes is not configurable yet', () => {
    const { settings } = resolveSettings(fakeConfiguration({}));
    expect(settings.sandbox.writableRoots).toEqual([]);
    expect(settings.sandbox.allowedNetworkHosts).toEqual([]);
    expect(settings.sandbox.commandRules).toEqual([]);
  });
});
