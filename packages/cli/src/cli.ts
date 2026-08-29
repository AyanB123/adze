/**
 * Command wiring.
 *
 * `run()` returns an exit code instead of calling `process.exit`, which is what
 * makes every command in this package testable in-process. A CLI that can only be
 * exercised by spawning a subprocess tends to be tested by spawning it once.
 *
 * Output is plain text. The TUI is deliberately deferred (ADR-0001 §6.6): plain
 * output first keeps `adze` scriptable and usable in CI, and a TUI added on top
 * later cannot take that away, whereas a TUI added first usually does.
 */

import { PROTOCOL_VERSION } from '@adze/protocol';
import { Command, CommanderError } from 'commander';
import { type ApplyOptions, runApply } from './commands/apply.js';
import { type ChatOptions, runChat } from './commands/chat.js';
import { type DoctorOptions, runDoctor } from './commands/doctor.js';
import { type ModelsOptions, runModels } from './commands/models.js';
import { type RunOptions, runRun } from './commands/run.js';
import { runValidate, type ValidateOptions } from './commands/validate.js';
import { EXIT, type ExitCode, type Io, processIo } from './output.js';
import { CLI_VERSION } from './version.js';

interface RunState {
  exitCode: ExitCode;
}

/**
 * The flags `run` and `chat` share.
 *
 * Registered from one function so the two commands cannot drift. A `--sandbox` value one
 * accepts and the other silently ignores is a security display that is wrong in one of two
 * places, and a user has no way to tell which. The parsing counterpart lives in
 * `src/agent/flags.ts` for the same reason.
 */
function withAgentFlags(command: Command): Command {
  return command
    .option('-m, --model <provider/model>', 'model to use, e.g. anthropic/claude-sonnet-4-5')
    .option('--effort <level>', 'reasoning effort: minimal, low, medium, high (OpenAI-style)')
    .option('--temperature <n>', 'sampling temperature, 0 to 2')
    .option('--max-output-tokens <n>', 'cap the response length of a single request')
    .option(
      '-s, --sandbox <mode>',
      'read-only, workspace-write, or full-access (default: workspace-write)',
    )
    .option(
      '-a, --approval <policy>',
      'untrusted, on-request, or never; never refuses instead of asking (default: on-request)',
    )
    .option(
      '--allow <prefix>',
      'permit a command prefix without asking; repeatable',
      collect,
      [] as string[],
    )
    .option(
      '--forbid <prefix>',
      'refuse a command prefix outright, never offered for approval; repeatable',
      collect,
      [] as string[],
    )
    .option('--max-steps <n>', 'stop after this many model steps')
    .option('--max-tokens <n>', 'stop after this many total tokens')
    .option('--max-time <seconds>', 'stop after this much wall-clock time')
    .option('--max-spend <usd>', 'stop after this much estimated spend')
    .option('-C, --cwd <path>', 'workspace root (default: the current directory)')
    .option('--instructions <text>', 'extra system instructions for this session')
    .option('-q, --quiet', 'suppress tool and progress lines; keep assistant text');
}

