import { describe, expect, it } from 'vitest';
import type { GitRunner } from '../src/worktree.js';
import {
  createWorktree,
  parseWorktreeList,
  removeWorktree,
  worktreeAddArgs,
  worktreeListArgs,
  worktreePruneArgs,
  worktreeRemoveArgs,
} from '../src/worktree.js';

function runner(
  result: { code: number; stdout?: string; stderr?: string },
  log?: Array<{ args: readonly string[]; cwd: string }>,
): GitRunner {
  return async (args, cwd) => {
    log?.push({ args, cwd });
    return await Promise.resolve({
      code: result.code,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    });
  };
}

describe('worktreeAddArgs', () => {
  // A worktree on a branch claims that branch exclusively, so two agents asked to
  // work on main would collide on the second add. Detaching makes the ref a starting
  // point rather than a claim.
  it('always detaches', () => {
    expect(worktreeAddArgs({ repoRoot: '/repo', path: '/tmp/wt' })).toContain('--detach');
  });

  it('defaults the ref to HEAD', () => {
    expect(worktreeAddArgs({ repoRoot: '/repo', path: '/tmp/wt' })).toEqual([
      'worktree',
      'add',
      '--detach',
      '/tmp/wt',
      'HEAD',
    ]);
  });

  it('uses an explicit ref when given', () => {
    expect(worktreeAddArgs({ repoRoot: '/repo', path: '/tmp/wt', ref: 'v1.2.0' }).at(-1)).toBe(
      'v1.2.0',
    );
  });

  // Argument array, so a branch name containing a metacharacter is inert.
  it('keeps a ref containing shell metacharacters as one argument', () => {
    const args = worktreeAddArgs({ repoRoot: '/repo', path: '/tmp/wt', ref: '$(whoami)' });
    expect(args.at(-1)).toBe('$(whoami)');
  });
});

describe('worktreeRemoveArgs', () => {
  // Plain `git worktree remove` refuses on a dirty tree, which is exactly the state an
  // agent's scratch checkout is in - so the polite form fails when cleanup matters.
  it('forces by default', () => {
    expect(worktreeRemoveArgs('/tmp/wt')).toEqual(['worktree', 'remove', '--force', '/tmp/wt']);
  });

  it('can be asked not to force', () => {
    expect(worktreeRemoveArgs('/tmp/wt', false)).toEqual(['worktree', 'remove', '/tmp/wt']);
  });
});

describe('list and prune argv', () => {
  it('lists in a parseable form', () => {
    expect(worktreeListArgs()).toEqual(['worktree', 'list', '--porcelain']);
  });

  it('prunes administrative files', () => {
    expect(worktreePruneArgs()).toEqual(['worktree', 'prune']);
  });
});

describe('createWorktree', () => {
  it('runs git in the repository root', async () => {
    const log: Array<{ args: readonly string[]; cwd: string }> = [];
    const result = await createWorktree(runner({ code: 0 }, log), {
      repoRoot: '/repo',
      path: '/tmp/wt',
    });
    expect(result).toEqual({ ok: true, path: '/tmp/wt' });
    expect(log[0]?.cwd).toBe('/repo');
  });

  // git's own diagnosis is the only thing distinguishing "already exists" from "not a
  // git repository", and a wrapper message erases it.
  it("passes git's first stderr line through on failure", async () => {
    const result = await createWorktree(
      runner({ code: 128, stderr: "fatal: '/tmp/wt' already exists\n" }),
      { repoRoot: '/repo', path: '/tmp/wt' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("fatal: '/tmp/wt' already exists");
  });

  it('falls back to the exit code when git said nothing', async () => {
    const result = await createWorktree(runner({ code: 3 }), {
      repoRoot: '/repo',
      path: '/tmp/wt',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('git exited with 3');
  });
});

describe('removeWorktree', () => {
  it('succeeds when git succeeds', async () => {
    expect(await removeWorktree(runner({ code: 0 }), '/repo', '/tmp/wt')).toEqual({
      ok: true,
      path: '/tmp/wt',
    });
  });

  // Already gone is the goal state, so reporting failure would make cleanup code
  // handle a non-problem.
  it('treats an already-absent worktree as success', async () => {
    const result = await removeWorktree(
      runner({ code: 128, stderr: "fatal: '/tmp/wt' is not a working tree" }),
      '/repo',
      '/tmp/wt',
    );
    expect(result.ok).toBe(true);
  });

  it('reports a real failure', async () => {
    const result = await removeWorktree(
      runner({ code: 128, stderr: 'fatal: could not lock the index' }),
      '/repo',
      '/tmp/wt',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('could not lock the index');
  });
});

describe('parseWorktreeList', () => {
  it('extracts worktree paths from porcelain output', () => {
    const stdout = [
      'worktree /repo',
      'HEAD 0f1b2c3',
      'branch refs/heads/main',
      '',
      'worktree /tmp/agent-1',
      'HEAD 4d5e6f7',
      'detached',
      '',
    ].join('\n');
    expect(parseWorktreeList(stdout)).toEqual(['/repo', '/tmp/agent-1']);
  });

  it('returns nothing for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });

  it('ignores lines that merely mention a worktree', () => {
    expect(parseWorktreeList('note: worktrees are cheap\nworktree /repo')).toEqual(['/repo']);
  });
});
