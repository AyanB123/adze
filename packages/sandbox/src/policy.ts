/**
 * The two-axis model, as pure logic.
 *
 * Nothing in this file touches the filesystem, spawns a process, or reads
 * `process.platform`. That is deliberate: the mode-and-policy matrix is the part of
 * a sandbox that is easiest to get subtly wrong and hardest to test through a real
 * kernel mechanism, so it is separated out and tested exhaustively on every CI
 * platform.
 *
 * ## Relationship to the permission gate in `@adze/core`
 *
 * The gate and this module are **not** the same decision, and this is not a
 * parallel abstraction competing with it.
 *
 * The gate decides *whether a human is asked* and is the only thing that mints a
 * capability. It runs once per tool call, over declared effects, before anything
 * executes. This module decides *what boundary the OS will apply* to a specific
 * argv, and runs inside the broker at spawn time. The gate cannot make that
 * decision because it is forbidden from knowing that Seatbelt exists.
 *
 * The two do re-derive some of the same rules — a `forbid` prefix, `never`
 * refusing — and that overlap is intentional defence in depth with a strict
 * direction: **this layer may refuse something the gate allowed, and may never
 * permit something the gate would have refused.** A second independent check that
 * can only be more restrictive is worth its duplication; one that could be more
 * permissive would be a hole.
 *
 * ## `never` cannot escalate, structurally
 *
 * {@link planFor} does not take an {@link ApprovalPolicy} argument. The boundary is
 * therefore not a function of the approval policy, so no policy value can widen it
 * — including `never`. All `never` can do is turn what would have been an approval
 * prompt into a refusal. That is a property of the function signature rather than
 * of a branch someone has to remember to write, and the test suite asserts it
 * across the whole matrix rather than trusting the argument.
 */

import { classifyPath, flavorFor, normalizeRoots } from './paths.js';
import type {
  ApprovalPolicy,
  CommandRule,
  Containment,
  ContainmentPlan,
  Degradation,
  NetworkPlan,
  RefusalCode,
  SandboxEnforcement,
  SandboxMechanism,
} from './types.js';

/**
 * What a mechanism can actually do, as claimed by the broker that owns it.
 *
 * Separating this from the mechanism name is what keeps {@link planFor} honest
 * without it needing a table of OS facts: a broker that discovers at runtime that
 * bubblewrap is present but user namespaces are not reports
 * `confinesFilesystem: false` and the plan degrades itself accordingly.
 */
export interface MechanismCapability {
  readonly mechanism: SandboxMechanism;
  /** True when writes outside the writable roots are blocked by the kernel. */
  readonly confinesFilesystem: boolean;
  /** True when the mechanism can block network access. */
  readonly confinesNetwork: boolean;
  /** True when per-host allowlisting can be expressed. Almost never true. */
  readonly supportsNetworkAllowlist: boolean;
  /**
   * True when the boundary is inherited by grandchildren.
   *
   * The property that matters most in practice: `bash` runs `npm install`, which
   * runs a postinstall script, which runs `curl`. A mechanism that contains only
   * the process it launched contains nothing useful, so this being false forces
   * enforcement down to `gate-only`.
   */
  readonly confinesSubprocessTree: boolean;
  /** Mechanism-specific gaps, merged into every plan it produces. */
  readonly degradations: readonly Degradation[];
  /** True when only explicitly bound paths are visible. Docker only. */
  readonly readsOnlyBoundPaths?: boolean;
}

export interface PolicyInput {
  readonly containment: Containment;
  readonly approvals: ApprovalPolicy;
  readonly commandRules: readonly CommandRule[];
  readonly command: readonly string[];
  readonly cwd: string;
  readonly capability: MechanismCapability;
  /** Selects the path flavour. Never read from the process. */
  readonly platform: string;
}

export type SandboxDecision =
  | { readonly kind: 'permit'; readonly plan: ContainmentPlan }
  | {
      readonly kind: 'requires-approval';
      /** The boundary that applies if approved. Identical to the permit plan. */
      readonly plan: ContainmentPlan;
      readonly reason: string;
    }
  | { readonly kind: 'refuse'; readonly code: RefusalCode; readonly reason: string };

/**
 * Longest matching prefix wins.
 *
 * Mirrors `matchCommandRule` in core's permission gate, deliberately including the
 * tie-breaking rule: `git push` must be able to override a broader `git` rule, and
 * taking the first match in declaration order would make policy depend on config
 * ordering, which nobody can reason about at the moment it matters.
 */
