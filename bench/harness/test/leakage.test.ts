/**
 * Tests for the leakage assertions ADR-0011 requires to be build failures.
 *
 * The git tests build **real repositories**, not mocks. The whole question is whether a
 * repository as actually prepared leaks the future, and a mocked `git` would only prove
 * that our idea of `rev-list` agrees with itself. Each one constructs both a leaking and
 * a properly prepared repository from the same commits, so a check that always passed and
 * a check that always failed would each be caught.
 *
 * They need `git` on PATH, which every CI runner for this repository has, and they create
 * nothing outside a temp directory.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type AgentPrompt,
  checkHistoryIsolation,
  checkPromptLeakage,
  type LeakageCheck,
  LeakageError,
  MIN_LEAKED_LINE_LENGTH,
  PROMPT_ALLOWED_FIELDS,
  redactTaskRecord,
  type TaskRecord,
} from '../src/leakage.js';

const run = promisify(execFile);

function codes(check: LeakageCheck): readonly string[] {
  return check.ok ? [] : check.violations.map((v) => v.code);
}

function messages(check: LeakageCheck): string {
  return check.ok ? '' : check.violations.map((v) => v.message).join(' ');
}

// ---------------------------------------------------------------------------
// The payload guard
// ---------------------------------------------------------------------------

/**
 * A SWE-bench-shaped record. The patch lines are deliberately longer than
 * `MIN_LEAKED_LINE_LENGTH`, because a fixture whose lines fall under the threshold would
 * make the content detector look like it worked when it had simply found nothing.
 */
const RECORD: TaskRecord = {
  instance_id: 'example__project-1234',
  repo: 'example/project',
  base_commit: 'a'.repeat(40),
  problem_statement: 'Calling frobnicate() with an empty list raises IndexError.',
  hints_text: 'The maintainer suggests guarding the loop in _frobnicate_all.',
  patch: [
    '--- a/src/thing.py',
    '+++ b/src/thing.py',
    '@@ -1,3 +1,5 @@',
    '     def frobnicate(items):',
    '-        return items[0]',
    '+        raise ValueError("frobnicate requires a non-empty list")',
    '+        return None',
  ].join('\n'),
  test_patch: [
    '--- a/tests/test_thing.py',
    '+++ b/tests/test_thing.py',
    '@@ -1,2 +1,6 @@',
    '+def test_frobnicate_rejects_an_empty_list():',
    '+    assert frobnicate([]) is None',
  ].join('\n'),
  FAIL_TO_PASS: ['tests/test_thing.py::test_frobnicate_rejects_an_empty_list'],
  PASS_TO_PASS: [],
};

function promptFrom(fields: TaskRecord, text?: string): AgentPrompt {
  const statement = typeof fields.problem_statement === 'string' ? fields.problem_statement : '';
  return { fields, text: text ?? statement };
}

describe('the payload allowlist', () => {
  it('allows exactly what an agent needs to start work', () => {
    expect([...PROMPT_ALLOWED_FIELDS]).toEqual([
      'instance_id',
      'repo',
      'base_commit',
      'problem_statement',
    ]);
  });

  it('accepts a redacted record, so the compliant path is the easy one', () => {
    const redacted = redactTaskRecord(RECORD);

    expect(Object.keys(redacted).sort()).toEqual([...PROMPT_ALLOWED_FIELDS].sort());
    expect(checkPromptLeakage(RECORD, promptFrom(redacted)).ok).toBe(true);
  });

  it('refuses the gold patch as a field', () => {
    const fields = { ...redactTaskRecord(RECORD), patch: RECORD.patch };
    const check = checkPromptLeakage(RECORD, promptFrom(fields));

    expect(codes(check)).toContain('undeclared-field-in-prompt');
    expect(messages(check)).toContain("'patch'");
  });

  it('refuses the test patch as a field', () => {
    const fields = { ...redactTaskRecord(RECORD), test_patch: RECORD.test_patch };
    expect(codes(checkPromptLeakage(RECORD, promptFrom(fields)))).toContain(
      'undeclared-field-in-prompt',
    );
  });

  it('refuses the tests the agent must pass', () => {
    // Handing over FAIL_TO_PASS turns the task into transcription.
    const fields = { ...redactTaskRecord(RECORD), FAIL_TO_PASS: RECORD.FAIL_TO_PASS };
    expect(codes(checkPromptLeakage(RECORD, promptFrom(fields)))).toContain(
      'undeclared-field-in-prompt',
    );
  });

  it('refuses hints_text, which reads harmless and often describes the fix', () => {
    const fields = { ...redactTaskRecord(RECORD), hints_text: RECORD.hints_text };
    expect(codes(checkPromptLeakage(RECORD, promptFrom(fields)))).toContain(
      'undeclared-field-in-prompt',
    );
  });

  it('refuses a field nobody has seen before', () => {
    // The reason the guard is an allowlist. A denylist of today's column names would pass
    // this, and a dataset can add a column whenever it likes.
    const fields = { ...redactTaskRecord(RECORD), solution_sketch_v2: 'guard the loop' };
    const check = checkPromptLeakage(RECORD, promptFrom(fields));

    expect(codes(check)).toContain('undeclared-field-in-prompt');
    expect(messages(check)).toContain('default-deny');
  });

  it('names every offending field at once', () => {
    const fields = {
      ...redactTaskRecord(RECORD),
      patch: RECORD.patch,
      hints_text: RECORD.hints_text,
    };
    const message = messages(checkPromptLeakage(RECORD, promptFrom(fields)));

    expect(message).toContain("'patch'");
    expect(message).toContain("'hints_text'");
  });
});

