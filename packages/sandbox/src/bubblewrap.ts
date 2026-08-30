/**
 * Linux containment via bubblewrap (`bwrap`).
 *
 * ## What is enforced
 *
 * The filesystem is remounted read-only in a fresh mount namespace, with the
 * declared writable roots bound back writable, and network access is removed by
 * unsharing the network namespace. Both bind to the **namespace**, so every
 * descendant is inside them: a process cannot leave a mount or network namespace it
 * was born in, which makes the `bash` → `npm install` → postinstall → `curl` chain a
 * single boundary rather than four.
 *
 * ## What is not enforced
 *
 * No seccomp filter is installed. `bwrap` accepts one as a compiled BPF program, and
 * shipping a syscall allowlist for every toolchain a user might run has the same
 * problem as a `(deny default)` Seatbelt profile: the failures are invisible, land in
 * the user's project, and are indistinguishable from a bug in it. So the syscall
 * surface is unrestricted and every plan says so.
 *
 * ## Availability, and the AppArmor problem
 *
 * bubblewrap needs unprivileged user namespaces. Two sysctls can disable them and
 * some distributions ship them disabled; separately, Ubuntu 23.10 and later restrict
 * unprivileged user namespaces through AppArmor, which breaks a self-built or
 * relocated `bwrap` while a distribution-packaged one keeps working because it ships
 * a profile. `detectCapabilities` reads all three and reports the state. When it is
 * unavailable this broker is not selected at all — the failure mode is a clear
 * message and degradation to `gate-only`, never a crash and never a claim of
 * containment that the first `bwrap` invocation would disprove.
 *
 * ## Injection surface
 *
 * There is none worth the name. Every option and path is a separate `argv` element,
 * so a directory called `$(rm -rf ~)` is passed to `bwrap` as bytes and mounted under
 * that name. This is the concrete payoff of never building a shell string: the
 * Seatbelt path needs escaping because SBPL is text, and this path needs none.
 */

import type { BaseBrokerOptions, Wrapped } from './broker-base.js';
import { ContainedBroker, programNameRefusal, splitArgv } from './broker-base.js';
import type { MechanismCapability } from './policy.js';
import type { CommandRequest, ContainmentPlan, Degradation, SandboxMode } from './types.js';

export interface BubblewrapOptions extends BaseBrokerOptions {
  /** Defaults to `bwrap` resolved on PATH. */
  readonly bwrapPath?: string;
  /**
   * Mount a fresh tmpfs at `/tmp` under `workspace-write`.
   *
   * On by default: a build that cannot write a temporary file fails in ways that
   * read as a broken project. Never applied under `read-only`, where ADR-0007 says
   * nothing is written and a writable tmpfs would contradict that.
   */
  readonly tmpfs?: boolean;
}

/**
 * The `bwrap` argument list for a plan.
 *
 * Pure and exported, so the exact arguments are asserted in tests on macOS and
 * Windows runners as well as Linux. Ordering is significant and is the reason this is
 * one function rather than assembled at the call site: `--ro-bind / /` must come
 * before the writable binds that override it, and `--proc` and `--dev` must come
 * after, because bubblewrap applies operations in the order given.
 */
export function buildBubblewrapArgs(
  plan: ContainmentPlan,
  target: { readonly cwd: string; readonly file: string; readonly args: readonly string[] },
  options: BubblewrapOptions = {},
): readonly string[] {
  const argv: string[] = [
    // The child dies with us. Without it, a killed agent leaves the sandbox and
    // everything in it running, which is the orphan problem the exec layer also
    // guards against — belt and braces, because this one is free.
    '--die-with-parent',
    // Detaches the controlling terminal. Blocks TIOCSTI-style injection of keystrokes
    // into the user's shell, which is a real escape from an otherwise sound sandbox.
    '--new-session',
    '--unshare-user',
    '--unshare-ipc',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-cgroup',
  ];

  if (plan.network.policy !== 'unrestricted') argv.push('--unshare-net');

  // Everything visible, nothing writable. The writable roots are added back below.
  argv.push('--ro-bind', '/', '/');
  argv.push('--proc', '/proc');
  argv.push('--dev', '/dev');

  if (plan.mode === 'workspace-write' && options.tmpfs !== false) {
    argv.push('--tmpfs', '/tmp');
  }
  for (const root of plan.writableRoots) argv.push('--bind', root, root);

  argv.push('--chdir', target.cwd);
  argv.push(target.file, ...target.args);
  return argv;
}

export function bubblewrapCapability(available: boolean, mode: SandboxMode): MechanismCapability {
  const degradations: Degradation[] = [];
  if (available && mode !== 'full-access') {
    degradations.push({
      code: 'syscall-surface-unrestricted',
      scope: 'hardening',
      message:
        'no seccomp filter is installed, so the mount and network namespaces bound the ' +
        'filesystem and the network but not the syscall surface',
    });
  }
  if (!available && mode !== 'full-access') {
    degradations.push({
      code: 'userns-unavailable',
      scope: 'containment',
      message:
        'bubblewrap is unavailable or unprivileged user namespaces are disabled, so no ' +
        'namespace boundary is applied',
    });
  }
  return {
    mechanism: 'bubblewrap',
    confinesFilesystem: available,
    confinesNetwork: available,
    // A network namespace is all-or-nothing. Per-host filtering needs a proxy inside
    // the namespace, which is a separate component and not this one.
    supportsNetworkAllowlist: false,
    confinesSubprocessTree: available,
    degradations,
  };
}

export class BubblewrapBroker extends ContainedBroker {
  readonly name = 'bubblewrap';
  private readonly available: boolean;
  private readonly bwrap: BubblewrapOptions;

  constructor(available: boolean, options: BubblewrapOptions = {}) {
    super(options);
    this.available = available;
    this.bwrap = options;
  }

  capability(mode: SandboxMode): MechanismCapability {
    return bubblewrapCapability(this.available, mode);
  }

  protected wrap(request: CommandRequest, plan: ContainmentPlan): Wrapped {
    const argv = splitArgv(request.command);
    if (argv === undefined) {
      return { ok: false, code: 'empty-command', reason: 'no command was given' };
    }
    if (plan.mode === 'full-access' || !this.available) {
      return { ok: true, file: argv.file, args: argv.args };
    }

    const optionLike = programNameRefusal(argv.file, 'bwrap');
    if (optionLike !== undefined) return optionLike;

    return {
      ok: true,
      file: this.bwrap.bwrapPath ?? 'bwrap',
      args: buildBubblewrapArgs(
        plan,
        { cwd: request.cwd, file: argv.file, args: argv.args },
        this.bwrap,
      ),
    };
  }
}