/** `--allow a --allow b` accumulates rather than overwriting. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function buildProgram(io: Io, state: RunState): Command {
  const program = new Command();

  program
    .name('adze')
    .description(
      'Adze — an open-source AI coding platform. One engine, every surface.\n' +
        `Protocol ${PROTOCOL_VERSION}. Plain-text output by design; no TUI yet.`,
    )
    .version(CLI_VERSION, '-v, --version', 'print the adze version')
    .helpOption('-h, --help', 'show help')
    .configureOutput({
      writeOut: (str) => io.out(str),
      writeErr: (str) => io.err(str),
    })
    .showHelpAfterError('(add --help for usage)')
    .exitOverride();

  program
    .command('apply')
    .description('apply an edit to a file through the three-tier applier')
    .requiredOption(
      '-f, --file <path>',
      'file to edit; read from disk, and written unless --dry-run',
    )
    .option('-s, --search <text>', 'text to locate (single-line; use --edits for a block)')
    .option('-r, --replace <text>', 'replacement text')
    .option(
      '-e, --edits <path>',
      'JSON file: { "edits": [{ "search", "replace", "occurrence"? }], "replacement"? }',
    )
    .option(
      '-o, --occurrence <n>',
      'which match to edit, 1-based; without it a non-unique match is refused',
    )
    .option('--dry-run', 'report what would happen and write nothing')
    .option('--json', 'machine-readable output, including full telemetry')
    .addHelpText(
      'after',
      '\nExit codes:\n' +
        '  0  applied\n' +
        '  1  refused — the edit was not safe to make; the reason says which fix applies\n' +
        '  2  usage error\n' +
        '\nA refusal is the applier working correctly. The alternative to refusing an\n' +
        'ambiguous or parse-breaking edit is writing a file it has broken.\n',
    )
    .action(async (options: ApplyOptions) => {
      state.exitCode = await runApply(options, io);
    });

  program
    .command('validate')
    .description('parse-validate files and report which validator level actually ran')
    .argument('<files...>', 'files to validate')
    .option('--json', 'machine-readable output')
    .addHelpText(
      'after',
      '\nThe validator degrades honestly. `tree-sitter` means a real parse happened,\n' +
        '`structural` means the delimiter and indentation check ran, and a skipped file\n' +
        'was not checked at all because the language is unknown. A skipped file is\n' +
        'reported as skipped rather than as a pass.\n' +
        '\nExit codes:\n' +
        '  0  nothing invalid (files may have been skipped)\n' +
        '  1  at least one file is invalid or unreadable\n' +
        '  2  usage error\n',
    )
    .action(async (files: string[], options: ValidateOptions) => {
      state.exitCode = await runValidate(files, options, io);
    });

  program
    .command('doctor')
    .description('report the environment, and what the sandbox does and does not do here')
    .option('--json', 'machine-readable output')
    .action(async (options: DoctorOptions) => {
      state.exitCode = await runDoctor(options, io);
    });

  withAgentFlags(
    program
      .command('run')
      .description('run one task to completion, non-interactive')
      .argument('<prompt>', 'what the agent should do')
      .option('--json', 'one JSON event per line on stdout, then a summary document'),
  )
    .addHelpText(
      'after',
      '\nExamples:\n' +
        '  adze run "fix the failing test in packages/apply"\n' +
        '  adze run --sandbox read-only --approval never "summarise the retrieval package"\n' +
        '  adze run --max-steps 20 --max-spend 0.50 --json "add a changeset" > events.jsonl\n' +
        '\nApproval policies:\n' +
        '  untrusted   ask about every tool call\n' +
        '  on-request  ask only about what the sandbox would block (default)\n' +
        '  never       refuse instead of asking — an action needing approval is denied,\n' +
        '              never escalated. This is the policy to use in CI.\n' +
        '\nOn completion the summary reports the token split, cost, and cache hit rate.\n' +
        'An unpriced model reports cost as `unknown` rather than as zero.\n' +
        '\nExit codes:\n' +
        '  0  the turn reached end-turn\n' +
        '  1  the agent did not finish: a budget ceiling, a refusal, a cancellation, or a\n' +
        '     provider error. A refusal is the permission gate working, not a crash.\n' +
        '  2  usage error, including no configured model provider\n',
    )
    .action(async (prompt: string, options: RunOptions) => {
      state.exitCode = await runRun(prompt, options, io);
    });

  withAgentFlags(
    program.command('chat').description('interactive session with the agent, in plain text'),
  )
    .addHelpText(
      'after',
      '\nSlash commands: /usage, /model, /clear, /help, /exit.\n' +
        '\nOne session across every prompt, so the conversation accumulates and the cached\n' +
        'prefix stays reusable. Plain text by design; there is no TUI yet (ADR-0001 §6.6).\n',
    )
    .action(async (options: ChatOptions) => {
      state.exitCode = await runChat(options, io);
    });

  program
    .command('models')
    .description('list configured providers and the models Adze knows prices for')
    .option('--json', 'machine-readable output')
    .option('--all', 'include catalog models whose provider has no credential configured')
    .addHelpText(
      'after',
      '\nA model with no rates in the catalog is listed with cost `unknown`. That is not a\n' +
        'defect: every local and OpenAI-compatible endpoint is unpriced, and reporting zero\n' +
        'would read as free. Prices live in packages/providers/src/catalog.json — data, not\n' +
        'code, so updating one is a JSON edit.\n' +
        '\nThis command makes no network call. It reports what is configured, not what is\n' +
        'reachable.\n',
    )
    .action(async (options: ModelsOptions) => {
      state.exitCode = await runModels(options, io);
    });

  return program;
}

/**
 * Parse and dispatch.
 *
 * `argv` is the full `process.argv`, so a caller can hand this exactly what Node
 * gave it. Returns the exit code; the bin script assigns it to `process.exitCode`
 * rather than calling `process.exit`, which lets stdout flush — a truncated final
 * line on a piped run is a genuinely confusing bug to chase.
 */
export async function run(argv: readonly string[], io: Io = processIo): Promise<ExitCode> {
  const state: RunState = { exitCode: EXIT.Ok };
  const program = buildProgram(io, state);

  // `adze` with no arguments is a request for help, not an error.
  if (argv.length <= 2) {
    io.out(program.helpInformation());
    return EXIT.Ok;
  }

  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      // `--help` and `--version` are implemented as thrown control flow by
      // commander's exitOverride. They are successful invocations.
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.help') {
        return EXIT.Ok;
      }
      if (error.code === 'commander.version') return EXIT.Ok;
      // Everything else is a usage problem: unknown command, missing option,
      // excess argument. Commander has already written the message.
      return EXIT.Usage;
    }
    throw error;
  }

  return state.exitCode;
}
