/**
 * The shared broker body: decide, wrap, spawn.
 *
 * Four brokers differ only in how they wrap an argv — a Seatbelt profile, a
 * bubblewrap argument list, a Docker invocation, or nothing at all. Everything else
 * is identical, so everything else lives here and is tested once.
 *
 * ## Why the approval check survives into the broker
 *
 * By the time `exec` runs, `@adze/core`'s permission gate has already authorized the
 * call; it is the approval authority and this package must not try to be a second
 * one. So a decision of `requires-approval` is treated as permission granted, and
 * {@link BaseBrokerOptions.assumeApproved} says so explicitly rather than leaving it
 * implicit.
 *
 * Two rules are still re-checked here, and both are re-checked on purpose.
 *
 * A `forbid` command rule is **never** approvable. The gate does not offer it for
 * approval either, so honouring it here cannot contradict a user decision — it can
 * only catch a caller that skipped the gate.
 *
 * An approval policy of `never` refuses here **unconditionally**, including under
 * `assumeApproved`. Under that policy the gate would already have refused, so
 * reaching this line means something upstream is wrong, and the safe response to a
 * possible gate bug is not to run the command. This mirrors what the VS Code surface
 * does with the same rule: defended twice, on purpose, because a policy that
 * silently grants more than it says would make the whole model untrustworthy.
 */

import { scrubEnvironment } from './env.js';
import type { ProcessTreeKiller } from './exec.js';
import { runContained } from './exec.js';
import type { MechanismCapability } from './policy.js';
import { decide, planFor } from './policy.js';
import type {
  ApprovalPolicy,
  CommandOutcome,
  CommandRequest,
  CommandRule,
  ContainmentPlan,
  RefusalCode,
  SandboxBroker,
  SandboxEnforcement,
  SandboxMode,
} from './types.js';

export interface BaseBrokerOptions {
  /** Defaults to `on-request`, the ADR-0007 default. */
  readonly approvals?: ApprovalPolicy;
  readonly commandRules?: readonly CommandRule[];
  /** Base environment. Defaults to the engine's own, after scrubbing. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly allowEnv?: readonly string[];
  readonly denyEnv?: readonly string[];
  /** Defaults to `process.platform`. Injectable so every branch is testable. */
  readonly platform?: string;
  readonly killer?: ProcessTreeKiller;
  readonly maxStreamBytes?: number;
  /**
   * True when a permission gate has already obtained consent. Defaults to true.
   *
   * Set false to use a broker standalone — in a benchmark harness or a preview —
   * where nothing has asked the user and anything needing approval must be refused
   * rather than assumed.
   */
  readonly assumeApproved?: boolean;
}

/** How a mechanism wraps the requested argv, or why it cannot. */
export type Wrapped =
  | { readonly ok: true; readonly file: string; readonly args: readonly string[] }
  | { readonly ok: false; readonly code: RefusalCode; readonly reason: string };

/** The refusal half of {@link Wrapped}, for helpers that only ever refuse. */
export type WrapRefusal = Extract<Wrapped, { readonly ok: false }>;

export abstract class ContainedBroker implements SandboxBroker {
  abstract readonly name: string;

  protected readonly options: BaseBrokerOptions;
  protected readonly platform: string;
  private readonly baseEnv: Record<string, string>;

