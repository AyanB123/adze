/**
 * `adze doctor` — report the environment, and be honest about the sandbox.
 *
 * The sandbox section is the reason this command is not a nicety. On Windows there
 * is no OS-level containment — not in Adze and not in any open-source coding agent
 * — so the permission gate is the only thing between the agent and the filesystem.
 * ADR-0007 accepts shipping with that gap on the project's own primary development
 * platform, on the condition that we say so instead of letting a user infer
 * protection that is not there. This command is where we say it.
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
import { EXIT, type ExitCode, field, type Io, styleFor, writeJson } from '../output.js';
import { CLI_VERSION, MINIMUM_NODE_VERSION } from '../version.js';

const execFileAsync = promisify(execFile);

export interface DoctorOptions {
  readonly json?: boolean;
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

async function buildChecks(): Promise<Check[]> {
  const nodeOk = compareSemver(process.versions.node, MINIMUM_NODE_VERSION) >= 0;
  const ripgrep = findRipgrep();
  const pnpm = await versionOf('pnpm', ['--version']);
  const git = await versionOf('git', ['--version']);

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
  const checks = await buildChecks();
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

  renderSandbox(enforcement, io);

  if (failed.length > 0) {
    io.err(`\n${s.bad(`${failed.length} required check(s) failed.`)}\n`);
    return EXIT.Failure;
  }
  return EXIT.Ok;
}
