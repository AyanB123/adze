import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { killProcessTree, MAX_STREAM_BYTES, runContained } from '../src/exec.js';
import type { CommandCompleted, CommandOutcome } from '../src/types.js';

/**
 * A minimal but working environment.
 *
 * Not `{}`: on Windows a process with no `SystemRoot` fails to initialize parts of
 * the C runtime, and a test that failed for that reason would look like a bug in the
 * broker. This is the same shape a scrubbed environment has in production.
 */
function minimalEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    TEMP: process.env.TEMP ?? tmpdir(),
  };
}

const dirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'adze-sandbox-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir === undefined) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

function completed(outcome: CommandOutcome): CommandCompleted {
  expect(outcome.kind).toBe('completed');
  if (outcome.kind !== 'completed') throw new Error(outcome.message);
  return outcome;
}

async function run(
  args: readonly string[],
  overrides: {
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    stdin?: string;
    maxStreamBytes?: number;
  } = {},
): Promise<CommandOutcome> {
  return await runContained(
    {
      file: process.execPath,
      args,
      cwd: overrides.cwd ?? (await scratch()),
      env: minimalEnv(),
    },
    {
      timeoutMs: overrides.timeoutMs ?? 30_000,
      signal: overrides.signal ?? new AbortController().signal,
      enforcement: 'gate-only',
      ...(overrides.stdin === undefined ? {} : { stdin: overrides.stdin }),
      ...(overrides.maxStreamBytes === undefined
        ? {}
        : { maxStreamBytes: overrides.maxStreamBytes }),
    },
  );
}