  constructor(options: BaseBrokerOptions = {}) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
    this.baseEnv = scrubEnvironment(options.env ?? process.env, {
      ...(options.allowEnv === undefined ? {} : { allow: options.allowEnv }),
      ...(options.denyEnv === undefined ? {} : { deny: options.denyEnv }),
    });
  }

  /** What this mechanism can do. The single source of every honesty claim. */
  abstract capability(mode: SandboxMode): MechanismCapability;

  /** Build the argv that applies the plan. Pure; no spawning. */
  protected abstract wrap(request: CommandRequest, plan: ContainmentPlan): Wrapped;

  enforcement(mode: SandboxMode): SandboxEnforcement {
    return planFor(
      { mode, writableRoots: [], allowedNetworkHosts: [] },
      this.capability(mode),
      this.platform,
    ).enforcement;
  }

  /** The plan that would apply, for a surface that wants to explain itself. */
  planFor(request: Pick<CommandRequest, 'containment'>): ContainmentPlan {
    return planFor(request.containment, this.capability(request.containment.mode), this.platform);
  }

  async exec(request: CommandRequest): Promise<CommandOutcome> {
    const startedAt = Date.now();
    const decision = decide({
      containment: request.containment,
      approvals: this.options.approvals ?? 'on-request',
      commandRules: this.options.commandRules ?? [],
      command: request.command,
      cwd: request.cwd,
      capability: this.capability(request.containment.mode),
      platform: this.platform,
    });

    if (decision.kind === 'refuse') {
      return refusal(decision.code, decision.reason, startedAt);
    }
    if (decision.kind === 'requires-approval' && this.options.assumeApproved === false) {
      return refusal(
        'approval-unavailable',
        `refused: this command needs approval (${decision.reason}) and this broker has no ` +
          `approval channel. Route the call through the permission gate, or set an ` +
          `'allow' command rule if it should run unattended.`,
        startedAt,
      );
    }

    const wrapped = this.wrap(request, decision.plan);
    if (!wrapped.ok) return refusal(wrapped.code, wrapped.reason, startedAt);

    return await runContained(
      {
        file: wrapped.file,
        args: wrapped.args,
        cwd: request.cwd,
        env: { ...this.baseEnv, ...request.env },
      },
      {
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        enforcement: decision.plan.enforcement,
        platform: this.platform,
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        ...(this.options.killer === undefined ? {} : { killer: this.options.killer }),
        ...(this.options.maxStreamBytes === undefined
          ? {}
          : { maxStreamBytes: this.options.maxStreamBytes }),
      },
    );
  }
}

/**
 * A refusal, shaped as a spawn failure.
 *
 * Reusing `spawn-failed` is deliberate: the command did not run, and the one thing
 * the model must not conclude is that it ran and failed. `refusal` carries the code
 * so a surface can distinguish "policy said no", which the user can change, from
 * "bash is not installed", which they must fix differently.
 */
export function refusal(code: RefusalCode, message: string, startedAt: number): CommandOutcome {
  return { kind: 'spawn-failed', message, durationMs: Date.now() - startedAt, refusal: code };
}

/** argv split into a file and its arguments, refusing an empty command. */
export function splitArgv(
  command: readonly string[],
): { readonly file: string; readonly args: readonly string[] } | undefined {
  const [file, ...args] = command;
  if (file === undefined || file.length === 0) return undefined;
  return { file, args };
}

/**
 * Reject a program name a wrapper would read as its own flag.
 *
 * The one genuine argument-injection risk left once everything spawns with an
 * argument array. `sandbox-exec`, `bwrap`, and `docker run` all take the target
 * command as trailing positional arguments, and all three stop parsing options at
 * the first non-option word — so `argv[0]` is the only element that can still be
 * misread, and a value like `--bind` would be absorbed by the wrapper and could
 * widen the very boundary being constructed.
 *
 * Refused rather than escaped, because there is nothing to escape: the wrappers have
 * no quoting syntax for a positional argument that looks like a flag, and inventing
 * one would be guessing. A real program whose name starts with `-` does not exist in
 * any toolchain, so the false-positive cost is zero.
 */
export function programNameRefusal(file: string, wrapper: string): WrapRefusal | undefined {
  if (!file.startsWith('-')) return undefined;
  return {
    ok: false,
    code: 'program-name-option-like',
    reason:
      `refused: the program name '${file}' starts with '-', which '${wrapper}' would parse ` +
      `as one of its own options and could widen the sandbox. Invoke it by path, for ` +
      `example './${file}'.`,
  };
}
