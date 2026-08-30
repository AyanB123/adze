/**
 * What this host can actually enforce, discovered rather than assumed.
 *
 * The output of this module is the input to every honesty claim the package makes.
 * Two rules govern it.
 *
 * **Found is not the same as works.** Every finding carries `verified`, and static
 * detection never sets it. Finding `/usr/bin/bwrap` proves a file exists; it does
 * not prove unprivileged user namespaces are permitted, that AppArmor will let it
 * run, or that the kernel was not built without the feature. A broker that treated
 * presence as proof would report `os-level` containment on a host where bubblewrap
 * exits 1 on every invocation.
 *
 * **Unavailable is reported, never worked around.** When a mechanism is missing the
 * report says which one, why, and what would fix it. It does not fall through to a
 * weaker mechanism while keeping the stronger one's name, and it does not crash —
 * ADR-0007 asks for a clear message and degradation, and a stack trace is neither.
 */

import type { SandboxMechanism } from './types.js';
import type { HostProbe } from './which.js';
import { whichExecutable } from './which.js';

export type MechanismId =
  | 'seatbelt'
  | 'bubblewrap'
  | 'docker'
  | 'git-worktree'
  | 'windows-process-tree'
  | 'windows-restricted-token'
  | 'windows-job-object'
  | 'windows-appcontainer'
  | 'windows-sandbox';

export interface MechanismAvailability {
  readonly id: MechanismId;
  readonly available: boolean;
  /**
   * True only when the mechanism was exercised and observed to work.
   *
   * Static detection leaves this false even when `available` is true. The pair
   * `available && !verified` is the honest description of "the binary is there and
   * nobody has proved it functions", which is the normal state at startup.
   */
  readonly verified: boolean;
  readonly path?: string;
  /** Why, in one sentence, whether it was found or not. Always populated. */
  readonly detail: string;
  /** True when TypeScript cannot reach this mechanism at all. */
  readonly requiresNativeHelper?: boolean;
  /** True when it works but cannot serve the agent loop. Windows Sandbox only. */
  readonly unusableForExec?: boolean;
}

export interface SandboxCapabilities {
  readonly platform: string;
  readonly mechanisms: readonly MechanismAvailability[];
  /**
   * The strongest mechanism that can contain an `exec` on this host.
   *
   * `docker` is never chosen here even when present. ADR-0007 makes it an explicit
   * escape hatch and never a default, because a Docker prerequisite is a documented
   * adoption barrier for someone trying a CLI on a laptop. Selecting it
   * automatically would reintroduce that prerequisite by the back door.
   */
  readonly preferred: SandboxMechanism;
}

export interface DetectOptions {
  /**
   * Runs a real probe command and reports whether it succeeded.
   *
   * Absent by default, which keeps detection free of subprocesses — a startup path
   * that spawns three processes to decide what it can do is a startup path people
   * disable. A caller that wants `verified: true` supplies this and pays for it.
   */
  readonly verify?: (mechanism: MechanismId) => Promise<boolean>;
}

export async function detectCapabilities(
  probe: HostProbe,
  options: DetectOptions = {},
): Promise<SandboxCapabilities> {
  const mechanisms: MechanismAvailability[] = [
    await detectSeatbelt(probe),
    await detectBubblewrap(probe),
    await detectDocker(probe),
    await detectGit(probe),
    ...(await detectWindows(probe)),
  ];

  const verified = await verifyAll(mechanisms, options.verify);
  return { platform: probe.platform, mechanisms: verified, preferred: preferredOf(verified) };
}

async function verifyAll(
  mechanisms: readonly MechanismAvailability[],
  verify: DetectOptions['verify'],
): Promise<readonly MechanismAvailability[]> {
  if (verify === undefined) return mechanisms;
  const out: MechanismAvailability[] = [];
  for (const mechanism of mechanisms) {
    if (!mechanism.available) {
      out.push(mechanism);
      continue;
    }
    const ok = await verify(mechanism.id);
    out.push({
      ...mechanism,
      available: ok,
      verified: ok,
      detail: ok
        ? `${mechanism.detail}; verified by running it`
        : `${mechanism.detail}, but running it failed, so it is not usable`,
    });
  }
  return out;
}

/** Look one mechanism up. Returns a definite "not on this platform" rather than undefined. */
export function capability(
  capabilities: SandboxCapabilities,
  id: MechanismId,
): MechanismAvailability {
  const found = capabilities.mechanisms.find((m) => m.id === id);
  return (
    found ?? {
      id,
      available: false,
      verified: false,
      detail: `'${id}' was not probed on platform '${capabilities.platform}'`,
    }
  );
}

