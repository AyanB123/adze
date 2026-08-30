/**
 * Docker as an explicit escape hatch.
 *
 * ADR-0007 rejects Docker-first as a default and supports it as an opt-in, for a
 * reason worth restating because it is easy to lose: requiring Docker is a
 * documented adoption barrier. Someone who wants to try a CLI on a laptop will not
 * install a container runtime first, and a tool that demands one has chosen maximum
 * portability over being used. So this broker exists, is complete, and is never
 * selected automatically — {@link DockerOptions.enabled} must be true and an image
 * must be named, both by a human.
 *
 * ## What is enforced
 *
 * More than Seatbelt or bubblewrap, and that is the point of having it: a separate
 * kernel namespace set, a separate filesystem in which **only mounted paths exist at
 * all**, capabilities dropped, no new privileges, and network removed at the
 * interface level. The subprocess tree is inside it by construction.
 *
 * ## What it costs
 *
 * The container's filesystem is not the host's, so a path that was not mounted is
 * genuinely absent rather than merely unreadable. That makes `cwd` outside the
 * mounted roots a refusal rather than a confusing failure inside the container, and
 * it is why {@link ContainmentPlan.readsAnywhere} exists as a distinct field.
 *
 * Image contents are the user's problem and cannot be checked here. A command that
 * works on the host may not exist in the image, which is a real usability cost and
 * the reason this is not the default even where Docker is installed.
 */

import type { BaseBrokerOptions, Wrapped } from './broker-base.js';
import { ContainedBroker, programNameRefusal, splitArgv } from './broker-base.js';
import type { MechanismCapability } from './policy.js';
import type { CommandRequest, ContainmentPlan, SandboxMode } from './types.js';

export interface DockerOptions extends BaseBrokerOptions {
  /** Must be explicitly true. There is no default that turns this on. */
  readonly enabled: boolean;
  /** Required. A tag rather than a digest is the caller's risk to take. */
  readonly image: string;
  /** Defaults to `docker`. Set to `podman` for a drop-in daemonless replacement. */
  readonly dockerPath?: string;
  /**
   * `uid:gid` for the container process.
   *
   * Strongly recommended on Linux, where a container running as root writes
   * root-owned files into the bind-mounted workspace and leaves the user unable to
   * delete their own build output. Not defaulted, because guessing the wrong id
   * produces permission errors that are harder to diagnose than the thing it avoids.
   */
  readonly user?: string;
  /** Extra `docker run` flags. Inserted before the image; the caller owns the risk. */
  readonly extraArgs?: readonly string[];
}

/**
 * The `docker run` argument list for a plan.
 *
 * Pure and exported so the exact flags are asserted in tests without a daemon. The
 * security-relevant ones are `--cap-drop ALL`, `--security-opt no-new-privileges`,
 * `--network none`, and `--read-only`; each is a separate argv element, so a mount
 * path containing a space or a `;` needs no quoting and gets none.
 */
export function buildDockerArgs(
  plan: ContainmentPlan,
  target: { readonly cwd: string; readonly file: string; readonly args: readonly string[] },
  options: DockerOptions,
): readonly string[] {
  const argv: string[] = [
    'run',
    // Removed on exit. A broker that accumulated stopped containers would fill a
    // laptop's disk over a long session and blame the user's images for it.
    '--rm',
    // stdin is always attached: the exec layer writes the request's stdin and closes
    // it, and without -i the write goes nowhere and a filter command hangs.
    '-i',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
  ];

  if (plan.network.policy === 'unrestricted') argv.push('--network', 'bridge');
  else argv.push('--network', 'none');

  if (plan.mode === 'read-only') argv.push('--read-only');
  if (options.user !== undefined) argv.push('--user', options.user);

  for (const root of plan.readableRoots) {
    const writable = plan.writableRoots.includes(root);
    argv.push('-v', `${root}:${root}${writable ? '' : ':ro'}`);
  }

  argv.push('-w', target.cwd);
  argv.push(...(options.extraArgs ?? []));
  argv.push(options.image, target.file, ...target.args);
  return argv;
}

export function dockerCapability(enabled: boolean, _mode: SandboxMode): MechanismCapability {
  return {
    mechanism: 'docker',
    confinesFilesystem: enabled,
    confinesNetwork: enabled,
    // `--network none` is all-or-nothing. A per-host allowlist needs a proxy or a
    // custom network with firewall rules, which is a component, not a flag.
    supportsNetworkAllowlist: false,
    confinesSubprocessTree: enabled,
    degradations: [],
    // The decisive difference from every other mechanism here.
    readsOnlyBoundPaths: enabled,
  };
}

export class DockerBroker extends ContainedBroker {
  readonly name = 'docker';
  private readonly docker: DockerOptions;

  constructor(options: DockerOptions) {
    super(options);
    this.docker = options;
  }

  capability(mode: SandboxMode): MechanismCapability {
    return dockerCapability(this.docker.enabled && this.docker.image.length > 0, mode);
  }

  protected wrap(request: CommandRequest, plan: ContainmentPlan): Wrapped {
    const argv = splitArgv(request.command);
    if (argv === undefined) {
      return { ok: false, code: 'empty-command', reason: 'no command was given' };
    }
    if (!this.docker.enabled || this.docker.image.length === 0) {
      return {
        ok: false,
        code: 'mechanism-unavailable',
        reason:
          'refused: the Docker broker was selected but is not configured. It requires ' +
          'enabled: true and an image name, both set explicitly — ADR-0007 keeps Docker an ' +
          'opt-in escape hatch with no implicit default.',
      };
    }

    const optionLike = programNameRefusal(argv.file, 'docker run');
    if (optionLike !== undefined) return optionLike;

    return {
      ok: true,
      file: this.docker.dockerPath ?? 'docker',
      args: buildDockerArgs(
        plan,
        { cwd: request.cwd, file: argv.file, args: argv.args },
        this.docker,
      ),
    };
  }
}
