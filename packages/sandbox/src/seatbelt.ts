/**
 * macOS containment via Seatbelt (`sandbox-exec`).
 *
 * ## What is enforced
 *
 * Filesystem writes and network access, for the process **and every descendant**.
 * That inheritance is the property that makes Seatbelt worth using: `bash` runs
 * `npm install`, which runs a postinstall script, which runs `curl`, and all four
 * are inside one boundary because the sandbox is attached to the process and
 * inherited across `fork` and `exec`. A mechanism that contained only the process it
 * launched would contain nothing that matters.
 *
 * ## What is not enforced, and why the profile is written this way
 *
 * The profile starts from `(allow default)` and denies writes and network, rather
 * than starting from `(deny default)` and allowing what a toolchain needs.
 *
 * A `(deny default)` profile is a stronger boundary and is not shippable. It
 * requires enumerating every operation a compiler, a package manager, a test runner
 * and a linker perform — mach lookups, sysctl reads, IOKit access, dyld's shared
 * cache, per-tool preference files — and any omission is a build failure that looks
 * like a bug in the user's project rather than in our profile. The result is a
 * sandbox users turn off, which contains nothing at all.
 *
 * So the claim is narrow and exact: **writes outside the writable roots are blocked
 * and network is blocked.** Arbitrary syscalls are not restricted, so this is
 * containment against an agent doing damage, not a boundary against code trying to
 * escape. That distinction is recorded as a `syscall-surface-unrestricted`
 * degradation on every plan, so a surface can state it rather than a reader assuming
 * the stronger claim.
 *
 * Seatbelt is also formally deprecated by Apple and has been since 10.14, with no
 * replacement offered for this use. Every sandboxing tool on macOS uses it anyway.
 *
 * ## Injection surface
 *
 * The profile is a string, and a path is interpolated into it. That makes it the one
 * place in this package where a quoting mistake would be a security bug rather than
 * a crash, so {@link buildSeatbeltProfile} escapes what it can and **refuses** what
 * it cannot: a path containing a newline or a control character cannot be safely
 * represented in a quoted SBPL string, and a refusal is the correct outcome. The
 * profile itself is passed as a single `argv` element to `sandbox-exec -p`, never
 * through a shell and never through a temporary file.
 */

import { realpathSync } from 'node:fs';
import type { BaseBrokerOptions, Wrapped } from './broker-base.js';
import { ContainedBroker, programNameRefusal, splitArgv } from './broker-base.js';
import type { MechanismCapability } from './policy.js';
import type { CommandRequest, ContainmentPlan, Degradation, SandboxMode } from './types.js';

/**
 * Devices that stay writable in every mode, including `read-only`.
 *
 * Opening `/dev/null` for write is not "writing a file" in any sense a user means,
 * and denying it breaks essentially every program that redirects output. Listed
 * explicitly rather than pattern-matched on `/dev/`, because `/dev/disk0` is a real
 * path under that prefix and writing it destroys the machine.
 */
const DEFAULT_WRITABLE_DEVICES: readonly string[] = [
  '/dev/null',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/tty',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/dtracehelper',
];

export interface SeatbeltOptions extends BaseBrokerOptions {
  /** Defaults to `sandbox-exec` resolved on PATH. */
  readonly sandboxExecPath?: string;
  /** Overrides {@link DEFAULT_WRITABLE_DEVICES}. */
  readonly writableDevices?: readonly string[];
  /**
   * Temporary directories made writable under `workspace-write`.
   *
   * Not writable under `read-only`. ADR-0007 says `read-only` writes nothing, and
   * quietly excepting `/tmp` because compilers need it would make the mode's one
   * sentence of documentation false. A `read-only` run genuinely cannot build most
   * projects, and that is the mode working as specified rather than a defect.
   */
  readonly writableTemp?: readonly string[];
  /**
   * Resolves a path through symlinks. Defaults to `fs.realpathSync.native`.
   *
   * Injected so {@link expandSymlinkedRoots} is exercised on every runner rather
   * than only on macOS.
   */
  readonly resolvePath?: (path: string) => string;
}

/**
 * Expand writable roots to include their symlink-resolved spelling.
 *
 * macOS ships `/var`, `/tmp`, and `/etc` as symlinks into `/private`, and
 * `os.tmpdir()` returns a path under `/var/folders`. Seatbelt evaluates `subpath`
 * against the path the **kernel has already resolved**, so a rule naming
 * `/var/folders/x` never matches a write the kernel sees as `/private/var/folders/x`.
 * The write is then denied inside a directory the caller explicitly declared
 * writable.
 *
 * That failure mode is worse than a crash. The sandbox over-blocks silently, and the
 * `EPERM` surfaces as a bug in the user's compiler or package manager rather than in
 * our profile — which is exactly the outcome the module docblock above says makes a
 * sandbox get switched off. Kernel path resolution is documented elsewhere in this
 * package as a safety property; it is also a correctness obligation, because a rule
 * written in a spelling the kernel never sees is a rule about a path that does not
 * exist.
 *
 * Both spellings are emitted rather than only the resolved one. A root that is
 * already canonical resolves to itself, so the extra rule is inert; keeping the
 * original means a `realpath` failure degrades to today's behaviour instead of
 * dropping the root entirely.
 */
export function expandSymlinkedRoots(
  roots: readonly string[],
  resolve: (path: string) => string,
): readonly string[] {
  const expanded: string[] = [];
  for (const root of roots) {
    if (!expanded.includes(root)) expanded.push(root);
    let resolved: string;
    try {
      resolved = resolve(root);
    } catch {
      // The root need not exist yet — a writable root is often created by the
      // command we are about to run. The unresolved spelling is all we have.
      continue;
    }
    if (resolved !== root && !expanded.includes(resolved)) expanded.push(resolved);
  }
  return expanded;
}