export function matchCommandRule(
  rules: readonly CommandRule[],
  command: string,
): CommandRule | undefined {
  let best: CommandRule | undefined;
  for (const rule of rules) {
    if (!command.startsWith(rule.prefix)) continue;
    if (best === undefined || rule.prefix.length > best.prefix.length) best = rule;
  }
  return best;
}

/**
 * Build the boundary for a containment request and a mechanism.
 *
 * Takes no approval policy, by design — see the module comment. Also clamps its own
 * enforcement claim at the end, so a plan admitting a `containment` degradation
 * cannot simultaneously report `os-level`.
 */
export function planFor(
  containment: Containment,
  capability: MechanismCapability,
  platform: string,
): ContainmentPlan {
  const flavor = flavorFor(platform);
  const requested = normalizeRoots(containment.writableRoots, flavor);
  const degradations = [...capability.degradations];

  for (const bad of requested.rejected) {
    degradations.push({
      code: 'no-os-containment',
      scope: 'functionality',
      message:
        `writable root '${bad}' is not an absolute path and was ignored; ` +
        `relative roots are rejected rather than resolved against the working directory`,
    });
  }

  const writableRoots = containment.mode === 'workspace-write' ? requested.roots : [];
  const readsAnywhere = capability.readsOnlyBoundPaths !== true;
  const network = planNetwork(containment, capability, degradations);

  if (containment.mode !== 'full-access' && !capability.confinesFilesystem) {
    degradations.push({
      code: 'no-os-containment',
      scope: 'containment',
      message:
        `sandbox mode '${containment.mode}' has no OS-level filesystem containment via ` +
        `'${capability.mechanism}': an approved command is not confined once it runs`,
    });
  }

  return {
    mode: containment.mode,
    mechanism: capability.mechanism,
    readableRoots: requested.roots,
    readsAnywhere,
    writableRoots,
    network,
    enforcement: clampEnforcement(containment, capability, degradations),
    degradations,
  };
}

function planNetwork(
  containment: Containment,
  capability: MechanismCapability,
  degradations: Degradation[],
): NetworkPlan {
  const hosts = [...containment.allowedNetworkHosts];
  if (containment.mode === 'full-access') {
    return { policy: 'unrestricted', hosts: [], enforced: true };
  }
  if (!capability.confinesNetwork) {
    degradations.push({
      code: 'network-unrestricted',
      scope: 'containment',
      message:
        `sandbox mode '${containment.mode}' denies network access, but '${capability.mechanism}' ` +
        `cannot restrict it, so the command reaches the network unimpeded`,
    });
    return { policy: 'unrestricted', hosts, enforced: false };
  }
  if (hosts.length > 0 && !capability.supportsNetworkAllowlist) {
    // Fails closed. Denying more than requested breaks a legitimate fetch, which is
    // a bug report; allowing more than requested is a silent hole nobody notices.
    degradations.push({
      code: 'network-allowlist-unsupported',
      scope: 'functionality',
      message:
        `'${capability.mechanism}' cannot express a per-host network allowlist, so all ` +
        `network access is denied and ${hosts.join(', ')} will be unreachable; a filtering ` +
        `proxy is what would honour the allowlist`,
    });
    return { policy: 'deny', hosts, enforced: true };
  }
  if (hosts.length > 0) return { policy: 'allowlist', hosts, enforced: true };
  return { policy: 'deny', hosts: [], enforced: true };
}

/**
 * The honesty clamp.
 *
 * `os-level` requires a filesystem boundary that survives into grandchildren, and
 * requires that no `containment`-scope gap has been admitted. Anything less is
 * `gate-only`, which is what makes core's `no-os-sandbox` warning fire.
 */
function clampEnforcement(
  containment: Containment,
  capability: MechanismCapability,
  degradations: readonly Degradation[],
): SandboxEnforcement {
  if (containment.mode === 'full-access') return 'not-applicable';
  if (degradations.some((d) => d.scope === 'containment')) return 'gate-only';
  if (!capability.confinesFilesystem) return 'gate-only';
  if (!capability.confinesSubprocessTree) return 'gate-only';
  return 'os-level';
}

