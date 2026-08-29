import type { ApplyTelemetry, ProposedEdit } from '@adze/protocol';
import { describe, expect, it } from 'vitest';
import { highlightSpans, locateUnique, planRevert } from '../src/edits/locate.js';

function telemetry(overrides: Partial<ApplyTelemetry> = {}): ApplyTelemetry {
  return {
    tier: 'search-replace',
    strategy: 'exact',
    validation: { ok: true, validator: 'tree-sitter' },
    durationMs: 1,
    tiersAttempted: 1,
    editCount: 1,
    bytesChanged: 4,
    ...overrides,
  };
}

function proposal(edits: ProposedEdit['edits']): ProposedEdit {
  return { editId: 'e1', path: 'src/a.ts', edits };
}

describe('locateUnique', () => {
  it('finds a single occurrence', () => {
    const outcome = locateUnique('const a = 1;\nconst b = 2;\n', 'const b = 2;');
    expect(outcome).toEqual({ ok: true, span: { start: 13, end: 25 } });
  });

  it('refuses when the text appears more than once', () => {
    const outcome = locateUnique('x();\nx();\n', 'x();');
    expect(outcome).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('reports a missing needle', () => {
    expect(locateUnique('abc', 'def')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('refuses an empty needle instead of matching at offset zero', () => {
    // A deletion's replacement text is empty, and no position identifies where the
    // deleted text used to be.
    expect(locateUnique('abc', '')).toEqual({ ok: false, reason: 'not-derivable' });
  });
});

describe('planRevert', () => {
  it('inverts a single search/replace edit', () => {
    const text = 'function f() {\n  return 2;\n}\n';
    const plan = planRevert(
      text,
      proposal([{ search: 'return 1;', replace: 'return 2;' }]),
      telemetry(),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.operations).toHaveLength(1);
    const [operation] = plan.operations;
    expect(text.slice(operation?.span.start, operation?.span.end)).toBe('return 2;');
    expect(operation?.original).toBe('return 1;');
  });

  it('orders operations descending by offset so a caller need not adjust', () => {
    const text = 'aaa\nZZZ\nbbb\nYYY\n';
    const plan = planRevert(
      text,
      proposal([
        { search: 'xxx', replace: 'ZZZ' },
        { search: 'www', replace: 'YYY' },
      ]),
      telemetry({ editCount: 2 }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.operations.map((operation) => operation.span.start)).toEqual([12, 4]);
  });

  it('refuses rather than guessing when the replacement is ambiguous', () => {
    const plan = planRevert(
      'log();\nlog();\n',
      proposal([{ search: 'debug();', replace: 'log();' }]),
      telemetry(),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('ambiguous');
    expect(plan.message).toContain('more than once');
    // The message has to say what to do instead.
    expect(plan.message).toContain('Undo');
  });

  it('refuses when the inserted text is no longer present', () => {
    const plan = planRevert(
      'something else entirely',
      proposal([{ search: 'a', replace: 'b' }]),
      telemetry(),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('not-found');
  });

  it('refuses a whole-file rewrite, whose original content is not derivable', () => {
    const plan = planRevert(
      'new contents',
      proposal([{ search: 'old', replace: 'new' }]),
      telemetry({ tier: 'whole-file', strategy: undefined }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('whole-file');
  });

  it('refuses a fast-apply rewrite for the same reason', () => {
    const plan = planRevert(
      'new contents',
      proposal([{ search: 'old', replace: 'new' }]),
      telemetry({ tier: 'fast-apply' }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('whole-file');
  });

  it('refuses a deletion, because the protocol does not carry where the text was', () => {
    const plan = planRevert(
      'kept\n',
      proposal([{ search: 'removed\n', replace: '' }]),
      telemetry(),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('not-derivable');
  });

  it('inverts an insertion at the top of a file', () => {
    const text = '// header\nconst a = 1;\n';
    const plan = planRevert(text, proposal([{ search: '', replace: '// header\n' }]), telemetry());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.operations[0]?.original).toBe('');
    expect(plan.operations[0]?.span).toEqual({ start: 0, end: 10 });
  });

  it('refuses overlapping spans instead of applying them in sequence', () => {
    // Both blocks resolve inside the same region: "abcd" contains "abc" and "bcd".
    const plan = planRevert(
      'abcd',
      proposal([
        { search: 'p', replace: 'abc' },
        { search: 'q', replace: 'bcd' },
      ]),
      telemetry({ editCount: 2 }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('overlapping');
  });

  it('refuses a proposal with no blocks', () => {
    const plan = planRevert('anything', proposal([]), telemetry({ editCount: 0 }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('not-derivable');
  });
});

describe('highlightSpans', () => {
  it('locates what it can and counts what it cannot', () => {
    const result = highlightSpans(
      'alpha\nbeta\n',
      proposal([
        { search: 'x', replace: 'beta' },
        { search: 'y', replace: 'missing' },
      ]),
    );
    expect(result.spans).toEqual([{ start: 6, end: 10 }]);
    expect(result.unlocated).toEqual(['not-found']);
  });

  it('skips a deletion rather than highlighting the whole file', () => {
    const result = highlightSpans('alpha\n', proposal([{ search: 'beta\n', replace: '' }]));
    expect(result.spans).toEqual([]);
    expect(result.unlocated).toEqual(['not-derivable']);
  });
});
