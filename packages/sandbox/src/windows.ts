/**
 * Windows: what is genuinely achievable in TypeScript, and what is not.
 *
 * ADR-0007 records that no open-source coding agent has a working sandbox on
 * Windows. This file does not change that, and the most useful thing it can do is
 * say exactly where the line falls, in code, so no surface and no reader has to
 * guess.
 *
 * ## Enforced here, today
 *
 * - **argv-array spawn.** No shell is ever constructed, so a path containing `&`,
 *   `%PATH%`, `^`, or `"` is inert data. On Windows this is worth more than it
 *   sounds: `cmd.exe` metacharacter handling is a well-known source of injection,
 *   and the way to be safe from it is to never involve `cmd.exe`.
 * - **Process-tree teardown.** A timed-out or cancelled command is killed together
 *   with its descendants via `taskkill /T /F`. This bounds **lifetime**, which is one
 *   of the things a job object would give, and it is the only one reachable from
 *   here.
 * - **A scrubbed environment.** Credential-shaped variables are removed before the
 *   child starts.
 * - **Console suppression.** `windowsHide` keeps a spawned process from stealing
 *   focus with a console window.
 * - **Policy refusals.** A `forbid` prefix rule and an approval policy of `never`
 *   refuse before anything spawns, and the writable-root arithmetic is available to
 *   callers as a pre-write check.
 *
 * ## Not enforced here. Not partially, not approximately: not at all.
 *
 * - **No restricted token.** `CreateRestrictedToken` plus `CreateProcessAsUser` has
 *   no Node binding. The child runs with the agent's full token, so it can do
 *   anything the user can do.
 * - **No job object.** `CreateJobObject`, `SetInformationJobObject`, and
 *   `AssignProcessToJobObject` have no Node binding, so there is no CPU, memory,
 *   handle, or breakaway limit, and no kernel-guaranteed tree kill.
 * - **No AppContainer.** It requires an AppContainer SID and a capability list passed
 *   through `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` in `STARTUPINFOEX`, which
 *   `child_process.spawn` cannot express. There is therefore **no filesystem
 *   isolation and no network isolation.**
 * - **No filesystem boundary of any kind.** The path checks in this package are
 *   arithmetic on strings. They stop the engine from writing where it should not;
 *   they do not stop a subprocess from doing anything, because nothing is watching
 *   the subprocess.
 * - **Windows Sandbox is present on some machines and cannot help.** It is a real
 *   VM-backed boundary, and `WindowsSandbox.exe` takes a `.wsb` file, returns
 *   immediately, and hands back no exit code, stdout, or stderr. An agent loop needs
 *   all three. {@link buildWindowsSandboxConfig} generates the configuration because
 *   it is useful for a human running a session by hand, and it is not wired into
 *   `exec`, because wiring it in would produce a broker that reports success for
 *   every command including the ones that failed.
 *
 * Consequently {@link WindowsBroker.enforcement} returns `gate-only` for both
 * containment modes and there is no code path that makes it return `os-level` without
 * a helper that genuinely provides one. `@adze/core`'s permission gate turns that into
 * a `no-os-sandbox` warning, and its `on-request` policy prompts for every command as
 * a result. That is the correct, conservative ordering.
 *
 * ## The seam for the rest
 *
 * {@link WindowsContainmentHelper} is the interface a native broker must satisfy.
 * ADR-0002 permits a Rust sidecar and ADR-0007 names it as roadmapped work with its
 * own ADR; this is the shape it plugs into, so landing it is a new file and one
 * constructor argument rather than a rewrite. Supplying a helper is the *only* way
 * this broker will ever report `os-level`, and the claim comes from the helper's own
 * declaration of what it does.
 */

import type { BaseBrokerOptions, Wrapped } from './broker-base.js';
import { ContainedBroker, programNameRefusal, splitArgv } from './broker-base.js';
import type { MechanismCapability } from './policy.js';
import type { CommandRequest, ContainmentPlan, Degradation, SandboxMode } from './types.js';

