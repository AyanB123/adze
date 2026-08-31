/**
 * `adze doctor` — report the environment, and be honest about the sandbox.
 *
 * The sandbox section is the reason this command is not a nicety. On Windows there
 * is no OS-level containment — not in Adze and not in any open-source coding agent
 * — so the permission gate is the only thing between the agent and the filesystem.
 * ADR-0007 accepts shipping with that gap on the project's own primary development
 * platform, on the condition that we say so instead of letting a user infer
 * protection that is not there. This command is where we say it.
 *
 * The model-provider section is here for a plainer reason: this command is what
 * `@adze/providers` and `adze run` both tell the user to run, and it used to report
 * nothing whatsoever about providers — so a machine with no credential passed
 * `doctor` cleanly and then failed on the first `adze run`. Nothing here probes an
 * endpoint; "configured" is not "reachable", and invariant 5 forbids making the
 * request that would tell the difference.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_SANDBOX_MODE,
  PROTOCOL_VERSION,
  type SandboxEnforcement,
  sandboxEnforcement,
} from '@adze/protocol';
import {
  type ResolvedConfig,
  type ResolvedProvider,
  type ResolveOptions,
  resolveConfig,
} from '@adze/providers';
import { EXIT, type ExitCode, field, type Io, type Style, styleFor, writeJson } from '../output.js';
import { resolveShellPrefix, SHELL_PROGRAM_ENV, shellOverrideAdvice } from '../shell.js';
import { CLI_VERSION, MINIMUM_NODE_VERSION } from '../version.js';

const execFileAsync = promisify(execFile);

export interface DoctorOptions {
  readonly json?: boolean;
  /**
   * Isolates provider resolution from the real environment.
   *
   * Without it a test of the provider section asserts whatever the developer happens to
   * have exported, which is a test that reports the machine rather than the code. Same
   * seam and same reason as `runModels`.
   */
  readonly __testHooks?: {
    readonly resolve?: ResolveOptions;
    /**
     * Replaces the shell probe.
     *
     * Injected so an assertion about the shell check reports the code rather than whether
     * the machine running the suite happens to have a working bash — which is precisely
     * the condition being tested, and therefore the one thing a test must not inherit.
     */
    readonly probeShell?: () => Promise<ShellCheck>;
  };
}

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly value: string;
  /**
   * True when a failure should fail the command. Most tooling is optional: the CLI
   * itself runs without ripgrep, so reporting a missing one as an error would train
   * people to ignore `doctor` — which is how the sandbox warning below stops being
   * read.
   */
  readonly required: boolean;
  readonly hint?: string;
}

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Find an executable on `PATH` without a shell.
 *
 * Hand-rolled rather than `execFile('pnpm', ...)`, because on Windows `pnpm` is
 * `pnpm.cmd` and `execFile` without a shell will not find it — and running with
 * `shell: true` to work around that puts a shell in the path of a diagnostic
 * command, which is the wrong trade for the sake of one lookup.
 */
function whichSync(command: string): string | undefined {
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.length > 0)
      : [''];

  for (const dir of pathValue.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here, or not executable. Keep looking.
      }
    }
  }
  return undefined;
}

async function versionOf(
  command: string,
  args: readonly string[],
): Promise<{ ok: boolean; value: string }> {
  const resolved = whichSync(command);
  if (resolved === undefined) return { ok: false, value: 'not found' };

  try {
    const { stdout } = await runExecutable(resolved, args);
    return { ok: true, value: stdout.trim().split('\n')[0] ?? 'unknown version' };
  } catch (cause) {
    // Reported as a failure, not as an `ok` with an odd string in it. A tool that
    // resolves but cannot execute is exactly the situation `doctor` exists to
    // surface, and burying it in the value column defeats the point.
    return {
      ok: false,
      value: `found but failed to run (${cause instanceof Error ? cause.message : String(cause)})`,
    };
  }
}

/**
 * Run a resolved executable and capture stdout.
 *
 * The Windows branch exists because `pnpm` is `pnpm.cmd`, and since the Node
 * 18.20/20.12 security fix `execFile` refuses to run a `.cmd` or `.bat` directly:
 * it fails with `spawn EINVAL`. A batch file genuinely needs an interpreter, so
 * that case goes through a shell.
 *
 * The command is assembled into a single string rather than passed as `(file,
 * args, { shell: true })`, which Node deprecated in DEP0190 because arguments are
 * concatenated without escaping. Assembling it here makes the quoting explicit and
 * visible: the path is quoted because it routinely contains a space
 * (`C:\Users\First Last\...`), and the arguments are literal constants declared in
 * this file rather than anything derived from user input. Scoped to the batch-file
 * case so no other lookup quietly grows a shell.
 */
