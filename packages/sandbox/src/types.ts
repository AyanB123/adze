/**
 * The sandbox broker seam, mirrored structurally from `@adze/core`.
 *
 * ## Why these types are duplicated rather than imported
 *
 * `@adze/core` already declares `SandboxBroker`, `CommandRequest`, and
 * `CommandOutcome` in `packages/core/src/broker.ts`. This package deliberately
 * does not import them, and the reason is a dependency rule rather than
 * convenience: a service package may not import `@adze/protocol`, and core's
 * broker seam is written in terms of protocol's `SandboxMode` and
 * `SandboxEnforcement`. Importing core would pull protocol in transitively and
 * make this package's dependency graph a lie.
 *
 * So the seam is re-declared here as a **structural mirror**. Every broker in this
 * package satisfies core's `SandboxBroker` by shape, which is all TypeScript
 * requires: `createSandboxBroker(...)` can be handed straight to
 * `PermissionGateOptions.broker` with no adapter and no cast.
 *
 * **The cost, stated plainly.** Nothing type-checks the mirror against the
 * original. If core widens `CommandOutcome` or renames a field, this package keeps
 * compiling and the incompatibility appears at the call site in a surface. The
 * mitigation is that the field set is small, frozen by an accepted ADR, and every
 * name here is spelled identically to core's on purpose — a diff between the two
 * files is meant to be readable. A compile-time conformance assertion would be
 * strictly better and is the one thing a `@adze/core` devDependency would buy;
 * `docs/roadmap.md` is where that belongs, not a dependency edge added quietly.
 *
 * ## What this package adds on top of the mirror
 *
 * Core's seam answers "run this argv and tell me how it was contained". It does
 * not describe *how* containment is achieved, because core is not allowed to know.
 * {@link ContainmentPlan} and {@link Degradation} are this package's additions, and
 * they exist for one reason: a broker that cannot enforce something must be able to
 * say so in a machine-readable way, so a surface can warn instead of a user
 * inferring a boundary that is not there.
 */

// ---------------------------------------------------------------------------
// Mirrored from @adze/protocol via @adze/core. Keep spelling identical.
// ---------------------------------------------------------------------------

/** What the process is permitted to do. Mirrors protocol's `SandboxMode`. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'full-access';

/** When the user is asked. Mirrors protocol's `ApprovalPolicy`. */
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';

/**
 * How a command was actually contained. Mirrors protocol's `SandboxEnforcement`.
 *
 * `os-level` is a claim about evidence: a kernel mechanism was applied to this
 * process. No broker in this package returns it unless it really built a profile
 * and really spawned the command inside it.
 */
export type SandboxEnforcement = 'os-level' | 'gate-only' | 'not-applicable';

/** Per-command override, so `npm test` can be allowed without widening the mode. */
export interface CommandRule {
  /** Matched against the start of the argv-joined command string. */
  readonly prefix: string;
  readonly action: 'allow' | 'prompt' | 'forbid';
}

/** Containment the broker is being asked to apply. Mirrors core's `Containment`. */
export interface Containment {
  readonly mode: SandboxMode;
  /** Absolute paths writable under `workspace-write`. */
  readonly writableRoots: readonly string[];
  /** Hosts reachable when the mode would otherwise deny network. */
  readonly allowedNetworkHosts: readonly string[];
}

/** Mirrors core's `CommandRequest`. */
export interface CommandRequest {
  /**
   * argv, already split. Never a shell string.
   *
   * A broker that accepted a string would have to decide how to split it, and that
   * decision is where shell-injection bugs live. Every broker here spawns with an
   * argument array, so a path containing `;` or `$(...)` is inert data.
   */
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly containment: Containment;
  readonly stdin?: string;
}

/** Mirrors core's `CommandCompleted`. */
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
 * The process never started. Mirrors core's `CommandSpawnFailed`.
 *
 * Also how a broker reports a **refusal**: the command did not run, and folding
 * that into an exit code would invite the model to debug a test failure that never
 * happened. {@link RefusalCode} is carried so a surface can tell "bash is missing"
 * apart from "policy said no", which need different responses.
 */
export interface CommandSpawnFailed {
  readonly kind: 'spawn-failed';
  readonly message: string;
  readonly durationMs: number;
  /** Present only when the broker refused. Absent means the launch itself failed. */
  readonly refusal?: RefusalCode;
}

export type CommandOutcome = CommandCompleted | CommandSpawnFailed;

/** Mirrors core's `SandboxBroker`. Every broker in this package satisfies it. */
export interface SandboxBroker {
  readonly name: string;
  /** What this broker can actually enforce for a mode on this platform. */
  enforcement(mode: SandboxMode): SandboxEnforcement;
  exec(request: CommandRequest): Promise<CommandOutcome>;
}

// ---------------------------------------------------------------------------
// This package's additions
// ---------------------------------------------------------------------------