/**
 * Decide what happens to one command.
 *
 * Ordering is load-bearing and is the same ordering the gate uses: a `forbid` rule
 * is evaluated before the mode, so an explicit prohibition beats `full-access`. A
 * prohibition that a permissive mode could override would be advisory rather than a
 * rule.
 */
export function decide(input: PolicyInput): SandboxDecision {
  if (input.command.length === 0) {
    return { kind: 'refuse', code: 'empty-command', reason: 'no command was given' };
  }

  const joined = input.command.join(' ');
  const rule = matchCommandRule(input.commandRules, joined);
  if (rule?.action === 'forbid') {
    return {
      kind: 'refuse',
      code: 'command-forbidden',
      reason:
        `refused: a command rule forbids the prefix '${rule.prefix}'. An explicit ` +
        `prohibition is not offered for approval and is not overridden by the sandbox mode.`,
    };
  }

  const plan = planFor(input.containment, input.capability, input.platform);

  const reach = reachabilityRefusal(input, plan);
  if (reach !== undefined) return reach;

  const approval = approvalReason(input, plan, rule);
  if (approval === undefined) return { kind: 'permit', plan };

  if (input.approvals === 'never') {
    return {
      kind: 'refuse',
      code: 'approval-refused',
      reason:
        `refused: this command needs approval (${approval}) and the approval policy is ` +
        `'never', which refuses rather than escalating. Widen the sandbox mode, add an ` +
        `'allow' command rule, or install an OS sandbox mechanism if this should run.`,
    };
  }

  return { kind: 'requires-approval', plan, reason: approval };
}

/** Refuse when the mechanism cannot even see the working directory. */
function reachabilityRefusal(
  input: PolicyInput,
  plan: ContainmentPlan,
): SandboxDecision | undefined {
  if (plan.readsAnywhere) return undefined;
  if (input.containment.mode === 'full-access') return undefined;
  const access = classifyPath(
    input.cwd,
    { readable: plan.readableRoots, writable: plan.writableRoots },
    flavorFor(input.platform),
  );
  if (access !== 'denied') return undefined;
  return {
    kind: 'refuse',
    code: 'cwd-outside-roots',
    reason:
      `refused: the working directory '${input.cwd}' is not inside any root visible to ` +
      `'${plan.mechanism}', so the command would run against a path that does not exist ` +
      `inside the sandbox.`,
  };
}

/**
 * Why approval is needed, or `undefined` when it is not.
 *
 * `untrusted` asks about everything, which is what the mode means. The other two
 * ask only when nothing would confine the command — so an `os-level` plan runs
 * without a prompt, and a `gate-only` plan does not. That ordering is deliberately
 * more conservative on a platform without containment, and it is the honest way
 * round: the alternative is treating an absent boundary as a present one.
 */
function approvalReason(
  input: PolicyInput,
  plan: ContainmentPlan,
  rule: CommandRule | undefined,
): string | undefined {
  if (rule?.action === 'prompt') {
    return `a command rule requires approval for the prefix '${rule.prefix}'`;
  }
  if (input.approvals === 'untrusted') {
    return "the approval policy is 'untrusted', which asks about every action";
  }
  if (rule?.action === 'allow') return undefined;
  if (input.containment.mode === 'full-access') return undefined;
  if (plan.enforcement === 'os-level') return undefined;
  return (
    `sandbox mode '${input.containment.mode}' has no OS-level containment via ` +
    `'${plan.mechanism}' on this platform, so nothing would confine the command`
  );
}

/**
 * Whether a plan permits writing to a concrete path.
 *
 * Used by the profile builders and by the in-process fallback, which is the one
 * place a path check is the actual enforcement rather than a description of it.
 */
export function writeAllowed(plan: ContainmentPlan, path: string, platform: string): boolean {
  if (plan.mode === 'full-access') return true;
  if (plan.mode === 'read-only') return false;
  return (
    classifyPath(
      path,
      { readable: plan.readableRoots, writable: plan.writableRoots },
      flavorFor(platform),
    ) === 'writable'
  );
}

/** Whether a plan permits reading a concrete path. */
export function readAllowed(plan: ContainmentPlan, path: string, platform: string): boolean {
  if (plan.mode === 'full-access') return true;
  if (plan.readsAnywhere) return true;
  return (
    classifyPath(
      path,
      { readable: plan.readableRoots, writable: plan.writableRoots },
      flavorFor(platform),
    ) !== 'denied'
  );
}