export type SeatbeltProfile =
  | { readonly ok: true; readonly profile: string }
  | { readonly ok: false; readonly unsafePath: string };

/**
 * Escape a path for an SBPL string literal.
 *
 * Backslash first, then quote — the other order double-escapes and produces a
 * profile that silently matches nothing, which is the failure mode where a sandbox
 * appears to work while enforcing a rule about a path that does not exist.
 */
function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Newline, NUL, and other control characters cannot be represented safely. */
function representable(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: detecting them is the point
  return !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Build the SBPL profile for a plan.
 *
 * Pure, so the generated policy is asserted directly in tests on Linux and Windows
 * runners. A profile builder that could only be checked by observing macOS behaviour
 * would be reviewed by nobody.
 */
export function buildSeatbeltProfile(
  plan: ContainmentPlan,
  options: SeatbeltOptions = {},
): SeatbeltProfile {
  const devices = options.writableDevices ?? DEFAULT_WRITABLE_DEVICES;
  const temp = plan.mode === 'workspace-write' ? (options.writableTemp ?? []) : [];
  const writable = [...plan.writableRoots, ...temp];

  for (const path of [...writable, ...devices]) {
    if (!representable(path)) return { ok: false, unsafePath: path };
  }

  const lines = [
    '(version 1)',
    ';; Adze sandbox: writes and network are denied; the syscall surface is not',
    ';; restricted. See packages/sandbox/src/seatbelt.ts for why.',
    '(allow default)',
    '(deny file-write*)',
  ];

  for (const device of devices) lines.push(`(allow file-write* (literal ${sbplString(device)}))`);
  for (const root of writable) lines.push(`(allow file-write* (subpath ${sbplString(root)}))`);

  if (plan.network.policy !== 'unrestricted') lines.push('(deny network*)');

  return { ok: true, profile: `${lines.join('\n')}\n` };
}

/**
 * The Seatbelt capability, and the honesty attached to it.
 *
 * `available` is supplied by the caller from {@link detectCapabilities} rather than
 * inferred from `process.platform`. Asking the platform whether the *platform* could
 * contain a process, and reporting that as containment, is precisely the claim
 * ADR-0007 refuses.
 */
export function seatbeltCapability(available: boolean, mode: SandboxMode): MechanismCapability {
  const degradations: Degradation[] = [];
  if (available && mode !== 'full-access') {
    degradations.push({
      code: 'syscall-surface-unrestricted',
      scope: 'hardening',
      message:
        'the Seatbelt profile denies filesystem writes and network access but permits other ' +
        'operations by default, so it contains an agent doing damage rather than code trying ' +
        'to escape',
    });
  }
  return {
    mechanism: 'seatbelt',
    confinesFilesystem: available,
    confinesNetwork: available,
    // Seatbelt cannot express a hostname allowlist; only addresses and sockets.
    supportsNetworkAllowlist: false,
    confinesSubprocessTree: available,
    degradations,
  };
}

export class SeatbeltBroker extends ContainedBroker {
  readonly name = 'seatbelt';
  private readonly available: boolean;
  private readonly seatbelt: SeatbeltOptions;

  /**
   * @param available Whether `sandbox-exec` was actually found. Passed in rather
   * than probed, so a test can exercise the degraded path without uninstalling a
   * system binary.
   */
  constructor(available: boolean, options: SeatbeltOptions = {}) {
    super(options);
    this.available = available;
    this.seatbelt = options;
  }

  capability(mode: SandboxMode): MechanismCapability {
    return seatbeltCapability(this.available, mode);
  }

  protected wrap(request: CommandRequest, plan: ContainmentPlan): Wrapped {
    const argv = splitArgv(request.command);
    if (argv === undefined) {
      return { ok: false, code: 'empty-command', reason: 'no command was given' };
    }
    if (plan.mode === 'full-access' || !this.available) {
      // Nothing to wrap. The plan already reports `gate-only`, so this is not a
      // silent downgrade — the outcome carries the weaker claim.
      return { ok: true, file: argv.file, args: argv.args };
    }

    const optionLike = programNameRefusal(argv.file, 'sandbox-exec');
    if (optionLike !== undefined) return optionLike;

    // Resolve symlinked roots before the profile is built. `/var/folders/...` from
    // `os.tmpdir()` must also appear as `/private/var/folders/...`, or the kernel
    // matches neither and denies a write the caller declared legal.
    const resolve = this.seatbelt.resolvePath ?? realpathSync.native;
    const planned: ContainmentPlan = {
      ...plan,
      writableRoots: expandSymlinkedRoots(plan.writableRoots, resolve),
    };

    const built = buildSeatbeltProfile(planned, this.seatbelt);
    if (!built.ok) {
      return {
        ok: false,
        code: 'mechanism-unavailable',
        reason:
          `refused: the path '${built.unsafePath}' contains a control character and cannot ` +
          `be expressed safely in a Seatbelt profile. Running without the profile would ` +
          `drop containment silently, so the command is refused instead.`,
      };
    }

    return {
      ok: true,
      file: this.seatbelt.sandboxExecPath ?? 'sandbox-exec',
      // `-p <profile>` then `--` then the argv. The profile is one argument; no
      // shell, no temporary file, and nothing that re-splits the command.
      args: ['-p', built.profile, '--', argv.file, ...argv.args],
    };
  }
}