function runExecutable(
  resolved: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  const timeout = 5_000;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
    return execFileAsync(`"${resolved}" ${args.join(' ')}`, { timeout, shell: true });
  }
  return execFileAsync(resolved, [...args], { timeout });
}

/**
 * Where ripgrep would come from.
 *
 * Two possibilities, checked in the order the engine would use them: a vendored
 * `@vscode/ripgrep` in the workspace, or `rg` on `PATH`. Reported as optional
 * because retrieval is an M1 deliverable — claiming it is required today would
 * describe a capability that is not built.
 */
function findRipgrep(): { value: string; ok: boolean } {
  const require = createRequire(import.meta.url);
  try {
    const vendored = require.resolve('@vscode/ripgrep');
    return { value: `vendored (${vendored})`, ok: true };
  } catch {
    // Not installed. Expected until a package depends on it.
  }
  const onPath = whichSync('rg');
  if (onPath !== undefined) return { value: `on PATH (${onPath})`, ok: true };
  return {
    value: 'not found',
    ok: false,
  };
}

/**
 * The argv prefix the `bash` tool will actually use, including any override.
 *
 * Read from the environment rather than hard-coded, so this probes the shell the agent
 * is going to run. Probing `bash` while `run` used something else would make the
 * diagnostic worse than silence: it would report a healthy shell nobody uses, or a
 * broken one that had already been worked around.
 */
const SHELL = resolveShellPrefix(process.env);
const SHELL_PREFIX: readonly [string, string] = SHELL.prefix;

/** Outcome of actually running the shell, as opposed to finding it. */
export interface ShellCheck {
  readonly ok: boolean;
  readonly value: string;
  /** First line of the failure, when it ran and failed. Never a stack trace. */
  readonly detail: string | undefined;
}

/**
 * Does the shell the `bash` tool uses actually run a command?
 *
 * `doctor` reported node, pnpm, git and ripgrep, and said nothing about the one program
 * the agent's workhorse tool cannot work without. ADR-0004 makes `bash` the single general
 * tool, and core hard-codes `['bash', '-lc']` on every platform deliberately: substituting
 * PowerShell or `cmd.exe` for model-authored bash would change quoting, globbing and
 * redirection semantics, and some of those differences destroy data rather than merely
 * failing. So bash is a real requirement on Windows too, not a Unix detail.
 *
 * It is probed by execution rather than by lookup, because on Windows resolving it proves
 * nothing. `bash.exe` in System32 is WSL's launcher and it exists whether or not a healthy
 * distribution is installed behind it; a broken WSL exits non-zero for every command,
 * including one that only runs `exit 0`. That failure reaches the model as an ordinary
 * non-zero exit, indistinguishable from a failing test suite, so an agent asked to run the
 * tests rewrites the command and retries until its step budget is gone. That is the run
 * that prompted this check: ten steps and fifty thousand tokens spent on a shell that
 * could never have worked, with nothing in `doctor` that would have said so.
 *
 * `exit 0` is the probe rather than `--version` because the question is whether
 * `bash -lc <command>` works, and only running that form answers it.
 */