describe('runContained', () => {
  it('runs a command and reports its exit code and output', async () => {
    const outcome = completed(
      await run(['-e', 'process.stdout.write("out"); process.stderr.write("err")']),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe('out');
    expect(outcome.stderr).toBe('err');
    expect(outcome.timedOut).toBe(false);
    expect(outcome.cancelled).toBe(false);
    expect(outcome.outputCapped).toBe(false);
  });

  it('reports a non-zero exit without treating it as a failure to launch', async () => {
    const outcome = completed(await run(['-e', 'process.exit(3)']));
    expect(outcome.exitCode).toBe(3);
  });

  it('reports the enforcement level it was told, never a guess', async () => {
    const outcome = completed(await run(['-e', '0']));
    expect(outcome.enforcement).toBe('gate-only');
  });

  it('distinguishes a failure to launch from a non-zero exit', async () => {
    const outcome = await runContained(
      {
        file: 'adze-definitely-not-a-real-program-9f3c',
        args: [],
        cwd: await scratch(),
        env: minimalEnv(),
      },
      { timeoutMs: 5_000, signal: new AbortController().signal, enforcement: 'gate-only' },
    );
    expect(outcome.kind).toBe('spawn-failed');
    if (outcome.kind !== 'spawn-failed') return;
    expect(outcome.message).toContain('adze-definitely-not-a-real-program-9f3c');
    // A launch failure is not a refusal, and conflating them would tell a user to
    // change a policy when they need to install a program.
    expect(outcome.refusal).toBeUndefined();
  });
});

describe('argument injection is inert', () => {
  // The property the whole package rests on: `shell: false` plus an argv array means
  // a path or argument containing shell metacharacters is data, not syntax.
  const evil =
    '; rm -rf / && echo PWNED | tee out `whoami` $(id) %PATH% ^& $env:PATH ' +
    '"quoted" \'single\' $((1+1)) > redirected';

  it('passes shell metacharacters through verbatim', async () => {
    const outcome = completed(
      await run(['-e', 'process.stdout.write(JSON.stringify(process.argv))', evil]),
    );
    const argv = JSON.parse(outcome.stdout) as string[];
    expect(argv).toContain(evil);
  });

  it('does not execute the injected fragments', async () => {
    const outcome = completed(
      await run(['-e', 'process.stdout.write(JSON.stringify(process.argv))', evil]),
    );
    // `echo PWNED` never ran, so the literal word only appears inside the echoed argv
    // and never on its own line as command output.
    expect(outcome.stdout.split('\n').some((line) => line.trim() === 'PWNED')).toBe(false);
    expect(outcome.stderr).toBe('');
  });

  it('does not create a file a redirection would have created', async () => {
    const cwd = await scratch();
    completed(await run(['-e', 'process.stdout.write("ok")', evil], { cwd }));
    // `> redirected` and `| tee out` would both have left a file behind.
    expect(await readdir(cwd)).toEqual([]);
  });

  it('passes an argument that looks like a flag through to the program verbatim', async () => {
    // Node's own CLI would consume a bare `--eval` even after `-e`, which is Node's
    // business rather than the broker's; `--` ends its option parsing. The property
    // under test is that nothing between here and the program rewrites the argv.
    const outcome = completed(
      await run([
        '-e',
        'process.stdout.write(JSON.stringify(process.argv))',
        '--',
        '--eval',
        'BAD',
      ]),
    );
    const argv = JSON.parse(outcome.stdout) as string[];
    expect(argv).toContain('--eval');
    expect(argv).toContain('BAD');
  });
});

describe('timeout enforcement', () => {
  it('kills a command that outlives its timeout and says so', async () => {
    const startedAt = Date.now();
    const outcome = completed(await run(['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 500 }));
    expect(outcome.timedOut).toBe(true);
    expect(outcome.cancelled).toBe(false);
    // Bounded generously: the assertion is that it did not wait out the 60 seconds.
    expect(Date.now() - startedAt).toBeLessThan(20_000);
  });

  it('leaves timedOut false for a command that finishes in time', async () => {
    const outcome = completed(await run(['-e', '0'], { timeoutMs: 30_000 }));
    expect(outcome.timedOut).toBe(false);
  });
});

describe('cancellation', () => {
  it('kills a running command when the signal aborts', async () => {
    const controller = new AbortController();
    const pending = run(['-e', 'setTimeout(() => {}, 60000)'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 250);
    const outcome = completed(await pending);
    expect(outcome.cancelled).toBe(true);
  });

  it('does not run a command whose signal has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = completed(
      await run(['-e', 'setTimeout(() => {}, 60000)'], { signal: controller.signal }),
    );
    expect(outcome.cancelled).toBe(true);
  });
});

describe('output ceiling', () => {
  it('stops accumulating at the cap and reports it', async () => {
    const outcome = completed(
      await run(['-e', 'process.stdout.write("x".repeat(200000))'], { maxStreamBytes: 1024 }),
    );
    expect(outcome.outputCapped).toBe(true);
    // The cap bounds what is retained, not what a single chunk may deliver, so the
    // assertion is that it is bounded rather than exact.
    expect(outcome.stdout.length).toBeLessThan(200_000);
  });

  it('exposes the default ceiling so callers can reason about it', () => {
    expect(MAX_STREAM_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe('stdin', () => {
  const echo =
    'let d = ""; process.stdin.on("data", (c) => { d += c; }); ' +
    'process.stdin.on("end", () => process.stdout.write("got:" + d));';

  it('writes the provided input', async () => {
    const outcome = completed(await run(['-e', echo], { stdin: 'hello' }));
    expect(outcome.stdout).toBe('got:hello');
  });

  // Left open, a command that reads stdin hangs until the timeout, turning a fast
  // failure into a slow one that burns the turn's budget.
  it('closes stdin when no input was given, so a reader sees EOF', async () => {
    const outcome = completed(await run(['-e', echo], { timeoutMs: 15_000 }));
    expect(outcome.stdout).toBe('got:');
    expect(outcome.timedOut).toBe(false);
  });
});

describe('teardown reaches descendants', () => {
  /**
   * A timeout that leaves a grandchild running has not enforced a timeout, it has
   * hidden one. The child here starts a long-lived grandchild and reports its pid;
   * after the timeout fires, that pid must be gone.
   */
  it('kills a grandchild when the command times out', async () => {
    const spawner =
      'const { spawn } = require("node:child_process"); ' +
      'const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], ' +
      '{ stdio: "ignore" }); ' +
      'process.stdout.write(String(c.pid)); ' +
      'setTimeout(() => {}, 60000);';

    const outcome = completed(await run(['-e', spawner], { timeoutMs: 1_500 }));
    expect(outcome.timedOut).toBe(true);

    const grandchild = Number(outcome.stdout.trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    expect(grandchild).toBeGreaterThan(0);

    try {
      expect(await gone(grandchild, 8_000)).toBe(true);
    } finally {
      // Whatever the assertion did, this test does not get to leave a process behind.
      killProcessTree(grandchild, process.platform);
    }
  });

  it('kills a grandchild when the turn is cancelled', async () => {
    const spawner =
      'const { spawn } = require("node:child_process"); ' +
      'const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], ' +
      '{ stdio: "ignore" }); ' +
      'process.stdout.write(String(c.pid)); ' +
      'setTimeout(() => {}, 60000);';

    const controller = new AbortController();
    const pending = run(['-e', spawner], { signal: controller.signal });
    setTimeout(() => controller.abort(), 1_000);
    const outcome = completed(await pending);
    expect(outcome.cancelled).toBe(true);

    const grandchild = Number(outcome.stdout.trim());
    try {
      expect(await gone(grandchild, 8_000)).toBe(true);
    } finally {
      killProcessTree(grandchild, process.platform);
    }
  });
});

describe('killProcessTree', () => {
  it('is a no-op for a pid that no longer exists', () => {
    // A teardown that threw on an already-dead process would turn the normal race
    // between a process exiting and being killed into a spurious error.
    expect(() => killProcessTree(2_147_483_646, process.platform)).not.toThrow();
  });

  it('routes through taskkill on win32 and process groups elsewhere', async () => {
    const calls: Array<{ pid: number; platform: string }> = [];
    const outcome = await runContained(
      {
        file: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        cwd: await scratch(),
        env: minimalEnv(),
      },
      {
        timeoutMs: 400,
        signal: new AbortController().signal,
        enforcement: 'gate-only',
        platform: 'some-platform',
        killer: (pid, platform) => calls.push({ pid, platform }),
      },
    );
    completed(outcome);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.platform).toBe('some-platform');
  });
});

/** Poll until the pid is gone, bounded. Returns false on timeout. */
async function gone(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !alive(pid);
}

function alive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
