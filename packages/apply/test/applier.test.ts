import { describe, expect, it } from 'vitest';
import { applyEdit } from '../src/applier.js';
import type { ApplyRequest, FastApplyProvider } from '../src/types.js';

function req(over: Partial<ApplyRequest> & Pick<ApplyRequest, 'original' | 'edits'>): ApplyRequest {
  return { path: 'src/x.ts', ...over };
}

describe('applyEdit — tier 1 success', () => {
  it('applies a single exact edit', async () => {
    const r = await applyEdit(
      req({
        original: 'const port = 3000;\nstart(port);\n',
        edits: [{ search: 'const port = 3000;', replace: 'const port = env.PORT ?? 3000;' }],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe('const port = env.PORT ?? 3000;\nstart(port);\n');
    expect(r.telemetry.tier).toBe('search-replace');
    expect(r.telemetry.strategy).toBe('exact');
    expect(r.telemetry.tiersAttempted).toBe(1);
    expect(r.telemetry.validation.ok).toBe(true);
  });

  it('applies sequential edits against the evolving content', async () => {
    const r = await applyEdit(
      req({
        original: 'let a = 1;\nlet b = 2;\n',
        edits: [
          { search: 'let a = 1;', replace: 'const a = 10;' },
          { search: 'let b = 2;', replace: 'const b = 20;' },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe('const a = 10;\nconst b = 20;\n');
    expect(r.telemetry.editCount).toBe(2);
  });

  it('reindents when the model quoted a block from the wrong nesting level', async () => {
    const original = ['class A {', '  run() {', '    return 1;', '  }', '}', ''].join('\n');
    const r = await applyEdit(
      req({
        original,
        edits: [
          {
            search: ['run() {', '  return 1;', '}'].join('\n'),
            replace: ['run() {', '  return 2;', '}'].join('\n'),
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.telemetry.strategy).toBe('indentation-tolerant');
    // Indentation must be restored to the file's actual level, not the model's.
    expect(r.content).toBe(['class A {', '  run() {', '    return 2;', '  }', '}', ''].join('\n'));
  });

  it('prepends when the search block is empty', async () => {
    const r = await applyEdit(
      req({ original: 'b();\n', edits: [{ search: '', replace: 'a();\n' }] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe('a();\nb();\n');
  });
});

describe('applyEdit — refusals', () => {
  it('refuses an ambiguous match instead of picking the first', async () => {
    const r = await applyEdit(
      req({ original: 'x();\ny();\nx();\n', edits: [{ search: 'x();', replace: 'z();' }] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('ambiguous');
    expect(r.message).toContain('matched 2 times');
    expect(r.candidates?.map((c) => c.line)).toEqual([1, 3]);
  });

  it('honors an explicit occurrence selector to resolve ambiguity', async () => {
    const r = await applyEdit(
      req({
        original: 'x();\ny();\nx();\n',
        edits: [{ search: 'x();', replace: 'z();', occurrence: 2 }],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe('x();\ny();\nz();\n');
  });

  it('reports an out-of-range occurrence', async () => {
    const r = await applyEdit(
      req({
        original: 'x();\nx();\n',
        edits: [{ search: 'x();', replace: 'z();', occurrence: 9 }],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not-found');
    expect(r.message).toContain('occurrence 9');
  });

  it('refuses a search block it cannot find, naming the strategies tried', async () => {
    const r = await applyEdit(
      req({ original: 'const a = 1;\n', edits: [{ search: 'const q = 9;', replace: 'x' }] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not-found');
    expect(r.message).toContain('anchored');
  });

  it('detects a no-op edit', async () => {
    const r = await applyEdit(req({ original: 'a;\n', edits: [{ search: 'a;', replace: 'a;' }] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-op');
  });

  it('refuses an edit that would break the file, rather than writing it', async () => {
    // Removing the closing brace leaves the file unparseable. This is the whole
    // point of the package: a refusal, not a corrupted file.
    const r = await applyEdit(
      req({
        original: 'function f() {\n  return 1;\n}\n',
        edits: [{ search: '  return 1;\n}', replace: '  return 1;' }],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('parse-broken');
    expect(r.message).toContain('no longer parses');
  });

  it('refuses a Python edit that drops an indented body', async () => {
    const r = await applyEdit(
      req({
        path: 'src/x.py',
        original: 'def f():\n    return 1\n',
        edits: [{ search: '    return 1', replace: 'return 1' }],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('parse-broken');
  });

  it('can be forced past validation, and records that it was skipped', async () => {
    const r = await applyEdit(
      req({
        original: 'function f() {\n  return 1;\n}\n',
        edits: [{ search: '  return 1;\n}', replace: '  return 1;' }],
      }),
      { skipValidation: true },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.telemetry.validation.validator).toBe('none');
    expect(r.telemetry.validation.message).toContain('skipped');
  });
});

describe('applyEdit — tier escalation', () => {
  it('falls through to whole-file when tier 1 cannot find the block', async () => {
    const r = await applyEdit(
      req({
        original: 'const a = 1;\n',
        edits: [{ search: 'nope', replace: 'x' }],
        replacement: 'const a = 2;\n',
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.telemetry.tier).toBe('whole-file');
    expect(r.telemetry.tiersAttempted).toBe(2);
    expect(r.content).toBe('const a = 2;\n');
  });

  it('validates whole-file output too', async () => {
    const r = await applyEdit(
      req({
        original: 'const a = 1;\n',
        edits: [{ search: 'nope', replace: 'x' }],
        replacement: 'function broken() {\n',
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('parse-broken');
  });

  it('rejects a whole-file replacement over the size limit', async () => {
    const r = await applyEdit(
      req({
        original: 'a;\n',
        edits: [{ search: 'nope', replace: 'x' }],
        replacement: `// ${'x'.repeat(2000)}\n`,
      }),
      { maxWholeFileBytes: 100 },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('file-too-large');
  });

  it('skips the fast-apply tier when no provider is configured', async () => {
    const r = await applyEdit(
      req({ original: 'a;\n', edits: [{ search: 'nope', replace: 'x' }] }),
      { tiers: ['search-replace', 'fast-apply'] },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Only tier 1 actually ran, because tier 3 was unavailable.
    expect(r.telemetry.tiersAttempted).toBe(1);
  });

  it('uses a configured fast-apply provider and validates its output', async () => {
    const provider: FastApplyProvider = {
      name: 'test-provider',
      apply: async () => 'const a = 42;\n',
    };
    const r = await applyEdit(
      req({ original: 'const a = 1;\n', edits: [{ search: 'nope', replace: 'x' }] }),
      { tiers: ['search-replace', 'fast-apply'], fastApplyProvider: provider },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.telemetry.tier).toBe('fast-apply');
    expect(r.content).toBe('const a = 42;\n');
  });

  it('reports a fast-apply provider failure without crashing', async () => {
    const provider: FastApplyProvider = {
      name: 'flaky',
      apply: async () => {
        throw new Error('upstream 503');
      },
    };
    const r = await applyEdit(
      req({ original: 'a;\n', edits: [{ search: 'nope', replace: 'x' }] }),
      { tiers: ['fast-apply'], fastApplyProvider: provider },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('upstream 503');
  });
});

describe('applyEdit — telemetry', () => {
  it('records everything needed for apply-success-rate reporting', async () => {
    const r = await applyEdit(
      req({ original: 'const a = 1;\n', edits: [{ search: 'a = 1', replace: 'a = 2' }] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.telemetry;
    expect(t.tier).toBe('search-replace');
    expect(t.strategy).toBe('exact');
    expect(t.editCount).toBe(1);
    expect(t.tiersAttempted).toBe(1);
    expect(t.durationMs).toBeGreaterThanOrEqual(0);
    expect(t.validation.validator).toBe('structural');
    expect(typeof t.bytesChanged).toBe('number');
  });

  it('reports telemetry on failure too, so refusals are measurable', async () => {
    const r = await applyEdit(req({ original: 'a;\n', edits: [{ search: 'zzz', replace: 'x' }] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.telemetry.tiersAttempted).toBeGreaterThan(0);
    expect(r.telemetry.editCount).toBe(1);
  });
});
