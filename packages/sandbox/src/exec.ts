/**
 * The one place this package spawns a process.
 *
 * Every broker — Seatbelt, bubblewrap, Windows, Docker, fallback — builds an argv
 * and hands it here. Concentrating the spawn has a specific payoff: the properties
 * that are easy to lose in a per-broker copy are written once and tested once.
 *
 * ## The four properties
 *
 * **argv array, never a shell string.** `shell: false` is not a default being
 * accepted, it is the entire point. A workspace path containing `;`, `$(...)`,
 * backticks, `&&`, or `%PATH%` arrives at the child as literal bytes in `argv`,
 * because no interpreter ever sees it. Brokers that need shell semantics pass the
 * shell as `argv[0]` and own that choice visibly.
 *
 * **No orphans.** The child is spawned as a process-group leader, and teardown
 * kills the group rather than the process. This is the difference between killing
 * `bash` and killing `bash` plus the `npm install` it started plus that install's
 * postinstall script plus the `curl` inside it. A timeout that leaves a `curl`
 * running has not enforced a timeout, it has hidden one.
 *
 * **A timeout that fires even when the child ignores it.** After the group kill
 * there is a bounded grace period; if `close` never arrives, the outcome is
 * returned anyway. A broker that waits forever for a wedged process is how an agent
 * turn hangs with no diagnosis.
 *
 * **A memory ceiling.** A process that writes gigabytes to stdout must not take the
 * engine down with it, so each stream stops accumulating at a fixed cap and the
 * outcome says it was capped.
 */

import { spawn } from 'node:child_process';
import type { CommandOutcome, SandboxEnforcement } from './types.js';

/** Per-stream memory ceiling. Matches core's broker so output behaviour is uniform. */
export const MAX_STREAM_BYTES = 4 * 1024 * 1024;

/**
 * How long to wait for `close` after killing the group.
 *
 * SIGKILL is not refusable, so this expiring means something stranger than a
 * stubborn process: an unkillable state in a device driver, or a pipe that never
 * closes because a grandchild inherited it and the group kill missed. Returning is
 * still better than hanging, and the outcome reports `timedOut` so the caller knows.
 */
const TEARDOWN_GRACE_MS = 2_000;

/** What to spawn. Already fully resolved by the broker that built it. */
export interface SpawnPlan {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Injectable so teardown can be observed in a test without killing anything real. */
export type ProcessTreeKiller = (pid: number, platform: string) => void;

export interface RunOptions {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly stdin?: string;
  /** Reported verbatim on the outcome. The broker owns this claim. */
  readonly enforcement: SandboxEnforcement;
  readonly maxStreamBytes?: number;
  /** Defaults to `process.platform`. Injectable so both kill paths are testable. */
  readonly platform?: string;
  readonly killer?: ProcessTreeKiller;
}

/**
 * Kill a process and everything it started.
 *
 * On POSIX the child is its own group leader, so a negative pid signals the whole
 * group. On Windows there are no process groups in that sense, so `taskkill /T`
 * walks the parent-child chain — spawned with an argument array like everything
 * else here, because a pid interpolated into a command string is exactly the shape
 * of bug this package refuses to contain.
 */
export function killProcessTree(pid: number, platform: string): void {
  if (platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
    });
    // Detached from our lifecycle: if the engine exits first, teardown still runs.
    killer.on('error', noteKillFailure);
    killer.unref();
    return;
  }
  killGroup(pid);
}

/** `false` when the group was already gone, which is the outcome teardown wanted. */
function killGroup(pid: number): boolean {
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/**
 * A missing `taskkill` is not worth failing a turn over.
 *
 * It ships with every supported Windows version, so absence means a broken PATH.
 * The direct `child.kill()` in {@link runContained} has already run by this point,
 * so the child itself is dead either way; what is lost is the grandchildren, and
 * that limitation is reported as a Windows degradation rather than swallowed.
 */
function noteKillFailure(): void {
  // Intentionally silent here. `@adze/core` renders warnings; this package must not
  // write to a stream a surface owns (architecture invariant 1).
}

interface Streams {
  stdout: string;
  stderr: string;
  capped: boolean;
}

/** Spawn one command, contained by whatever the caller already arranged. */
export async function runContained(plan: SpawnPlan, options: RunOptions): Promise<CommandOutcome> {
  const startedAt = Date.now();
  const platform = options.platform ?? process.platform;
  const kill = options.killer ?? killProcessTree;
  const cap = options.maxStreamBytes ?? MAX_STREAM_BYTES;

  return await new Promise<CommandOutcome>((resolve) => {
    const child = spawn(plan.file, [...plan.args], {
      cwd: plan.cwd,
      env: { ...plan.env },
      shell: false,
      windowsHide: true,
      // The child leads its own group so teardown reaches grandchildren. On POSIX
      // this also detaches it from our controlling terminal, which is wanted: a
      // model-authored command must not be able to read the user's tty.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const streams: Streams = { stdout: '', stderr: '', capped: false };
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const append = (target: 'out' | 'err', chunk: Buffer): void => {
      const current = target === 'out' ? streams.stdout : streams.stderr;
      if (Buffer.byteLength(current, 'utf8') >= cap) {
        streams.capped = true;
        return;
      }
      const text = chunk.toString('utf8');
      if (target === 'out') streams.stdout += text;
      else streams.stderr += text;
    };

    child.stdout?.on('data', (chunk: Buffer) => append('out', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('err', chunk));

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      options.signal.removeEventListener('abort', onAbort);
      resolve({
        kind: 'completed',
        exitCode: child.exitCode,
        signal: child.signalCode,
        stdout: streams.stdout,
        stderr: streams.stderr,
        timedOut,
        cancelled,
        outputCapped: streams.capped,
        durationMs: Date.now() - startedAt,
        enforcement: options.enforcement,
      });
    };

    const tearDown = (): void => {
      // Both, in this order. `child.kill()` is synchronous and certain for the
      // child itself; the tree kill is what reaches its descendants and is
      // best-effort by nature.
      child.kill('SIGKILL');
      if (child.pid !== undefined) kill(child.pid, platform);
      graceTimer = setTimeout(finish, TEARDOWN_GRACE_MS);
      graceTimer.unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      tearDown();
    }, options.timeoutMs);

    const onAbort = (): void => {
      cancelled = true;
      tearDown();
    };

    if (options.signal.aborted) {
      cancelled = true;
      tearDown();
    } else {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      options.signal.removeEventListener('abort', onAbort);
      resolve({
        kind: 'spawn-failed',
        message: `could not run '${plan.file}': ${error.message}`,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', finish);

    // Closed unconditionally rather than left open. A command that reads stdin and
    // never receives EOF hangs until the timeout, which turns a fast failure into a
    // slow one and burns the turn's budget on nothing.
    child.stdin?.end(options.stdin ?? '');
  });
}