function preferredOf(mechanisms: readonly MechanismAvailability[]): SandboxMechanism {
  const has = (id: MechanismId): boolean => mechanisms.some((m) => m.id === id && m.available);
  if (has('seatbelt')) return 'seatbelt';
  if (has('bubblewrap')) return 'bubblewrap';
  if (has('windows-process-tree')) return 'windows-partial';
  return 'none';
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

async function detectSeatbelt(probe: HostProbe): Promise<MechanismAvailability> {
  if (probe.platform !== 'darwin') {
    return {
      id: 'seatbelt',
      available: false,
      verified: false,
      detail: `Seatbelt is macOS-only and this platform is '${probe.platform}'`,
    };
  }
  // Deprecated since 10.14 and still the mechanism every sandboxing tool on macOS
  // uses, including Apple's own. Absence would mean a modified system.
  const path = await whichExecutable('sandbox-exec', probe);
  if (path === undefined) {
    return {
      id: 'seatbelt',
      available: false,
      verified: false,
      detail:
        'sandbox-exec was not found on PATH, which is unexpected on macOS and usually ' +
        'means a stripped PATH rather than a missing system binary',
    };
  }
  return {
    id: 'seatbelt',
    available: true,
    verified: false,
    path,
    detail:
      'sandbox-exec found; Seatbelt profiles are inherited by child processes, so the ' +
      'whole subprocess tree is contained',
  };
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

/**
 * bubblewrap, plus the two kernel facts that decide whether it can work.
 *
 * `unprivileged_userns_clone` is the Debian-family switch; `max_user_namespaces` is
 * the upstream one. Either being zero makes bubblewrap unusable without setuid, and
 * saying "bwrap is installed" in that state would be the exact false claim this
 * package exists to avoid.
 */
async function detectBubblewrap(probe: HostProbe): Promise<MechanismAvailability> {
  if (probe.platform !== 'linux') {
    return {
      id: 'bubblewrap',
      available: false,
      verified: false,
      detail: `bubblewrap is Linux-only and this platform is '${probe.platform}'`,
    };
  }
  const path = await whichExecutable('bwrap', probe);
  if (path === undefined) {
    return {
      id: 'bubblewrap',
      available: false,
      verified: false,
      detail:
        'bwrap was not found on PATH; install the bubblewrap package to get OS-level ' +
        'containment on Linux',
    };
  }

  const userns = await userNamespaceState(probe);
  if (!userns.enabled) {
    return {
      id: 'bubblewrap',
      available: false,
      verified: false,
      path,
      detail: userns.detail,
    };
  }
  return { id: 'bubblewrap', available: true, verified: false, path, detail: userns.detail };
}

interface UserNamespaceState {
  readonly enabled: boolean;
  readonly detail: string;
}

async function userNamespaceState(probe: HostProbe): Promise<UserNamespaceState> {
  const clone = (await probe.readText('/proc/sys/kernel/unprivileged_userns_clone'))?.trim();
  if (clone === '0') {
    return {
      enabled: false,
      detail:
        'bwrap is installed but unprivileged user namespaces are disabled ' +
        '(/proc/sys/kernel/unprivileged_userns_clone is 0), so it cannot create a sandbox; ' +
        'enable that sysctl or run with a privileged helper',
    };
  }
  const max = (await probe.readText('/proc/sys/user/max_user_namespaces'))?.trim();
  if (max === '0') {
    return {
      enabled: false,
      detail:
        'bwrap is installed but /proc/sys/user/max_user_namespaces is 0, so no user ' +
        'namespace can be created; raise that limit to use bubblewrap',
    };
  }
  return { enabled: true, detail: await apparmorNote(probe) };
}

/**
 * The known AppArmor friction, stated as a caveat rather than a verdict.
 *
 * Ubuntu 23.10 and later restrict unprivileged user namespaces through AppArmor.
 * Distribution-packaged bubblewrap ships a profile that keeps working; a locally
 * built or relocated `bwrap` does not, and fails with a permission error that looks
 * nothing like an AppArmor denial. We cannot tell which case this host is in without
 * running it, so the report says so and `verified` stays false.
 */
async function apparmorNote(probe: HostProbe): Promise<string> {
  const restricted = (
    await probe.readText('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
  )?.trim();
  if (restricted === '1') {
    return (
      'bwrap found and user namespaces are enabled, but AppArmor restricts unprivileged ' +
      'user namespaces on this kernel (Ubuntu 23.10+). A distribution-packaged bwrap has ' +
      'a profile and works; a self-built or moved binary will be denied. Not verified'
    );
  }
  return 'bwrap found and unprivileged user namespaces are available';
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * The Windows picture, mechanism by mechanism.
 *
 * This is the most important function in the file, because it is where the project
 * either tells the truth about Windows or does not. Exactly one of these is
 * reachable from TypeScript, and it is the weakest one.
 */
async function detectWindows(probe: HostProbe): Promise<readonly MechanismAvailability[]> {
  const off = (id: MechanismId, what: string): MechanismAvailability => ({
    id,
    available: false,
    verified: false,
    detail: `${what} is Windows-only and this platform is '${probe.platform}'`,
  });

  if (probe.platform !== 'win32') {
    return [
      off('windows-process-tree', 'taskkill process-tree teardown'),
      off('windows-restricted-token', 'restricted-token launch'),
      off('windows-job-object', 'job-object confinement'),
      off('windows-appcontainer', 'AppContainer isolation'),
      off('windows-sandbox', 'Windows Sandbox'),
    ];
  }

  const taskkill = await whichExecutable('taskkill', probe);
  const systemRoot = probe.env.SystemRoot ?? probe.env.windir ?? 'C:\\Windows';
  const wsbPath = `${systemRoot}\\System32\\WindowsSandbox.exe`;
  const wsb = await probe.isExecutable(wsbPath);

  return [
    {
      id: 'windows-process-tree',
      available: taskkill !== undefined,
      verified: false,
      ...(taskkill === undefined ? {} : { path: taskkill }),
      detail:
        taskkill === undefined
          ? 'taskkill was not found on PATH, so a timed-out command cannot be guaranteed to ' +
            'take its descendants with it'
          : 'taskkill found; a timed-out or cancelled command and its descendants are killed. ' +
            'This bounds process lifetime, not privileges',
    },
    {
      id: 'windows-restricted-token',
      available: false,
      verified: false,
      requiresNativeHelper: true,
      detail:
        'a restricted token requires CreateRestrictedToken plus CreateProcessAsUser, which ' +
        'Node exposes no binding for; not enforced',
    },
    {
      id: 'windows-job-object',
      available: false,
      verified: false,
      requiresNativeHelper: true,
      detail:
        'a job object requires CreateJobObject, SetInformationJobObject and ' +
        'AssignProcessToJobObject; Node exposes no binding, so no resource or breakaway ' +
        'limits are applied',
    },
    {
      id: 'windows-appcontainer',
      available: false,
      verified: false,
      requiresNativeHelper: true,
      detail:
        'AppContainer requires an AppContainer SID and a capability SID list passed through ' +
        'PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES in STARTUPINFOEX; unreachable from ' +
        'TypeScript, so no filesystem or network isolation is applied',
    },
    {
      id: 'windows-sandbox',
      available: wsb,
      verified: false,
      unusableForExec: true,
      ...(wsb ? { path: wsbPath } : {}),
      detail: wsb
        ? 'WindowsSandbox.exe is present, which gives a genuine VM-backed boundary. It ' +
          'cannot serve the agent loop: it takes a .wsb configuration file, returns ' +
          'immediately, and provides no exit code, stdout or stderr back to the host'
        : 'WindowsSandbox.exe was not found; it needs Windows Pro or Enterprise with the ' +
          'Windows Sandbox optional feature enabled',
    },
  ];
}

// ---------------------------------------------------------------------------
// Escape hatches
// ---------------------------------------------------------------------------

async function detectDocker(probe: HostProbe): Promise<MechanismAvailability> {
  const path = await whichExecutable('docker', probe);
  return {
    id: 'docker',
    available: path !== undefined,
    verified: false,
    ...(path === undefined ? {} : { path }),
    detail:
      path === undefined
        ? 'docker was not found on PATH; it is an opt-in escape hatch and its absence is ' +
          'not a problem'
        : 'docker found on PATH. Never selected automatically: ADR-0007 keeps it an ' +
          'explicit escape hatch because requiring it is an adoption barrier. Presence of ' +
          'the client does not mean a running daemon',
  };
}

async function detectGit(probe: HostProbe): Promise<MechanismAvailability> {
  const path = await whichExecutable('git', probe);
  return {
    id: 'git-worktree',
    available: path !== undefined,
    verified: false,
    ...(path === undefined ? {} : { path }),
    detail:
      path === undefined
        ? 'git was not found on PATH, so worktree isolation for parallel agents is unavailable'
        : 'git found; worktrees give cheap isolation for parallel agents and are not a ' +
          'security boundary',
  };
}
