import { describe, expect, it } from 'vitest';
import type { CommandCompleted } from '../src/broker.js';
import {
  extractFailureLines,
  renderCommandResult,
  renderSpawnFailure,
  summarizeCommand,
} from '../src/test-feedback.js';

function completed(over: Partial<CommandCompleted> = {}): CommandCompleted {
  return {
    kind: 'completed',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    cancelled: false,
    outputCapped: false,
    durationMs: 12,
    enforcement: 'gate-only',
    ...over,
  };
}

const VITEST_OUTPUT = [
  ' RUN  v4.1.11',
  '',
  ' ❯ test/user.test.ts (3 tests | 1 failed)',
  '   × creates a user 4ms',
  '',
  'FAIL  test/user.test.ts > creates a user',
  'AssertionError: expected 3 to be 4',
  '- Expected',
  '+ Received',
  '  at test/user.test.ts:12:20',
  '',
  ' Tests  1 failed | 2 passed (3)',
].join('\n');

const TSC_OUTPUT = 'src/a.ts(12,5): error TS2322: Type string is not assignable to type number.';

const PYTEST_OUTPUT = [
  '=================== FAILURES ===================',
  '_______________ test_adds _______________',
  '    def test_adds():',
  '>       assert add(1, 2) == 4',
  'E       assert 3 == 4',
  '',
  'test_math.py:5: AssertionError',
].join('\n');

describe('extractFailureLines', () => {
  it('pulls the diagnosis out of a vitest run', () => {
    const lines = extractFailureLines(VITEST_OUTPUT);
    expect(lines.some((line) => line.includes('AssertionError: expected 3 to be 4'))).toBe(true);
    expect(lines.some((line) => line.includes('× creates a user'))).toBe(true);
    expect(lines.some((line) => line.includes('at test/user.test.ts:12:20'))).toBe(true);
    expect(lines.some((line) => line.includes('RUN  v4.1.11'))).toBe(false);
  });

  it('recognises a TypeScript compiler error', () => {
    expect(extractFailureLines(TSC_OUTPUT)).toHaveLength(1);
  });

  it('recognises pytest output', () => {
    const lines = extractFailureLines(PYTEST_OUTPUT);
    expect(lines.some((line) => line.includes('FAILURES'))).toBe(true);
    expect(lines.some((line) => line.includes('E       assert 3 == 4'))).toBe(true);
  });

  it('recognises a go test failure', () => {
    expect(extractFailureLines('--- FAIL: TestAdd (0.00s)')).toHaveLength(1);
  });

  it('deduplicates a stack repeated across cases', () => {
    const repeated = Array.from({ length: 20 }, () => '  at src/a.ts:1:1').join('\n');
    expect(extractFailureLines(repeated)).toHaveLength(1);
  });

  it('preserves source order', () => {
    const lines = extractFailureLines(['error: first', 'error: second'].join('\n'));
    expect(lines).toEqual(['error: first', 'error: second']);
  });

  it('respects the line ceiling', () => {
    const many = Array.from({ length: 200 }, (_, index) => `error: e${index}`).join('\n');
    expect(extractFailureLines(many, 5)).toHaveLength(5);
  });

  it('finds nothing in clean output', () => {
    expect(extractFailureLines('all good\n3 passed')).toEqual([]);
  });
});

describe('summarizeCommand', () => {
  it('treats a zero exit as success and extracts nothing', () => {
    // A passing run that happens to log the word "error" must not read as a failure.
    const structure = summarizeCommand(
      completed({ stdout: 'error handling test passed\n', exitCode: 0 }),
    );
    expect(structure.ok).toBe(true);
    expect(structure.failureLines).toEqual([]);
  });

  it('treats a non-zero exit as failure and extracts', () => {
    const structure = summarizeCommand(completed({ exitCode: 1, stdout: VITEST_OUTPUT }));
    expect(structure.ok).toBe(false);
    expect(structure.failureLines.length).toBeGreaterThan(0);
  });

  it('a timeout is a failure even with exit code 0', () => {
    expect(summarizeCommand(completed({ timedOut: true })).ok).toBe(false);
  });

  it('a cancellation is a failure', () => {
    expect(summarizeCommand(completed({ cancelled: true })).ok).toBe(false);
  });
});