/**
 * What a native Windows broker would have to provide.
 *
 * Deliberately narrow. It reports what it confines and wraps an argv; it does not get
 * to define its own policy, build its own plan, or decide its own enforcement level,
 * because those belong to `policy.ts` and are what keeps one honesty rule in one
 * place. A helper that claimed `confinesFilesystem` while doing nothing would be
 * lying, and the answer to that is code review of the helper, not a second guess here.
 */
export interface WindowsContainmentHelper {
  /** Reported in plans and outcomes so a user can see which helper ran. */
  readonly name: string;
  readonly confinesFilesystem: boolean;
  readonly confinesNetwork: boolean;
  readonly supportsNetworkAllowlist: boolean;
  /** True when the boundary survives into grandchildren — a job object, in practice. */
  readonly confinesSubprocessTree: boolean;
  /**
   * Wrap the target so the helper applies `plan`.
   *
   * Must return an argv array and must not construct a shell string. Returning an
   * error refuses the command; a helper that cannot express a plan must say so rather
   * than silently applying a weaker one.
   */
  wrap(
    plan: ContainmentPlan,
    target: { readonly cwd: string; readonly file: string; readonly args: readonly string[] },
  ): { readonly file: string; readonly args: readonly string[] } | { readonly error: string };
}

export interface WindowsOptions extends BaseBrokerOptions {
  /** True when `taskkill` was found. Bounds process lifetime; not a privilege boundary. */
  readonly processTreeTeardown?: boolean;
  /** A native helper. The only thing that can make this broker report `os-level`. */
  readonly helper?: WindowsContainmentHelper;
}

/**
 * The Windows capability, stated pessimistically by default.
 *
 * Without a helper every confinement flag is false, which drives `planFor` to
 * `gate-only` and attaches the four degradations below. The degradations are separate
 * rather than merged into one line because each names a different missing mechanism
 * and a different piece of work, and a user comparing platforms deserves the specifics
 * rather than "no sandbox".
 */
export function windowsCapability(options: WindowsOptions, mode: SandboxMode): MechanismCapability {
  const helper = options.helper;
  const degradations: Degradation[] = [];

  if (helper === undefined && mode !== 'full-access') {
    degradations.push(
      {
        code: 'windows-no-restricted-token',
        scope: 'containment',
        message:
          'no restricted token is applied: CreateRestrictedToken and CreateProcessAsUser have ' +
          'no Node binding, so the command runs with the full rights of the current user',
      },
      {
        code: 'windows-no-job-object',
        scope: 'containment',
        message:
          'no job object bounds the command: CPU, memory, handle and breakaway limits are ' +
          'not applied' +
          (options.processTreeTeardown === false
            ? ', and taskkill is missing so descendants may survive a timeout'
            : '; descendants are killed on timeout with taskkill, which bounds lifetime only'),
      },
      {
        code: 'windows-no-appcontainer',
        scope: 'containment',
        message:
          'no AppContainer profile isolates the command: it needs STARTUPINFOEX security ' +
          'capabilities that Node cannot pass, so there is no filesystem or network isolation',
      },
    );
  }

  return {
    mechanism: 'windows-partial',
    confinesFilesystem: helper?.confinesFilesystem ?? false,
    confinesNetwork: helper?.confinesNetwork ?? false,
    supportsNetworkAllowlist: helper?.supportsNetworkAllowlist ?? false,
    confinesSubprocessTree: helper?.confinesSubprocessTree ?? false,
    degradations,
  };
}

export class WindowsBroker extends ContainedBroker {
  readonly name: string;
  private readonly windows: WindowsOptions;

  constructor(options: WindowsOptions = {}) {
    super(options);
    this.windows = options;
    // The name carries the helper, so an outcome or a log line says which boundary
    // was in force rather than only that it was "windows".
    this.name = options.helper === undefined ? 'windows-partial' : `windows-${options.helper.name}`;
  }