async function probeShell(): Promise<ShellCheck> {
  const [program, flag] = SHELL_PREFIX;
  const resolved = whichSync(program);
  if (resolved === undefined) return { ok: false, value: 'not found', detail: undefined };

  try {
    await runExecutable(resolved, [flag, 'exit 0']);
    return { ok: true, value: `${resolved}`, detail: undefined };
  } catch (cause) {
    return {
      ok: false,
      value: `found but cannot run a command (${resolved})`,
      // What the shell said, in preference to what Node said about it. `execFile` rejects
      // with "Command failed: <argv>", which repeats the command back and explains
      // nothing; the reason is in the child's own output.
      detail: firstLine(outputOf(cause) ?? messageOf(cause)),
    };
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The child's own output, when the rejection carries any.
 *
 * `execFile` rejects with an `Error` carrying `stdout` and `stderr`, neither of which is in
 * its type, so both are read through an index check rather than by asserting a shape. This
 * is a failure path, and a wrong assumption here would replace a diagnosis with a crash.
 *
 * **stderr is preferred but stdout is also read**, which looks careless and is not: WSL's
 * launcher prints its mount failure on *stdout* and leaves stderr empty. Taking only
 * stderr means the one message worth reporting is the one that gets dropped, so the
 * generic Node wrapper is used only when the child truly said nothing.
 */
function outputOf(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const record = cause as Record<string, unknown>;
  for (const stream of [record.stderr, record.stdout]) {
    if (typeof stream !== 'string') continue;
    const text = stripNuls(stream).trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

/**
 * Remove NUL bytes.
 *
 * Windows console programs — WSL's launcher among them — write UTF-16LE, and read as UTF-8
 * that arrives as every character separated by a NUL, rendering as `F a i l e d   t o`.
 * Decoding properly would mean guessing the child's encoding; dropping the NULs recovers
 * the text in the case that actually occurs and leaves correct output untouched.
 *
 * Done with `replaceAll` on a string rather than a regex so no control character appears in
 * a pattern, which is a lint rule worth keeping rather than suppressing.
 */
function stripNuls(text: string): string {
  return text.replaceAll('\u0000', '');
}

/** First non-empty line, trimmed and capped, for a hint that stays one line. */
function firstLine(text: string): string | undefined {
  const line = stripNuls(text)
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (line === undefined) return undefined;
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/**
 * The provider section.
 *
 * `doctor` is documented as the report on the whole environment, and both
 * `@adze/providers` and `adze run` point users at it — but it said nothing at all about
 * model providers, which is the one piece of configuration without which no other part of
 * the tool does anything. A user with no credential got a clean bill of health and then a
 * failure on their first `adze run`.
 *
 * Reported, never probed: no request is made to any endpoint. Invariant 5 forbids an
 * outbound call the user did not ask for, so "configured" here means configured, not
 * reachable — and the wording says so.
 *
 * A missing provider is a **warning, not a failure**. `doctor`'s stated rule is that
 * optional tooling missing still exits 0, and making the exit code depend on whether the
 * machine happens to export a key would make it depend on ambient state in CI. `run` and
 * `models` both already refuse with a message naming the variables to set.
 */
interface ProviderReport {
  readonly id: string;
  readonly kind: string;
  /** A request could be made: a key resolved, or the transport does not require one. */
  readonly usable: boolean;
  /** Which variable or config key supplied the key. Never the value. */
  readonly credentialSource: string | undefined;
  readonly baseURL: string | undefined;
  readonly defaultModel: string | undefined;
}

/**
 * Whether a request to this provider could be made.
 *
 * Mirrors `AiSdkGateway.assertCredential` and `runModels`: an `openai-compatible` endpoint
 * may legitimately need no credential, so a missing key there is not a defect. All three
 * must agree, or `doctor` reports a provider as unusable that `run` then uses.
 */
function providerUsable(provider: ResolvedProvider): boolean {
  return provider.apiKey !== undefined || provider.kind === 'openai-compatible';
}

function toReport(provider: ResolvedProvider): ProviderReport {
  return {
    id: provider.id,
    kind: provider.kind,
    usable: providerUsable(provider),
    credentialSource: provider.apiKeySource,
    baseURL: provider.baseURL,
    defaultModel: provider.defaultModel,
  };
}

/** Resolution outcome, with a malformed config file reported rather than thrown. */
interface ProviderSection {
  readonly providers: readonly ProviderReport[];
  readonly defaultModel: string | undefined;
  readonly sources: readonly string[];
  /** Set when `.adze/providers.json` could not be read. */
  readonly error: string | undefined;
}

function buildProviderSection(options: DoctorOptions): ProviderSection {
  let config: ResolvedConfig;
  try {
    config = resolveConfig({ cwd: process.cwd(), ...options.__testHooks?.resolve });
  } catch (cause) {
    // A malformed providers file must not take `doctor` down: this is the command a user
    // runs *because* something is wrong, so it has to survive the thing that is wrong.
    return {
      providers: [],
      defaultModel: undefined,
      sources: [],
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
  return {
    providers: config.providers.map(toReport),
    defaultModel: config.defaultModel,
    sources: config.sources,
    error: undefined,
  };
}

function renderProviders(section: ProviderSection, io: Io, style: Style): void {
  io.out(`${style.bold('Model providers')}\n`);

  if (section.error !== undefined) {
    io.out(`${field('config', style.bad('unreadable'))}\n`);
    io.out(`       ${style.dim(section.error)}\n\n`);
    return;
  }

  for (const provider of section.providers) {
    const credential =
      provider.credentialSource !== undefined
        ? style.good(`key from ${provider.credentialSource}`)
        : provider.usable
          ? style.dim('no credential — optional for openai-compatible')
          : style.warn('no credential');
    io.out(
      `  ${provider.usable ? style.good('ok  ') : style.warn('warn')} ${provider.id.padEnd(10)} ${provider.kind} · ${credential}\n`,
    );
    if (provider.baseURL !== undefined) {
      io.out(`                  ${style.dim(provider.baseURL)}\n`);
    }
    if (provider.defaultModel !== undefined) {
      io.out(`                  ${style.dim(`default model: ${provider.defaultModel}`)}\n`);
    }
  }

  io.out(`${field('default model', section.defaultModel ?? style.dim('none set'))}\n`);
  if (section.sources.length > 0) {
    io.out(`${field('config read from', section.sources.join(', '))}\n`);
  }
  io.out(
    `\n  ${style.dim('Reported as configured, not as reachable: doctor makes no network call.')}\n\n`,
  );
}

async function buildChecks(section: ProviderSection, shell: ShellCheck): Promise<Check[]> {
  const nodeOk = compareSemver(process.versions.node, MINIMUM_NODE_VERSION) >= 0;
  const ripgrep = findRipgrep();
  const pnpm = await versionOf('pnpm', ['--version']);
  const git = await versionOf('git', ['--version']);
  const usable = section.providers.filter((provider) => provider.usable);

  return [
    {
      name: 'node',
      ok: nodeOk,
      value: `v${process.versions.node}`,
      required: true,
      ...(nodeOk ? {} : { hint: `Adze requires Node >= ${MINIMUM_NODE_VERSION}` }),
    },
    { name: 'platform', ok: true, value: `${process.platform} ${process.arch}`, required: false },
    {
      name: 'pnpm',
      ok: pnpm.ok,
      value: pnpm.value,
      required: false,
      ...(pnpm.ok ? {} : { hint: 'Needed to build from a checkout, not to run adze.' }),
    },
    {
      name: 'git',
      ok: git.ok,
      value: git.value,
      required: false,
      ...(git.ok ? {} : { hint: 'Most agent workflows assume a git repository.' }),
    },
    {
      name: 'ripgrep',
      ok: ripgrep.ok,
      value: ripgrep.value,
      required: false,
      ...(ripgrep.ok
        ? {}
        : {
            hint: 'Retrieval will vendor @vscode/ripgrep — see docs/roadmap.md M1. Installing `rg` yourself also works.',
          }),
    },
    {
      name: 'shell',
      ok: shell.ok,
      value: shell.value,
      // A warning rather than a failure, matching this command's rule for everything
      // except node: tying the exit code to it would start failing `doctor` in CI on
      // machines where nothing changed. The hint carries the weight instead, because the
      // consequence - `bash` cannot run at all - is not something to state mildly.
      required: false,
      ...(shell.ok
        ? {}
        : {
            hint: `The \`bash\` tool runs \`${SHELL_PREFIX.join(' ')} <command>\` and cannot work until this does. ${
              shell.detail === undefined
                ? 'Install bash (Git for Windows ships one).'
                : `The shell reported: ${shell.detail}`
            } ${
              SHELL.overridden
                ? `This shell came from ${SHELL_PROGRAM_ENV}, so the override is what needs correcting rather than PATH.`
                : `On Windows, \`bash\` on PATH is often WSL's launcher, which fails this way when no healthy distribution is installed. ${shellOverrideAdvice()}`
            } Until then the agent can still read, edit, glob, grep and use symbols, but every command it tries will fail.`,
          }),
    },
    {
      name: 'provider',
      ok: usable.length > 0,
      value:
        section.error !== undefined
          ? 'config unreadable'
          : usable.length > 0
            ? `${usable.length} usable (${usable.map((provider) => provider.id).join(', ')})`
            : 'none usable',
      required: false,
      ...(usable.length > 0 && section.error === undefined
        ? {}
        : {
            hint: 'No model provider is usable, so `adze run` cannot reach a model. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or point .adze/providers.json at a local endpoint. `adze models` lists what is configured.',
          }),
    },
  ];
}

/**
 * The sandbox paragraph.
 *
 * Extracted because it is the part of `doctor` that must not be edited casually:
 * ADR-0007 accepts shipping without Windows containment only on the condition that
 * we state it plainly, and the wording below is that condition.
 */
function renderSandbox(enforcement: SandboxEnforcement, io: Io): void {
  const s = styleFor(false);
  io.out(`${s.bold('Sandbox')}\n`);
  io.out(`${field('default mode', DEFAULT_SANDBOX_MODE)}\n`);
  io.out(`${field('default approvals', DEFAULT_APPROVAL_POLICY)}\n`);

  if (enforcement === 'os-level') {
    const mechanism = process.platform === 'darwin' ? 'Seatbelt' : 'bubblewrap';
    io.out(`${field('OS containment', `${s.good('available')} (${mechanism})`)}\n`);
    io.out(
      `\n  ${s.dim('Tool calls pass the permission gate and run inside an OS-level sandbox.')}\n`,
    );
    return;
  }

  if (enforcement === 'not-applicable') {
    io.out(`${field('OS containment', s.warn('not applicable (full-access)'))}\n`);
    return;
  }

  // Deliberately explicit about what is and is not protecting the user. "sandbox:
  // partial" would be read as "some protection", when the correct reading is that
  // there is no kernel-level boundary at all.
  io.out(`${field('OS containment', s.bad('none on this platform'))}\n`);
  io.out(
    `\n  ${s.warn('There is no OS-level sandbox on Windows.')} The permission gate and the\n` +
      '  approval policy still apply, and every tool call still passes through them —\n' +
      '  but nothing stops an approved command from touching the filesystem outside\n' +
      '  the workspace. Treat an approval here as you would treat running the command\n' +
      '  yourself.\n\n' +
      `  ${s.dim('This is a gap across the whole open-source agent ecosystem, not only Adze.')}\n` +
      `  ${s.dim('Closing it is roadmapped: docs/architecture/adr/0007-sandbox-and-permissions.md')}\n`,
  );
}

export async function runDoctor(options: DoctorOptions, io: Io): Promise<ExitCode> {
  const json = options.json === true;
  const s = styleFor(json);
  const section = buildProviderSection(options);
  const shell = await (options.__testHooks?.probeShell ?? probeShell)();
  const checks = await buildChecks(section, shell);
  const enforcement = sandboxEnforcement(process.platform, DEFAULT_SANDBOX_MODE);
  const failed = checks.filter((c) => c.required && !c.ok);

  if (json) {
    writeJson(io, {
      ok: failed.length === 0,
      cli: CLI_VERSION,
      protocol: PROTOCOL_VERSION,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      checks: checks.map((c) => ({
        name: c.name,
        ok: c.ok,
        value: c.value,
        required: c.required,
        ...(c.hint === undefined ? {} : { hint: c.hint }),
      })),
      providers: {
        // Configured, not reachable. No request is made to any endpoint.
        probed: false,
        defaultModel: section.defaultModel ?? null,
        sources: section.sources,
        ...(section.error === undefined ? {} : { error: section.error }),
        entries: section.providers.map((provider) => ({
          id: provider.id,
          kind: provider.kind,
          usable: provider.usable,
          // The variable *name* that supplied the key, never the value.
          credentialSource: provider.credentialSource ?? null,
          baseUrl: provider.baseURL ?? null,
          defaultModel: provider.defaultModel ?? null,
        })),
      },
      sandbox: {
        defaultMode: DEFAULT_SANDBOX_MODE,
        defaultApprovalPolicy: DEFAULT_APPROVAL_POLICY,
        enforcement,
        osLevelContainment: enforcement === 'os-level',
        reference: 'docs/architecture/adr/0007-sandbox-and-permissions.md',
      },
    });
    return failed.length > 0 ? EXIT.Failure : EXIT.Ok;
  }

  io.out(`${s.bold('adze doctor')}\n\n`);

  io.out(`${s.bold('Adze')}\n`);
  io.out(`${field('cli', CLI_VERSION)}\n`);
  io.out(`${field('protocol', PROTOCOL_VERSION)}\n\n`);

  io.out(`${s.bold('Environment')}\n`);
  for (const c of checks) {
    const mark = c.ok ? s.good('ok  ') : c.required ? s.bad('fail') : s.warn('warn');
    io.out(`  ${mark} ${c.name.padEnd(10)} ${c.value}\n`);
    if (c.hint !== undefined) io.out(`       ${' '.repeat(10)} ${s.dim(c.hint)}\n`);
  }
  io.out('\n');

  renderProviders(section, io, s);
  renderSandbox(enforcement, io);

  if (failed.length > 0) {
    io.err(`\n${s.bad(`${failed.length} required check(s) failed.`)}\n`);
    return EXIT.Failure;
  }
  return EXIT.Ok;
}
