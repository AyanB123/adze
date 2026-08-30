#!/usr/bin/env node
/**
 * `adze-safe` — the launcher a first-time user should be pointed at.
 *
 * This exists because of a specific gap. Per ADR-0007 there is **no OS-level
 * containment on Windows**: Seatbelt covers macOS and bubblewrap covers Linux, but on
 * Windows the permission gate is the only thing between the agent and the filesystem,
 * and an approved command runs with the invoking user's full rights. Adze is honest
 * about that — `adze doctor` says it and the approval prompt repeats it — but honesty
 * is not a mitigation. This launcher is the mitigation.
 *
 * It does three things, and deliberately nothing else:
 *
 * 1. **Applies restrictive defaults** to `run` and `chat` — `--approval untrusted`,
 *    `--sandbox workspace-write`, and the three budget ceilings. These are the real
 *    CLI flags, not a parallel configuration system. The full `.adze/config.jsonc`
 *    layer is M2 (see docs/roadmap.md); until it lands, flags are the only mechanism
 *    that actually changes engine behaviour, so a launcher is the honest place to put
 *    a default.
 *
 * 2. **Refuses to start where the work is not recoverable.** A git repository with a
 *    commit is what makes an agent's filesystem writes undoable — `git checkout .`
 *    costs nothing and returns everything. With no OS sandbox, that is the strongest
 *    remaining safety property, so the launcher treats its absence as a hard stop
 *    rather than a warning. Warnings about this get scrolled past.
 *
 * 3. **Says what it changed**, on stderr, every time. A launcher that silently
 *    rewrote a security-relevant flag would be worse than no launcher: the user would
 *    read the upstream documentation and believe something false about their own
 *    setup.
 *
 * ### Injected flags stay overridable
 *
 * Defaults are prepended, never appended, and commander resolves a repeated option to
 * the **last** occurrence. So `adze run "…" --approval on-request` genuinely gets
 * `on-request`: the user's flag lands after the injected one and wins. Escalation is
 * therefore explicit and visible in the shell history, which is the property that
 * matters — a safe default that cannot be turned off gets worked around by
 * abandoning the launcher entirely, and then nothing is applying a default at all.
 *
 * ### Anything that is not `run` or `chat` passes straight through
 *
 * `doctor`, `models`, `validate`, `apply`, `--version`, and `--help` take no approval
 * or sandbox flags. Injecting one would turn a read-only diagnostic into a usage
 * error, and `doctor` is the command a confused user reaches for first, so it is the
 * last one that should break.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const cliEntry = join(repoRoot, 'packages', 'cli', 'bin', 'adze.mjs');

/** Only these two reach the agent loop, so only these two take the safety flags. */
const AGENT_COMMANDS = new Set(['run', 'chat']);

/**
 * The defaults, with the reason each one is here.
 *
 * `--approval untrusted` rather than the product default `on-request`: `on-request`
 * asks only about what the sandbox *would* block, and on Windows the sandbox blocks
 * nothing at the OS level, so the set of things worth seeing is every tool call.
 *
 * `--sandbox workspace-write` rather than `full-access`: the gate confines writes to
 * the workspace root, which is what makes the git-repository requirement below
 * meaningful. `full-access` asks for no containment at all and is never a default.
 *
 * The three budgets bound a runaway loop in the three ways it can run away — turns,
 * tokens, and wall-clock. `--max-spend` is intentionally absent: core refuses it at
 * submit for a model with no entry in the price catalog, and every local endpoint is
 * unpriced, so injecting it would make the launcher fail on exactly the free setup it
 * is meant to encourage.
 */
const SAFE_DEFAULTS = [
  '--approval',
  'untrusted',
  '--sandbox',
  'workspace-write',
  '--max-steps',
  '25',
  '--max-tokens',
  '200000',
  '--max-time',
  '300',
];

/** Read `-C/--cwd` if the user set one, since that is the root the gate confines to. */
function requestedWorkspace(args) {
  for (let i = 0; i < args.length; i += 1) {
    if ((args[i] === '--cwd' || args[i] === '-C') && i + 1 < args.length) {
      const value = args[i + 1];
      if (value !== undefined) return resolve(value);
    }
  }
  return process.cwd();
}