/** The OS facility a plan is built for. */
export type SandboxMechanism = 'seatbelt' | 'bubblewrap' | 'windows-partial' | 'docker' | 'none';

/**
 * Something the requested containment asked for that will not be enforced.
 *
 * The most important type in this package. A broker that silently dropped a
 * requirement would leave a user believing in a boundary that does not exist,
 * which is the failure ADR-0007 refuses by name. Every plan carries the complete
 * list, and {@link ContainmentPlan.enforcement} is never `os-level` when a
 * degradation with `scope: 'containment'` is present.
 */
export interface Degradation {
  readonly code: DegradationCode;
  /** Written for a human reading a CLI warning. */
  readonly message: string;
  /**
   * `containment` means part of the requested boundary is absent, so the delivered
   * boundary is **weaker** than asked for. `hardening` means a defence-in-depth
   * measure is absent but the boundary itself holds. `functionality` means the
   * delivered boundary is **stronger** than asked for and something legitimate will
   * be blocked.
   *
   * The split matters because only `containment` is a security claim. A plan may
   * never report `os-level` enforcement while carrying a `containment` degradation,
   * and {@link ContainmentPlan} is constructed so that it cannot.
   */
  readonly scope: 'containment' | 'hardening' | 'functionality';
}

export type DegradationCode =
  /** No OS mechanism is available at all; the permission gate is the only control. */
  | 'no-os-containment'
  /** Network allowlisting was requested but the mechanism is all-or-nothing. */
  | 'network-allowlist-unsupported'
  /** Network could not be restricted at all. */
  | 'network-unrestricted'
  /** The profile denies writes and network, not arbitrary syscalls. */
  | 'syscall-surface-unrestricted'
  /** In-process path checks do not resolve symlinks; the kernel mechanism does. */
  | 'symlink-escape-unchecked'
  /** Windows: no restricted token is applied to the child. */
  | 'windows-no-restricted-token'
  /** Windows: no job object bounds the child's resources. */
  | 'windows-no-job-object'
  /** Windows: no AppContainer profile isolates the child. */
  | 'windows-no-appcontainer'
  /** bubblewrap is present but unprivileged user namespaces are unavailable. */
  | 'userns-unavailable';

/** Whether the plan restricts network, and whether that restriction is real. */
export interface NetworkPlan {
  readonly policy: 'deny' | 'allowlist' | 'unrestricted';
  readonly hosts: readonly string[];
  /**
   * True only when the mechanism actually applies `policy`.
   *
   * When an allowlist cannot be expressed, `policy` stays `deny` and this stays
   * true, because denying everything is a superset of the requested restriction.
   * Failing closed is the only direction a security default may be wrong in.
   */
  readonly enforced: boolean;
}

/** The boundary a broker will apply, and everything it will not. */
export interface ContainmentPlan {
  readonly mode: SandboxMode;
  readonly mechanism: SandboxMechanism;
  /** Absolute roots the child is explicitly granted read access to. */
  readonly readableRoots: readonly string[];
  /**
   * True when the mechanism leaves reads unrestricted outside `readableRoots`.
   *
   * Seatbelt and bubblewrap as configured here both bind the whole filesystem
   * readable and restrict only writes and network, so this is `true` for them. It
   * is `false` only for Docker, where a path that was not mounted does not exist
   * inside the container. Recorded explicitly because "the read list is empty"
   * otherwise means both "reads everything" and "reads nothing".
   */
  readonly readsAnywhere: boolean;
  /** Absolute roots the child may write. Always empty under `read-only`. */
  readonly writableRoots: readonly string[];
  readonly network: NetworkPlan;
  /** What the mechanism genuinely achieves. Never optimistic. */
  readonly enforcement: SandboxEnforcement;
  readonly degradations: readonly Degradation[];
}

/** Why a command was refused before it ran. Each maps to a distinct user fix. */
export type RefusalCode =
  /** A `forbid` command rule matched. Beats every mode, including full-access. */
  | 'command-forbidden'
  /** Approval was required and the policy is `never`, which refuses. */
  | 'approval-refused'
  /** No approval channel exists at this layer, so consent cannot be obtained. */
  | 'approval-unavailable'
  /** The working directory is outside every readable root. */
  | 'cwd-outside-roots'
  /** A write target is outside every writable root. */
  | 'write-outside-roots'
  /** A write was requested under `read-only`. */
  | 'read-only-violation'
  /** Strict containment was demanded and no mechanism could provide it. */
  | 'mechanism-unavailable'
  /**
   * `argv[0]` begins with `-`, so a wrapper would parse it as its own option.
   *
   * `sandbox-exec`, `bwrap`, and `docker run` all take the command to run as
   * trailing positional arguments. A program name of `--bind` would be consumed by
   * the wrapper as a flag and would widen the sandbox it was supposed to build, so
   * it is refused rather than escaped.
   */
  | 'program-name-option-like'
  /** The argv was empty. */
  | 'empty-command';
