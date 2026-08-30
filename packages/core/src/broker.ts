/**
 * The sandbox broker seam, and a stateless local implementation.
 *
 * **What this file is not.** It is not OS-level containment. Seatbelt profiles,
 * bubblewrap plumbing, and the Windows broker belong to `@adze/sandbox`
 * (ADR-0007, `docs/roadmap.md`). What lives here is the *interface* the
 * permission gate authorizes against, plus the one behaviour ADR-0004 identifies
 * as the single largest stability win in the reference harness: **one subprocess
 * per call, no persistent shell session.**
 *
 * That behaviour is a property of the loop rather than of the sandbox, which is
 * why it is here. A persistent session feels better — working directory and
 * environment survive — and is a reliability disaster: hung processes, state
 * leaking between calls, and failures nobody can reproduce. So the working
 * directory is passed explicitly on every call and nothing survives it.
 *
 * **Honesty about containment.** {@link SandboxBroker.enforcement} returns the
 * protocol's `SandboxEnforcement`, and {@link NodeSubprocessBroker} never reports
 * `os-level`, because it has none. On Windows that is also the *correct* answer
 * for any broker today: no open-source coding agent has OS-level containment
 * there. The engine surfaces it as a `no-os-sandbox` warning rather than letting a
 * user infer a boundary that does not exist.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { SandboxEnforcement, SandboxMode } from '@adze/protocol';

/** Containment the broker is being asked to apply. */
export interface Containment {
  readonly mode: SandboxMode;
  /** Absolute paths writable under `workspace-write`. */
  readonly writableRoots: readonly string[];
  /** Hosts reachable when the mode would otherwise deny network. */
  readonly allowedNetworkHosts: readonly string[];
}

export interface CommandRequest {
  /**
   * argv, already split. Never a shell string.
   *
   * A broker that accepted a string would have to decide how to split it, and
   * that decision is where shell-injection bugs live. A tool that wants shell
   * semantics passes the shell as `command[0]` and owns that choice explicitly.
   */
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly containment: Containment;
  readonly stdin?: string;
}

export interface CommandCompleted {
  readonly kind: 'completed';
  /** `null` when the process was killed by a signal instead of exiting. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** True when the process was killed because the turn was cancelled. */
  readonly cancelled: boolean;
  /** True when output was cut at the broker's memory ceiling. */
  readonly outputCapped: boolean;
  readonly durationMs: number;
  /** How the command was actually contained. A claim about evidence. */
  readonly enforcement: SandboxEnforcement;
}

/**
 * The process never started.
 *
 * Distinct from a non-zero exit, and the distinction is load-bearing: "bash is
 * not installed" needs a different response from the model than "the tests
 * failed", and folding the first into an exit code invites it to debug the wrong
 * thing.
 */
export interface CommandSpawnFailed {
  readonly kind: 'spawn-failed';
  readonly message: string;
  readonly durationMs: number;
}

export type CommandOutcome = CommandCompleted | CommandSpawnFailed;

export interface SandboxBroker {
  readonly name: string;
  /** What this broker can actually enforce for a mode on this platform. */
  enforcement(mode: SandboxMode): SandboxEnforcement;
  exec(request: CommandRequest): Promise<CommandOutcome>;
}

/** Per-stream memory ceiling. A runaway process must not exhaust the engine. */
const MAX_STREAM_BYTES = 4 * 1024 * 1024;

/**
 * Environment variable names that look like credentials.
 *
 * Scrubbed by default because the model chooses the commands, and a leaked key is
 * not recoverable. This is a **mitigation, not a boundary**: an environment is one
 * of many ways a subprocess can reach a secret, and only OS-level containment
 * closes the rest. It is stated that way rather than described as protection.
 *
 * The cost is real — a command that genuinely needs a token gets an empty one —
 * so {@link NodeSubprocessBrokerOptions.allowEnv} exists to pass specific names
 * through deliberately.
 */
const CREDENTIAL_PATTERN = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)(?:_|$)/i;

export interface NodeSubprocessBrokerOptions {
  /** Base environment. Defaults to the engine's own, after scrubbing. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Names to pass through even though they look like credentials. */
  readonly allowEnv?: readonly string[];
  /** Additional names to remove. */
  readonly denyEnv?: readonly string[];
}

/**
 * Build a subprocess environment with credential-shaped names removed.
 *
 * Exported because it is the kind of rule that is worth testing directly: a
 * regression here is invisible until it is a leaked key in someone's CI log.
 */
