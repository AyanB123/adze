/**
 * Git worktrees for cheap isolation of parallel agents.
 *
 * ADR-0007 lists worktrees alongside the OS mechanisms, and it is important not to
 * read that as putting them in the same category. **A worktree is not a security
 * boundary.** It is a second checkout sharing one object database, running as the same
 * user with the same rights; an agent inside one can write anywhere on the machine
 * that the user can. Nothing here contains anything.
 *
 * What it solves is a different and very common problem: two agents editing one
 * checkout produce interleaved edits, a shared index, and merge conflicts in the
 * middle of a turn. Giving each its own worktree makes those parallel runs
 * independent for the price of a directory and a few kilobytes, rather than a full
 * clone per agent. Combined with a broker whose writable roots are set to that
 * worktree, an agent's *intended* writes are confined to it — which is containment
 * from the permission model, not from git.
 *
 * Every worktree is created detached. A worktree on a branch takes that branch
 * exclusively, so two agents asked to work on `main` would collide on the second
 * `worktree add`; detaching means the ref is a starting point rather than a claim, and
 * a caller that wants a branch creates one inside the worktree afterwards.
 */

/** Runs a git argv. Injected so every path here is testable without a repository. */
export type GitRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;

export interface WorktreeRequest {
  /** An existing repository. `git` is run with this as its working directory. */
  readonly repoRoot: string;
  /** Absolute path for the new worktree. Must not exist. */
  readonly path: string;
  /** Commit-ish to check out. Defaults to `HEAD`. */
  readonly ref?: string;
}

/**
 * argv for creating a worktree.
 *
 * `--detach` for the reason above. `--no-checkout` is deliberately not used: an agent
 * needs the files.
 */
export function worktreeAddArgs(request: WorktreeRequest): readonly string[] {
  return ['worktree', 'add', '--detach', request.path, request.ref ?? 'HEAD'];
}

/**
 * argv for removing a worktree.
 *
 * `--force` is the default here, against the usual instinct. A worktree an agent has
 * been running in is nearly always dirty, and plain `git worktree remove` refuses on a
 * dirty tree — so the polite form fails exactly when cleanup matters and leaves the
 * directory behind for the next run to trip over. The caller asked to destroy a
 * scratch checkout; honouring that is correct, and preserving uncommitted agent output
 * by accident is not a feature.
 */
export function worktreeRemoveArgs(path: string, force = true): readonly string[] {
  return force ? ['worktree', 'remove', '--force', path] : ['worktree', 'remove', path];
}

/** argv for listing worktrees in a parseable form. */
export function worktreeListArgs(): readonly string[] {
  return ['worktree', 'list', '--porcelain'];
}

/** argv for pruning administrative files left by worktrees whose directory is gone. */
export function worktreePruneArgs(): readonly string[] {
  return ['worktree', 'prune'];
}

export type WorktreeResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Create a worktree, reporting git's own diagnosis on failure.
 *
 * git's stderr is passed through rather than replaced. "fatal: '<path>' already
 * exists" and "fatal: not a git repository" need different responses, and a wrapper
 * message like "could not create worktree" erases the only information that
 * distinguished them.
 */
export async function createWorktree(
  run: GitRunner,
  request: WorktreeRequest,
): Promise<WorktreeResult> {
  const result = await run(worktreeAddArgs(request), request.repoRoot);
  if (result.code === 0) return { ok: true, path: request.path };
  return {
    ok: false,
    reason:
      `could not create a worktree at '${request.path}': ` +
      `${firstLine(result.stderr) || `git exited with ${result.code}`}`,
  };
}

/** Remove a worktree. Succeeds when it is already gone, since that is the goal state. */
export async function removeWorktree(
  run: GitRunner,
  repoRoot: string,
  path: string,
): Promise<WorktreeResult> {
  const result = await run(worktreeRemoveArgs(path), repoRoot);
  if (result.code === 0) return { ok: true, path };
  if (/is not a working tree|No such file or directory|not a valid path/i.test(result.stderr)) {
    return { ok: true, path };
  }
  return {
    ok: false,
    reason:
      `could not remove the worktree at '${path}': ` +
      `${firstLine(result.stderr) || `git exited with ${result.code}`}`,
  };
}

/** Absolute worktree paths, parsed from `--porcelain` output. */
export function parseWorktreeList(stdout: string): readonly string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((path) => path.length > 0);
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}
