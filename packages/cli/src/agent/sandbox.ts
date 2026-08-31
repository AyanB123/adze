/**
 * Wiring `@adze/sandbox` into the CLI, and reporting what it will actually do.
 *
 * `@adze/core` decides **whether** a command may run. `@adze/sandbox` decides **what it
 * can touch** once running. Nothing joined them: the CLI built core's
 * `NodeSubprocessBroker`, which is documented as "always `gate-only` for a containment
 * mode, on every platform", so roughly 2,965 lines of tested containment sat in the
 * repository unreachable from anything a user ran while the roadmap told a reader that
 * macOS and Linux reported `os-level`. This module is the join.
 *
 * Every broker in `@adze/sandbox` satisfies core's `SandboxBroker` structurally, so this
 * is a constructor argument in a surface and **no change to core** — which is what
 * ADR-0007 and the package's own README anticipated.
 *
 * ### Why the reporting helpers live here rather than in each command
 *
 * `doctor`, `run`, and `chat` all describe containment to a user. Three call sites
 * deriving three descriptions from the same plan is how a startup banner ends up
 * disagreeing with `doctor` on the same machine, and a security display that disagrees
 * with itself is worse than one that says less. So the plan is rendered in one place and
 * every surface path reads it.
 *
 * ### What is deliberately not claimed
 *
 * {@link ContainmentPlan.enforcement} is `os-level` only where a kernel mechanism was
 * actually selected, and the plan cannot report `os-level` while carrying a
 * containment-scope degradation — that is a property of how `planFor` constructs it, not
 * a rule this file has to remember. The **syscall surface is unrestricted in every case,
 * including `os-level`**, and that arrives as a `syscall-surface-unrestricted`
 * degradation which {@link degradationLines} prints rather than filtering out.
 */

import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ApprovalPolicy, CommandRule, SandboxMode } from '@adze/protocol';
import {
  type ContainmentPlan,
  createSandbox,
  type Degradation,
  detectCapabilities,
  type HostProbe,
  nodeHostProbe,
  type SandboxBroker,
  type SandboxCapabilities,
  type SandboxMechanism,
} from '@adze/sandbox';

export interface CliSandboxRequest {
  readonly mode: SandboxMode;
  /**
   * Roots the child may write under `workspace-write`.
   *
   * Must match what core's permission gate will pass to `exec`, which is
   * `SandboxConfig.writableRoots` or the workspace root when that is empty. A plan built
   * from different roots than the ones enforced would be a report about a boundary that
   * is not the one in force.
   */
  readonly writableRoots: readonly string[];
  readonly approvals: ApprovalPolicy;
  readonly commandRules: readonly CommandRule[];
  /**
   * Test seam: a fake host, so every platform branch is reachable from any runner.
   *
   * Without it a test of the Windows report can only run on Windows and a test of the
   * Seatbelt report can only run on macOS, which means neither is checked on the machine
   * where the code is written.
   */
  readonly probe?: HostProbe;
}

/** The broker the gate authorizes against, and the boundary it will apply. */
export interface CliSandbox {
  readonly broker: SandboxBroker;
  readonly plan: ContainmentPlan;
}

/**
 * Select a broker for this host and report the plan it will apply.
 *
 * One entry point, so no command has to know which mechanism belongs to which platform
 * and two commands cannot disagree about it.
 */
export async function createCliSandbox(request: CliSandboxRequest): Promise<CliSandbox> {
  const capabilities = request.probe === undefined ? await hostCapabilities() : undefined;
  const { broker, plan } = await createSandbox({
    sandbox: {
      mode: request.mode,
      writableRoots: request.writableRoots,
      commandRules: request.commandRules,
      approvals: request.approvals,
    },
    // Passed as a Seatbelt option rather than as a writable root on purpose: a
    // subprocess writing a temporary file is a containment question, and widening the
    // gate's write boundary to `$TMPDIR` would let the `write` tool land files there
    // without an approval. The two boundaries are not the same boundary.
    seatbelt: { writableTemp: temporaryRoots() },
    ...(request.probe === undefined ? {} : { probe: request.probe }),
    ...(capabilities === undefined ? {} : { capabilities }),
  });
  return { broker, plan };
}

/**
 * Capability detection for the real host, done once per process.
 *
 * Detection is a few hundred `fs.access` calls: `whichExecutable` walks every `PATH`
 * entry, and on Windows it expands each candidate across `PATHEXT` in two cases. Measured
 * on one Windows host with `docker` absent, that is roughly 400 ms — small next to a model
 * request, and not small when `doctor` is invoked thirty times in one test worker, which
 * is how it first showed up as a five-second timeout.
 *
 * Cached rather than recomputed because it describes the machine, and the machine does not
 * change inside one `adze` invocation. **A caller that injects a probe bypasses this
 * entirely**, which is what keeps the cache from leaking one test's fake host into the
 * next: the memo only ever holds the answer for the real one.
 */