describe('the content detector', () => {
  it('catches the gold patch quoted inside an allowed field', () => {
    // The pre-solved-localization vector: every field is permitted, and the fix is in the
    // problem statement anyway.
    const fields = {
      ...redactTaskRecord(RECORD),
      problem_statement:
        'It crashes. The fix is to raise ValueError("frobnicate requires a non-empty list") ' +
        'before indexing.',
    };
    const check = checkPromptLeakage(RECORD, promptFrom(fields));

    expect(codes(check)).toContain('gold-patch-content-in-prompt');
    expect(messages(check)).toContain('10 to 20 points');
  });

  it('catches the test patch quoted in the prompt text', () => {
    const prompt = promptFrom(
      redactTaskRecord(RECORD),
      'Make this pass: def test_frobnicate_rejects_an_empty_list():',
    );
    expect(codes(checkPromptLeakage(RECORD, prompt))).toContain('test-patch-content-in-prompt');
  });

  it('ignores a short line that any repository would contain', () => {
    // `return None` is in the gold patch and is 11 characters. Flagging it would make the
    // check fire on almost every task and it would be switched off.
    const prompt = promptFrom(redactTaskRecord(RECORD), 'A guard clause should return None here.');

    expect('return None'.length).toBeLessThan(MIN_LEAKED_LINE_LENGTH);
    expect(checkPromptLeakage(RECORD, prompt).ok).toBe(true);
  });

  it('ignores the filenames a good bug report would name', () => {
    // Diff headers are dropped. A problem statement that says where the bug is has not
    // leaked the solution.
    const prompt = promptFrom(
      redactTaskRecord(RECORD),
      'The bug is in src/thing.py and the tests live in tests/test_thing.py.',
    );
    expect(checkPromptLeakage(RECORD, prompt).ok).toBe(true);
  });

  it('reports nothing about fields the record does not have', () => {
    // A dataset with no gold patch is not a leak, and must not be reported as one.
    const bare: TaskRecord = {
      instance_id: 'x',
      repo: 'a/b',
      base_commit: 'c',
      problem_statement: 'it breaks',
    };
    expect(checkPromptLeakage(bare, promptFrom(bare)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Future history, against real repositories
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

afterAll(async () => {
  for (const dir of scratchDirs) {
    // Windows holds pack files briefly after git exits; retry rather than fail the suite
    // on cleanup.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'adze-leakage-'));
  scratchDirs.push(dir);
  return dir;
}

async function g(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return stdout.trim();
}

/** Five commits on `main`, with every commit id captured. */
async function repoWithHistory(): Promise<{ dir: string; commits: string[] }> {
  const dir = await scratch();
  // `-b main` so the branch name does not depend on the runner's git config, and identity
  // set locally so the test does not depend on a global one existing.
  await run('git', ['init', '-b', 'main', dir]);
  await g(dir, 'config', 'user.email', 'test@example.invalid');
  await g(dir, 'config', 'user.name', 'Leakage Test');
  await g(dir, 'config', 'core.autocrlf', 'false');
  await g(dir, 'config', 'commit.gpgsign', 'false');

  const commits: string[] = [];
  for (let i = 1; i <= 5; i++) {
    await writeFile(join(dir, 'thing.py'), `# revision ${i}\n`, 'utf8');
    await g(dir, 'add', 'thing.py');
    await g(dir, 'commit', '-m', `revision ${i}`);
    commits.push(await g(dir, 'rev-parse', 'HEAD'));
  }
  return { dir, commits };
}

/**
 * A repository prepared the way an agent container is supposed to be: detached at the
 * base commit, with every other ref removed so nothing later is reachable.
 */
async function preparedAt(source: string, baseCommit: string): Promise<string> {
  const dir = await scratch();
  await run('git', ['clone', '--quiet', source, dir]);
  await g(dir, 'checkout', '--quiet', '--detach', baseCommit);
  await g(dir, 'branch', '-D', 'main');
  // Removes refs/remotes/origin/*, which is where the rest of the history would still be
  // reachable from after a plain clone.
  await g(dir, 'remote', 'remove', 'origin');
  return dir;
}

describe('future history', () => {
  it('refuses a clone that still has later commits reachable', async () => {
    // The realistic mistake: check out the base commit and forget that `main` and the
    // remote-tracking refs still point at the fix.
    const { dir, commits } = await repoWithHistory();
    const base = commits[1];
    if (base === undefined) throw new Error('fixture did not produce five commits');
    await g(dir, 'checkout', '--quiet', '--detach', base);

    const check = await checkHistoryIsolation({ repoDir: dir, baseCommit: base });

    expect(codes(check)).toContain('future-history-reachable');
    expect(messages(check)).toContain('git log');
  });

  it('accepts a repository prepared at the base commit', async () => {
    const { dir, commits } = await repoWithHistory();
    const base = commits[1];
    if (base === undefined) throw new Error('fixture did not produce five commits');

    const prepared = await preparedAt(dir, base);
    const check = await checkHistoryIsolation({ repoDir: prepared, baseCommit: base });

    expect(messages(check)).toBe('');
    expect(check.ok).toBe(true);
  });

  it('accepts an abbreviated base commit', async () => {
    const { dir, commits } = await repoWithHistory();
    const base = commits[1];
    if (base === undefined) throw new Error('fixture did not produce five commits');

    const prepared = await preparedAt(dir, base);
    const check = await checkHistoryIsolation({ repoDir: prepared, baseCommit: base.slice(0, 8) });

    expect(check.ok).toBe(true);
  });

  it('catches a tag pointing past the base commit', async () => {
    // The reason the check is written as reachability rather than as commit dates or as
    // "descendants of HEAD". A tag left behind by a careless preparation step is exactly
    // as reachable as a branch, and `git log --all` finds it.
    const { dir, commits } = await repoWithHistory();
    const base = commits[1];
    const later = commits[4];
    if (base === undefined || later === undefined) throw new Error('fixture is wrong');

    const prepared = await preparedAt(dir, base);
    await g(prepared, 'tag', 'v2', later);

    const check = await checkHistoryIsolation({ repoDir: prepared, baseCommit: base });
    expect(codes(check)).toContain('future-history-reachable');
  });

  it('reports a HEAD that is not at the base commit', async () => {
    const { dir, commits } = await repoWithHistory();
    const base = commits[1];
    const other = commits[0];
    if (base === undefined || other === undefined) throw new Error('fixture is wrong');

    const prepared = await preparedAt(dir, base);
    await g(prepared, 'checkout', '--quiet', '--detach', other);

    const check = await checkHistoryIsolation({ repoDir: prepared, baseCommit: base });
    expect(codes(check)).toContain('head-not-at-base-commit');
  });

  it('reports a base commit the repository does not contain', async () => {
    const { dir } = await repoWithHistory();
    const absent = 'b'.repeat(40);

    const check = await checkHistoryIsolation({ repoDir: dir, baseCommit: absent });

    expect(codes(check)).toContain('base-commit-missing');
    expect(messages(check)).toContain('not starting where the task says');
  });

  it('throws rather than passing when it cannot run at all', async () => {
    // A leakage assertion that reports clean because git failed is the worst available
    // outcome, so a directory that is not a repository is an error and not a pass.
    const notARepo = await scratch();

    await expect(
      checkHistoryIsolation({ repoDir: notARepo, baseCommit: 'a'.repeat(40) }),
    ).rejects.toThrow(LeakageError);
  });
});