describe('renderCommandResult', () => {
  it('leads with a machine-readable status line', () => {
    const rendered = renderCommandResult(completed({ exitCode: 1, stdout: VITEST_OUTPUT }), {
      maxOutputBytes: 4_096,
      command: 'pnpm test',
    });
    const first = rendered.content[0];
    expect(first?.type).toBe('text');
    if (first?.type !== 'text') return;
    expect(first.text).toContain('command: pnpm test');
    expect(first.text).toContain('exit: 1');
    expect(first.text).toContain('containment: gate-only');
  });

  it('separates failures from raw output', () => {
    const rendered = renderCommandResult(completed({ exitCode: 1, stdout: VITEST_OUTPUT }), {
      maxOutputBytes: 4_096,
      command: 'pnpm test',
    });
    const texts = rendered.content.filter((b) => b.type === 'text').map((b) => b.text);
    expect(texts.some((text) => text.startsWith('failures:'))).toBe(true);
    expect(texts.some((text) => text.startsWith('output:'))).toBe(true);
  });

  it('omits the failures block on success', () => {
    const rendered = renderCommandResult(completed({ stdout: 'ok\n' }), {
      maxOutputBytes: 4_096,
      command: 'ls',
    });
    const texts = rendered.content.filter((b) => b.type === 'text').map((b) => b.text);
    expect(texts.some((text) => text.startsWith('failures:'))).toBe(false);
  });

  it('keeps the failing tail when output is long', () => {
    // The reason `both` bias exists: a runner prints thousands of passing lines and the
    // verdict last, so head truncation would discard the answer.
    const noise = Array.from({ length: 3_000 }, (_, index) => `ok ${index}`).join('\n');
    const rendered = renderCommandResult(
      completed({ exitCode: 1, stdout: `${noise}\nAssertionError: expected 3 to be 4` }),
      { maxOutputBytes: 512, command: 'pnpm test' },
    );
    expect(rendered.outputTruncated).toBe(true);
    const all = rendered.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(all).toContain('AssertionError: expected 3 to be 4');
  });

  it('says so when the broker capped output', () => {
    const rendered = renderCommandResult(completed({ outputCapped: true }), {
      maxOutputBytes: 4_096,
      command: 'yes',
    });
    const first = rendered.content[0];
    if (first?.type !== 'text') return;
    expect(first.text).toContain('output_capped: true');
  });

  it('reports a signal kill rather than pretending an exit code', () => {
    const rendered = renderCommandResult(
      completed({ exitCode: null, signal: 'SIGKILL', timedOut: true }),
      { maxOutputBytes: 4_096, command: 'sleep 999' },
    );
    const first = rendered.content[0];
    if (first?.type !== 'text') return;
    expect(first.text).toContain('exit: signal SIGKILL');
    expect(first.text).toContain('timed_out: true');
  });

  it('says output: (none) rather than leaving the block off', () => {
    const rendered = renderCommandResult(completed({}), {
      maxOutputBytes: 4_096,
      command: 'true',
    });
    const texts = rendered.content.filter((b) => b.type === 'text').map((b) => b.text);
    expect(texts).toContain('output: (none)');
  });
});

describe('renderSpawnFailure', () => {
  it('distinguishes a program that never started from one that failed', () => {
    // "bash is not installed" needs a different response from the model than "the tests
    // failed", and folding the first into an exit code invites it to debug the wrong
    // thing.
    const content = renderSpawnFailure(
      { kind: 'spawn-failed', message: "could not run 'bash': ENOENT", durationMs: 1 },
      'pnpm test',
    );
    const first = content[0];
    if (first?.type !== 'text') return;
    expect(first.text).toContain('status: did not start');
    expect(first.text).toContain('not a failing command');
    expect(first.text).toContain('ENOENT');
  });
});