export function scrubEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly allow?: readonly string[]; readonly deny?: readonly string[] } = {},
): Record<string, string> {
  const allow = new Set(options.allow ?? []);
  const deny = new Set(options.deny ?? []);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (deny.has(name)) continue;
    if (!allow.has(name) && CREDENTIAL_PATTERN.test(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * The `errno` code carried by a failed `spawn`, when there is one.
 *
 * Read through `NodeJS.ErrnoException` rather than `any`: the property is optional on
 * `Error` at runtime and the cast keeps that visible instead of asserting it away.
 */
function errorCode(error: Error): string | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Attribute a spawn failure to the thing that actually failed.
 *
 * Node reports a missing working directory and a missing executable **identically**:
 * both arrive as `ENOENT` with `error.path` set to the *program*, never to the
 * directory. So the obvious message blames the program for a directory that does not
 * exist — observed against a real model as `could not run 'bash': spawn bash ENOENT`
 * for a bash that was installed and on `PATH`.
 *
 * That misattribution is expensive rather than untidy. These messages are written for a
 * model to read and retry against, and a model told the shell is missing stops using the
 * shell; it cannot recover, because the thing it would need to fix is one field away and
 * not mentioned. So the directory is checked before the blame is assigned.
 *
 * The `existsSync` call is on the failure path only — once per failed spawn, never in the
 * success path — which is why a synchronous check is acceptable here.
 */
function describeSpawnFailure(error: Error, file: string, cwd: string): string {
  if (errorCode(error) === 'ENOENT' && !existsSync(cwd)) {
    return (
      `could not run '${file}': the working directory '${cwd}' does not exist. ` +
      `The program itself was not the problem; pass a directory that exists.`
    );
  }
  return `could not run '${file}': ${error.message}`;
}

/**
 * One `spawn` per call, no shell, nothing retained.
 *
 * `shell: false` is not a default being accepted, it is the point: the argv the
 * gate authorized is the argv that runs, with no intervening interpretation.
 *
 * ### A kill reaches the process, not its descendants
 *
 * `kill` terminates the process this broker started. It does **not** terminate that
 * process's children: `bash -lc "sleep 90"` leaves `sleep` running when the shell is
 * killed, on every platform, and the same is true of a test runner's workers or a dev
 * server's reloader.
 *
 * The turn no longer *waits* for those descendants — see the `exit` handler in
 * {@link exec} — so a timeout and a cancellation both return promptly. But the
 * descendants keep running unsupervised until they finish on their own. Killing a whole
 * process tree needs a process group on POSIX (`detached` plus a negative-pid signal) and
 * a `taskkill /T` equivalent on Windows; that is a change to what the broker contract
 * promises about containment and belongs with the `@adze/sandbox` work in ADR-0007, not
 * as an untested platform branch here.
 *
 * Stated rather than omitted, because "the command was killed" reads as though nothing
 * survived it, and on this broker that is not what happened.
 */
export class NodeSubprocessBroker implements SandboxBroker {
  readonly name = 'node-subprocess';
  private readonly baseEnv: Record<string, string>;

  constructor(options: NodeSubprocessBrokerOptions = {}) {
    this.baseEnv = scrubEnvironment(options.env ?? process.env, {
      ...(options.allowEnv === undefined ? {} : { allow: options.allowEnv }),
      ...(options.denyEnv === undefined ? {} : { deny: options.denyEnv }),
    });
  }

  /**
   * Always `gate-only` for a containment mode, on every platform.
   *
   * This broker runs an ordinary child process; there is no kernel boundary to
   * claim. Returning `os-level` on macOS or Linux because the *platform* could
   * contain a process would be the exact dishonesty ADR-0007 refuses — the question
   * is what this code does, and it does nothing. A real answer requires
   * `@adze/sandbox`; until then the truthful answer is that the gate is all there is.
   */
  enforcement(mode: SandboxMode): SandboxEnforcement {
    return mode === 'full-access' ? 'not-applicable' : 'gate-only';
  }

  async exec(request: CommandRequest): Promise<CommandOutcome> {
    const startedAt = Date.now();
    const [file, ...args] = request.command;
    if (file === undefined) {
      return { kind: 'spawn-failed', message: 'empty command', durationMs: 0 };
    }

    return await new Promise<CommandOutcome>((resolve) => {
      const child = spawn(file, args, {
        cwd: request.cwd,
        env: { ...this.baseEnv, ...request.env },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let outputCapped = false;
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      const append = (target: 'out' | 'err', chunk: Buffer): void => {
        const current = target === 'out' ? stdout : stderr;
        if (Buffer.byteLength(current, 'utf8') >= MAX_STREAM_BYTES) {
          outputCapped = true;
          return;
        }
        const text = chunk.toString('utf8');
        if (target === 'out') stdout += text;
        else stderr += text;
      };

      child.stdout?.on('data', (chunk: Buffer) => append('out', chunk));
      child.stderr?.on('data', (chunk: Buffer) => append('err', chunk));

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, request.timeoutMs);

      const onAbort = (): void => {
        cancelled = true;
        child.kill('SIGKILL');
      };
      request.signal.addEventListener('abort', onAbort, { once: true });

      const cleanup = (): void => {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
      };

      const settle = (outcome: CommandOutcome): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
      };

      let exitCode: number | null = null;
      let exitSignal: string | null = null;

      const completed = (): CommandOutcome => ({
        kind: 'completed',
        exitCode,
        signal: exitSignal,
        stdout,
        stderr,
        timedOut,
        cancelled,
        outputCapped,
        durationMs: Date.now() - startedAt,
        enforcement: this.enforcement(request.containment.mode),
      });

      child.on('error', (error: Error) => {
        settle({
          kind: 'spawn-failed',
          message: describeSpawnFailure(error, file, request.cwd),
          durationMs: Date.now() - startedAt,
        });
      });

      /**
       * The process is gone. Settle here **only when it was killed.**
       *
       * `close` is the honest moment for a command that ended on its own: it fires once
       * every stdio pipe has drained, which is what guarantees the last bytes of output
       * were collected. But those pipes are inherited by descendants, and a descendant
       * that outlives the kill holds them open — so on a kill, `close` can be withheld for
       * as long as the descendant runs.
       *
       * That made the timeout bound nothing for any command that spawns a child, which is
       * every `bash -lc` running a real program. Measured: a killed `bash -lc "sleep 12"`
       * fires `exit` at 1.5 s and `close` at 12.5 s, and a turn given `--max-time 15`
       * against `sleep 90` took 94 s — the shell died on schedule and the engine waited
       * anyway.
       *
       * Settling early is sound precisely because we killed it: the decision to stop
       * caring about further output has already been made, and whatever arrived before the
       * kill is still reported.
       *
       * The descendant itself is **not** killed with its parent — see the class comment.
       */
      child.on('exit', (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        if (!timedOut && !cancelled) return;
        // Outcome first, so what it reports is exactly what had arrived by the kill.
        settle(completed());
        // Then let go of the pipes. A descendant that outlived the kill still holds them,
        // and libuv keeps the event loop alive for as long as they are open — so without
        // this the *process* does not exit either. Measured end to end: a correctly
        // bounded 15-second turn against `sleep 90` left `adze run` alive for 93 seconds.
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      });

      child.on('close', (code, signal) => {
        if (code !== null) exitCode = code;
        if (signal !== null) exitSignal = signal;
        settle(completed());
      });

      if (request.stdin !== undefined) {
        child.stdin?.end(request.stdin);
      } else {
        // Closed rather than left open: a command that reads stdin would otherwise
        // hang forever, which is the failure mode a persistent session produces
        // and this design exists to avoid.
        child.stdin?.end();
      }
    });
  }
}

/**
 * A broker that runs nothing.
 *
 * For an engine embedded where subprocesses are not acceptable, and for tests that
 * assert the gate refuses before execution — the difference between "the gate denied
 * it" and "it ran and failed" is the whole property under test, and a broker that
 * cannot run anything makes the distinction impossible to fake.
 *
 * Reports `gate-only` for a containment mode rather than `not-applicable`. Nothing
 * can run through it, so there is no subprocess to contain, but the *mode* is still
 * enforced by the gate and by nothing else — engine-side file writes go through the
 * gate's path checks either way. `not-applicable` is reserved for `full-access`,
 * where containment was not requested; using it here would suppress the
 * `no-os-sandbox` warning for a configuration that genuinely has no containment.
 */
export class NullBroker implements SandboxBroker {
  readonly name = 'null';

  enforcement(mode: SandboxMode): SandboxEnforcement {
    return mode === 'full-access' ? 'not-applicable' : 'gate-only';
  }

  async exec(): Promise<CommandOutcome> {
    return await Promise.resolve({
      kind: 'spawn-failed',
      message: 'no sandbox broker is configured, so no command can run',
      durationMs: 0,
    });
  }
}
