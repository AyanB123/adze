/**
 * The broker for a host with no containment.
 *
 * Selected on Windows without a helper, on Linux without usable bubblewrap, on macOS
 * without `sandbox-exec`, and on every platform this package has no story for. It is
 * the honest answer rather than a failure: refusing to run at all when no sandbox is
 * available would make the tool unusable on the maintainers' own primary development
 * platform, and pretending would be worse than either.
 *
 * What it provides is everything from `exec.ts` — argv-array spawn, process-tree
 * teardown, timeout enforcement, an output ceiling, a scrubbed environment — plus the
 * policy refusals from `policy.ts`. What it does not provide is a boundary, and
 * {@link FallbackBroker.enforcement} says `gate-only` in every containment mode so
 * `@adze/core` raises its `no-os-sandbox` warning and `on-request` prompts per command.
 *
 * The `reason` constructor argument is the part that matters in use. "No OS-level
 * containment" is not actionable; "bwrap is installed but
 * /proc/sys/kernel/unprivileged_userns_clone is 0" is. It is threaded from
 * `detectCapabilities` into the plan's degradations so a CLI can print the specific
 * sentence rather than the generic one.
 */

import type { BaseBrokerOptions, Wrapped } from './broker-base.js';
import { ContainedBroker, splitArgv } from './broker-base.js';
import type { MechanismCapability } from './policy.js';
import type { CommandRequest, Degradation, SandboxMode } from './types.js';

export interface FallbackOptions extends BaseBrokerOptions {
  /** Why there is no containment, in one actionable sentence. */
  readonly reason?: string;
}

export function fallbackCapability(mode: SandboxMode, reason?: string): MechanismCapability {
  const degradations: Degradation[] = [];
  if (mode !== 'full-access') {
    if (reason !== undefined) {
      degradations.push({ code: 'no-os-containment', scope: 'containment', message: reason });
    }
    degradations.push({
      code: 'symlink-escape-unchecked',
      scope: 'hardening',
      message:
        'writable-root checks are string arithmetic and do not resolve symlinks or Windows ' +
        'junctions, so a link inside a writable root that points outside it is not detected; ' +
        'a kernel mechanism resolves paths and is not fooled this way',
    });
  }
  return {
    mechanism: 'none',
    confinesFilesystem: false,
    confinesNetwork: false,
    supportsNetworkAllowlist: false,
    confinesSubprocessTree: false,
    degradations,
  };
}

export class FallbackBroker extends ContainedBroker {
  readonly name = 'uncontained';
  private readonly reason: string | undefined;

  constructor(options: FallbackOptions = {}) {
    super(options);
    this.reason = options.reason;
  }

  capability(mode: SandboxMode): MechanismCapability {
    return fallbackCapability(mode, this.reason);
  }

  protected wrap(request: CommandRequest): Wrapped {
    const argv = splitArgv(request.command);
    if (argv === undefined) {
      return { ok: false, code: 'empty-command', reason: 'no command was given' };
    }
    // No wrapper, so no option-like program-name risk: `spawn` treats `argv[0]` as a
    // path to execute and never as a flag. The refusal in the other brokers exists
    // because a wrapper sits in front; here nothing does.
    return { ok: true, file: argv.file, args: argv.args };
  }
}

/**
 * A broker that runs nothing.
 *
 * Mirrors core's `NullBroker`, and exists here for the same reason: a test asserting
 * that the gate refused before execution needs the difference between "denied" and
 * "ran and failed" to be impossible to fake. Reports `gate-only` rather than
 * `not-applicable` for a containment mode, because nothing containing a process that
 * never runs is not the same as containment having been waived.
 */
export class NullBroker extends ContainedBroker {
  readonly name = 'null';

  capability(mode: SandboxMode): MechanismCapability {
    return fallbackCapability(mode, 'this broker cannot run any command');
  }

  protected wrap(): Wrapped {
    return {
      ok: false,
      code: 'mechanism-unavailable',
      reason: 'no sandbox broker is configured, so no command can run',
    };
  }
}