/**
 * Nearest enclosing git work tree, or `undefined`.
 *
 * Tests for `.git` as a path rather than shelling out to `git rev-parse`, so the
 * check costs no subprocess and works with `git` absent from PATH. `existsSync`
 * rather than a directory test on purpose: in a worktree or a submodule `.git` is a
 * regular file containing a `gitdir:` pointer, and requiring a directory would reject
 * a perfectly recoverable checkout.
 */
function findGitRoot(startDir) {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Roots too broad to hand to an agent that can write files.
 *
 * A drive root or the profile root would make `workspace-write` cover the entire
 * user account, which is `full-access` by another name. Refused even when a `.git`
 * happens to exist there, because someone who ran `git init` in their home directory
 * has made the blast radius bigger, not smaller.
 */
function tooBroad(dir) {
  const root = parse(dir).root;
  if (resolve(dir) === resolve(root)) return `${dir} is a drive root`;
  if (resolve(dir) === resolve(homedir())) return `${dir} is your user profile root`;
  return undefined;
}

function fail(lines) {
  for (const line of lines) process.stderr.write(`${line}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
// Located by index, not by value. `argv.filter(a => a !== command)` would also strip a
// prompt that happens to equal the subcommand name — `adze run "run the tests"` is a
// realistic thing to type, and losing the argument would turn it into a usage error.
const commandIndex = argv.findIndex((arg) => !arg.startsWith('-'));
const command = commandIndex === -1 ? undefined : argv[commandIndex];
const isAgentCommand = command !== undefined && AGENT_COMMANDS.has(command);

let args = argv;

if (isAgentCommand) {
  const workspace = requestedWorkspace(argv);

  const breadth = tooBroad(workspace);
  if (breadth !== undefined) {
    fail([
      `adze-safe: refusing to run here — ${breadth}.`,
      '',
      '  With no OS-level sandbox on Windows, the workspace root is the only bound on',
      '  what the agent can write. A root this broad is full-access by another name.',
      '',
      '  Run from a project directory instead, or pass -C <path>.',
    ]);
  }

  if (findGitRoot(workspace) === undefined && process.env.ADZE_SAFE_ALLOW_NO_GIT !== '1') {
    fail([
      `adze-safe: refusing to run — ${workspace} is not inside a git repository.`,
      '',
      '  Adze can write to files here, and on Windows there is no OS-level sandbox to',
      '  stop an approved command (ADR-0007). A git commit is what makes those writes',
      '  undoable, so this launcher treats its absence as a stop rather than a warning.',
      '',
      '  Make it recoverable:',
      '    git init',
      '    git add -A',
      '    git commit -m "before adze"',
      '',
      '  Then anything the agent does is reversible with `git checkout .`.',
      '',
      '  To proceed anyway, set ADZE_SAFE_ALLOW_NO_GIT=1. Prefer the three commands.',
    ]);
  }

  // Prepended, so a user flag of the same name lands later and wins.
  const rest = [...argv.slice(0, commandIndex), ...argv.slice(commandIndex + 1)];
  args = [command, ...SAFE_DEFAULTS, ...rest];

  process.stderr.write(
    'adze-safe: applying restrictive defaults — approval=untrusted, ' +
      'sandbox=workspace-write, max-steps=25, max-tokens=200000, max-time=300s.\n' +
      '           Override by passing the flag yourself; the last one wins. ' +
      'Run packages/cli/bin/adze.mjs directly for none of this.\n\n',
  );
}

/**
 * Hand the terminal straight through.
 *
 * `stdio: 'inherit'` is load-bearing rather than tidy: the approval prompt reads a
 * line from stdin, and a piped stdio would leave the child reading a stream nobody
 * writes to. The channel treats end-of-input as a denial, so the visible symptom
 * would be every action silently denied — a safety mechanism that appears to work
 * while actually being broken.
 */
const child = spawn(process.execPath, [cliEntry, ...args], {
  stdio: 'inherit',
  // `false` so the child stays in this console's process group and Ctrl-C reaches it.
  // Adze's own handler turns the first Ctrl-C into a turn cancellation, which lets the
  // engine close out the history; detaching would bypass that and orphan the child.
  detached: false,
});

child.on('exit', (code, signal) => {
  // A signalled child has no exit code. 130 is the conventional SIGINT code, and the
  // CLI uses it for a second Ctrl-C, so reporting it keeps the two paths consistent.
  process.exit(signal !== null ? 130 : (code ?? 1));
});

child.on('error', (error) => {
  process.stderr.write(`adze-safe: could not start the CLI: ${error.message}\n`);
  process.exit(2);
});
