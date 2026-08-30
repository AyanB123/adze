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

    const built = buildSeatbeltProfile(plan, this.seatbelt);
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