let realHostCapabilities: Promise<SandboxCapabilities> | undefined;

function hostCapabilities(): Promise<SandboxCapabilities> {
  realHostCapabilities ??= detectCapabilities(nodeHostProbe());
  return realHostCapabilities;
}

/**
 * The temporary directory, in every spelling the kernel might resolve it to.
 *
 * `os.tmpdir()` on macOS returns a path under `/var/folders`, and `/var` is a symlink
 * into `/private`. Seatbelt evaluates `subpath` against the path the kernel has
 * **already** resolved, so a rule naming `/var/folders/x` never matches a write the
 * kernel sees as `/private/var/folders/x`. `SeatbeltBroker` resolves this for
 * `plan.writableRoots` and not for `writableTemp`, so the caller has to — and getting it
 * wrong is invisible: writes to `$TMPDIR` are denied and the `EPERM` surfaces as a bug in
 * the user's compiler rather than in our profile.
 *
 * Both spellings are returned. A path that is already canonical resolves to itself, so
 * the second rule is inert rather than wrong.
 */
function temporaryRoots(): readonly string[] {
  const base = tmpdir();
  const roots = [base];
  try {
    const resolved = realpathSync.native(base);
    if (resolved !== base) roots.push(resolved);
  } catch {
    // The temp directory should exist, but a `realpath` failure here must degrade to the
    // unresolved spelling rather than dropping temp writability altogether.
  }
  return roots;
}

/** How a mechanism is spelled in prose. `bwrap` and `sandbox-exec` are not brand names. */
const MECHANISM_NAMES: Readonly<Record<SandboxMechanism, string>> = {
  seatbelt: 'Seatbelt',
  bubblewrap: 'bubblewrap',
  docker: 'Docker',
  // Named for what it is rather than "windows": the broker applies argv-array spawning
  // and process-tree teardown and confines nothing, and a reader comparing platforms
  // deserves that distinction in the one word they will read.
  'windows-partial': 'no Windows mechanism (taskkill teardown only)',
  none: 'none',
};

export function mechanismName(mechanism: SandboxMechanism): string {
  return MECHANISM_NAMES[mechanism];
}

/**
 * One line for a startup banner: what is enforced, and by what.
 *
 * Names the mechanism even when enforcement is `gate-only`, because "gate-only" alone
 * does not distinguish "this platform has nothing" from "bwrap is installed and user
 * namespaces are switched off", and only the second is something the user can fix.
 */
export function containmentLine(plan: ContainmentPlan): string {
  switch (plan.enforcement) {
    case 'os-level':
      return `containment: os-level via ${mechanismName(plan.mechanism)}`;
    case 'not-applicable':
      return 'containment: not applicable (full-access was requested)';
    default:
      return `containment: gate-only, ${mechanismName(plan.mechanism)}`;
  }
}

/**
 * Every gap in the plan, worst first, one line each.
 *
 * Ordered `containment` → `functionality` → `hardening` because only the first is a
 * security claim: it means the delivered boundary is weaker than the one that was asked
 * for. Nothing is filtered. A degradation list that a surface trimmed for brevity would
 * leave a user believing in a boundary that is not there, which is the failure ADR-0007
 * refuses by name.
 */
export function degradationLines(plan: ContainmentPlan): readonly string[] {
  return orderedDegradations(plan).map((gap) => `[${gap.code}] ${gap.message}`);
}

const SCOPE_ORDER: Readonly<Record<Degradation['scope'], number>> = {
  containment: 0,
  functionality: 1,
  hardening: 2,
};

export function orderedDegradations(plan: ContainmentPlan): readonly Degradation[] {
  return [...plan.degradations].sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]);
}

/** The plan as a machine-readable document, for `doctor --json`. */
export function containmentJson(plan: ContainmentPlan): Record<string, unknown> {
  return {
    mode: plan.mode,
    mechanism: plan.mechanism,
    enforcement: plan.enforcement,
    // Derived from `enforcement` rather than computed a second way, so the boolean and
    // the string cannot disagree. Two independent answers to "is this contained" is how
    // one of them ends up wrong.
    osLevelContainment: plan.enforcement === 'os-level',
    readsAnywhere: plan.readsAnywhere,
    writableRoots: [...plan.writableRoots],
    network: {
      policy: plan.network.policy,
      enforced: plan.network.enforced,
      hosts: [...plan.network.hosts],
    },
    degradations: orderedDegradations(plan).map((gap) => ({
      code: gap.code,
      scope: gap.scope,
      message: gap.message,
    })),
  };
}
