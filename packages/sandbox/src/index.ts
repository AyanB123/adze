/**
 * `@adze/sandbox` — OS-level containment behind the permission gate.
 *
 * `@adze/core` decides whether a command may run. This package decides what it can
 * touch once running, on the platforms where that is possible, and states plainly
 * where it is not. The two are separate because ADR-0007 keeps them separate: a
 * sandbox exists to reduce approval fatigue, and collapsing the axes means the only
 * way to get fewer prompts is less containment.
 *
 * Every broker here satisfies core's `SandboxBroker` structurally, so wiring one in
 * is a constructor argument in a surface — `packages/cli` or `apps/vscode` — and no
 * change to core.
 *
 * ```ts
 * const { broker, plan } = await createSandbox({ sandbox: { mode: 'workspace-write',
 *   writableRoots: [workspaceRoot] } });
 * // plan.enforcement is 'os-level' only where it really is.
 * // plan.degradations lists everything that is not enforced.
 * ```
 *
 * ## Summary of what is enforced, by platform
 *
 * | Platform | Filesystem | Network | Subprocess tree | Enforcement reported |
 * | --- | --- | --- | --- | --- |
 * | macOS + `sandbox-exec` | writes outside the roots denied | denied | contained | `os-level` |
 * | Linux + usable `bwrap` | read-only bind, roots bound writable | denied | contained | `os-level` |
 * | Docker, opt-in | only mounted paths exist | denied | contained | `os-level` |
 * | Windows | **nothing** | **nothing** | lifetime only, via `taskkill` | `gate-only` |
 * | anything else | **nothing** | **nothing** | lifetime only | `gate-only` |
 *
 * The syscall surface is unrestricted in every row. These mechanisms contain an agent
 * doing damage; they are not a boundary against code actively trying to escape, and
 * each plan carries that as a degradation rather than leaving it to be assumed.
 */

export type { BaseBrokerOptions, Wrapped, WrapRefusal } from './broker-base.js';
export { ContainedBroker, programNameRefusal, refusal, splitArgv } from './broker-base.js';
export type { BubblewrapOptions } from './bubblewrap.js';
export { BubblewrapBroker, bubblewrapCapability, buildBubblewrapArgs } from './bubblewrap.js';
export type {
  DetectOptions,
  MechanismAvailability,
  MechanismId,
  SandboxCapabilities,
} from './capabilities.js';
export { capability, detectCapabilities } from './capabilities.js';
export type { DockerOptions } from './docker.js';
export { buildDockerArgs, DockerBroker, dockerCapability } from './docker.js';
export type { ScrubOptions } from './env.js';
export { looksLikeCredential, scrubEnvironment } from './env.js';
export type { ProcessTreeKiller, RunOptions, SpawnPlan } from './exec.js';
export { killProcessTree, MAX_STREAM_BYTES, runContained } from './exec.js';
export type { FallbackOptions } from './fallback.js';
export { FallbackBroker, fallbackCapability, NullBroker } from './fallback.js';
export type { PathAccess, PathFlavor } from './paths.js';
export {
  canonical,
  classifyPath,
  containingRoot,
  flavorFor,
  isWithin,
  normalizeRoots,
} from './paths.js';
export type { MechanismCapability, PolicyInput, SandboxDecision } from './policy.js';
export { decide, matchCommandRule, planFor, readAllowed, writeAllowed } from './policy.js';
export type { SeatbeltOptions, SeatbeltProfile } from './seatbelt.js';
export { buildSeatbeltProfile, SeatbeltBroker, seatbeltCapability } from './seatbelt.js';
export type { CreateSandboxOptions, SandboxRequest, SandboxSetup } from './select.js';
export { createSandbox } from './select.js';
export type {
  ApprovalPolicy,
  CommandCompleted,
  CommandOutcome,
  CommandRequest,
  CommandRule,
  CommandSpawnFailed,
  Containment,
  ContainmentPlan,
  Degradation,
  DegradationCode,
  NetworkPlan,
  RefusalCode,
  SandboxBroker,
  SandboxEnforcement,
  SandboxMechanism,
  SandboxMode,
} from './types.js';
export type { HostProbe } from './which.js';
export { nodeHostProbe, whichExecutable } from './which.js';
export type {
  WindowsContainmentHelper,
  WindowsOptions,
  WindowsSandboxConfig,
} from './windows.js';
export { buildWindowsSandboxConfig, WindowsBroker, windowsCapability } from './windows.js';
export type { GitRunner, WorktreeRequest, WorktreeResult } from './worktree.js';
export {
  createWorktree,
  parseWorktreeList,
  removeWorktree,
  worktreeAddArgs,
  worktreeListArgs,
  worktreePruneArgs,
  worktreeRemoveArgs,
} from './worktree.js';
