/**
 * Choosing a broker, and reporting what was chosen.
 *
 * One entry point, so no surface has to know which mechanism belongs to which
 * platform and no surface can accidentally disagree with another about it. The
 * returned {@link SandboxSetup} carries the broker, the capability report that
 * produced it, and the plan that will apply — which is what a CLI needs to print an
 * accurate startup line and what `adze doctor` needs to explain a host.
 *
 * ## Selection order, and the one thing that is never automatic
 *
 * Docker first when — and only when — a human enabled it and named an image. Then the
 * platform's native mechanism if it is actually available. Then, on Windows, the
 * partial broker, which is more informative than the generic fallback because it can
 * name the four specific mechanisms it is not applying. Then the fallback, carrying
 * the specific sentence from capability detection rather than a generic one.
 *
 * Docker is never selected because it happens to be installed. That would reintroduce
 * the prerequisite ADR-0007 rejected, and it would mean a user's containment changed
 * because of an unrelated `brew install`.
 */

import type { BaseBrokerOptions } from './broker-base.js';
import type { BubblewrapOptions } from './bubblewrap.js';
import { BubblewrapBroker } from './bubblewrap.js';
import type { DetectOptions, SandboxCapabilities } from './capabilities.js';
import { capability, detectCapabilities } from './capabilities.js';
import type { DockerOptions } from './docker.js';
import { DockerBroker } from './docker.js';
import { FallbackBroker } from './fallback.js';
import { planFor } from './policy.js';
import type { SeatbeltOptions } from './seatbelt.js';
import { SeatbeltBroker } from './seatbelt.js';
import type {
  ApprovalPolicy,
  CommandRule,
  Containment,
  ContainmentPlan,
  SandboxBroker,
  SandboxMode,
} from './types.js';
import type { HostProbe } from './which.js';
import { nodeHostProbe } from './which.js';
import type { WindowsContainmentHelper } from './windows.js';
import { WindowsBroker } from './windows.js';

/** The configuration a surface already has, in the shape it already has it. */
export interface SandboxRequest {
  readonly mode: SandboxMode;
  /** Absolute paths writable under `workspace-write`. Empty is the workspace only. */
  readonly writableRoots?: readonly string[];
  readonly allowedNetworkHosts?: readonly string[];
  readonly commandRules?: readonly CommandRule[];
  /** Defaults to `on-request`. */
  readonly approvals?: ApprovalPolicy;
}

export interface CreateSandboxOptions extends BaseBrokerOptions {
  readonly sandbox: SandboxRequest;
  /** Defaults to the real host. Injected in tests so no runner state leaks in. */
  readonly probe?: HostProbe;
  /** Pre-computed capabilities, to avoid probing twice in one process. */
  readonly capabilities?: SandboxCapabilities;
  /** Runs a real probe of each mechanism. Off by default; see {@link DetectOptions}. */
  readonly verify?: DetectOptions['verify'];
  /** Opt-in only. Omitting this is how Docker stays off. */
  readonly docker?: Omit<DockerOptions, keyof BaseBrokerOptions>;
  /** A native Windows broker. The only way Windows reports `os-level`. */
  readonly windowsHelper?: WindowsContainmentHelper;
  readonly seatbelt?: Pick<SeatbeltOptions, 'writableDevices' | 'writableTemp' | 'sandboxExecPath'>;
  readonly bubblewrap?: Pick<BubblewrapOptions, 'bwrapPath' | 'tmpfs'>;
}

export interface SandboxSetup {
  readonly broker: SandboxBroker;
  readonly capabilities: SandboxCapabilities;
  /** Normalized from the request, in the shape core's grant passes to `exec`. */
  readonly containment: Containment;
  /** What will actually be enforced, including everything that will not be. */
  readonly plan: ContainmentPlan;
}

export async function createSandbox(options: CreateSandboxOptions): Promise<SandboxSetup> {
  const probe = options.probe ?? nodeHostProbe();
  const capabilities =
    options.capabilities ??
    (await detectCapabilities(
      probe,
      options.verify === undefined ? {} : { verify: options.verify },
    ));

  const containment: Containment = {
    mode: options.sandbox.mode,
    writableRoots: options.sandbox.writableRoots ?? [],
    allowedNetworkHosts: options.sandbox.allowedNetworkHosts ?? [],
  };

  const broker = select(options, capabilities, probe.platform);
  const plan = planFor(containment, broker.capability(containment.mode), probe.platform);
  return { broker, capabilities, containment, plan };
}

/** Shared options every broker needs, assembled once. */
function baseOptions(options: CreateSandboxOptions, platform: string): BaseBrokerOptions {
  return {
    approvals: options.sandbox.approvals ?? 'on-request',
    commandRules: options.sandbox.commandRules ?? [],
    platform,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.allowEnv === undefined ? {} : { allowEnv: options.allowEnv }),
    ...(options.denyEnv === undefined ? {} : { denyEnv: options.denyEnv }),
    ...(options.killer === undefined ? {} : { killer: options.killer }),
    ...(options.maxStreamBytes === undefined ? {} : { maxStreamBytes: options.maxStreamBytes }),
    ...(options.assumeApproved === undefined ? {} : { assumeApproved: options.assumeApproved }),
  };
}

/**
 * Pick the broker.
 *
 * Returns the concrete class rather than the interface so {@link createSandbox} can
 * ask it for its own capability, which is what keeps the reported plan and the
 * enforced plan the same object's opinion. Two sources of truth for "what is
 * enforced" is how a startup banner ends up disagreeing with reality.
 */
function select(
  options: CreateSandboxOptions,
  capabilities: SandboxCapabilities,
  platform: string,
): DockerBroker | SeatbeltBroker | BubblewrapBroker | WindowsBroker | FallbackBroker {
  const base = baseOptions(options, platform);

  if (options.docker?.enabled === true && options.docker.image.length > 0) {
    return new DockerBroker({ ...base, ...options.docker });
  }

  if (platform === 'darwin') {
    const seatbelt = capability(capabilities, 'seatbelt');
    if (seatbelt.available) {
      return new SeatbeltBroker(true, { ...base, ...options.seatbelt });
    }
    return new FallbackBroker({ ...base, reason: seatbelt.detail });
  }

  if (platform === 'linux') {
    const bwrap = capability(capabilities, 'bubblewrap');
    if (bwrap.available) {
      return new BubblewrapBroker(true, { ...base, ...options.bubblewrap });
    }
    return new FallbackBroker({ ...base, reason: bwrap.detail });
  }

  if (platform === 'win32') {
    return new WindowsBroker({
      ...base,
      processTreeTeardown: capability(capabilities, 'windows-process-tree').available,
      ...(options.windowsHelper === undefined ? {} : { helper: options.windowsHelper }),
    });
  }

  return new FallbackBroker({
    ...base,
    reason:
      `platform '${platform}' has no sandbox mechanism in @adze/sandbox, so commands run ` +
      `with no OS-level containment`,
  });
}