  capability(mode: SandboxMode): MechanismCapability {
    return windowsCapability(this.windows, mode);
  }

  protected wrap(request: CommandRequest, plan: ContainmentPlan): Wrapped {
    const argv = splitArgv(request.command);
    if (argv === undefined) {
      return { ok: false, code: 'empty-command', reason: 'no command was given' };
    }

    const helper = this.windows.helper;
    if (helper === undefined || plan.mode === 'full-access') {
      // Spawned directly, with an argument array. Nothing wraps it, and the plan
      // already reports `gate-only`, so nothing here overstates what happened.
      return { ok: true, file: argv.file, args: argv.args };
    }

    const optionLike = programNameRefusal(argv.file, helper.name);
    if (optionLike !== undefined) return optionLike;

    const wrapped = helper.wrap(plan, {
      cwd: request.cwd,
      file: argv.file,
      args: argv.args,
    });
    if ('error' in wrapped) {
      return {
        ok: false,
        code: 'mechanism-unavailable',
        reason:
          `refused: the Windows containment helper '${helper.name}' could not apply the ` +
          `requested boundary (${wrapped.error}). Running without it would drop containment ` +
          `silently.`,
      };
    }
    return { ok: true, file: wrapped.file, args: wrapped.args };
  }
}

// ---------------------------------------------------------------------------
// Windows Sandbox configuration
// ---------------------------------------------------------------------------

export type WindowsSandboxConfig =
  | { readonly ok: true; readonly xml: string }
  | { readonly ok: false; readonly unsafeValue: string };

/**
 * Generate a `.wsb` configuration for a plan.
 *
 * **Not used by `exec`, and that is not an oversight.** `WindowsSandbox.exe` launches
 * a VM and returns immediately with no exit code, no stdout, and no stderr. A broker
 * built on it would report success for every command, including the ones that failed,
 * which is worse than having no sandbox: a wrong answer delivered confidently.
 *
 * It is generated because it is genuinely useful to a human who wants to run a
 * session inside a real boundary by hand, and because it documents what mapping the
 * writable roots would look like when a helper can eventually drive it. Read-only
 * mode maps the roots read-only; `workspace-write` maps them writable; network is
 * disabled unless the mode is `full-access`.
 *
 * Networking is decided from `plan.mode` rather than from `plan.network`, and the
 * distinction is not cosmetic. On Windows with no helper, `plan.network.policy` is
 * `unrestricted` because the *selected* mechanism cannot restrict network — that is
 * the plan being honest about itself. Windows Sandbox is a different mechanism and
 * can, so reading the plan's network field here would generate a configuration that
 * enables networking precisely when the user asked for it to be off. The requested
 * mode is the thing this file must honour.
 */
export function buildWindowsSandboxConfig(
  plan: ContainmentPlan,
  hostFolders: readonly string[],
): WindowsSandboxConfig {
  const lines = [
    '<Configuration>',
    `  <Networking>${plan.mode === 'full-access' ? 'Enable' : 'Disable'}</Networking>`,
    '  <MappedFolders>',
  ];

  for (const folder of hostFolders) {
    if (!representable(folder)) return { ok: false, unsafeValue: folder };
    const readOnly = plan.mode === 'read-only' || !plan.writableRoots.includes(folder);
    lines.push(
      '    <MappedFolder>',
      `      <HostFolder>${xmlEscape(folder)}</HostFolder>`,
      `      <ReadOnly>${readOnly ? 'true' : 'false'}</ReadOnly>`,
      '    </MappedFolder>',
    );
  }

  lines.push('  </MappedFolders>', '</Configuration>');
  return { ok: true, xml: `${lines.join('\n')}\n` };
}

/** Escape for XML text content. `&` first, or the other escapes get double-escaped. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function representable(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: detecting them is the point
  return !/[\u0000-\u001f\u007f]/.test(value);
}
