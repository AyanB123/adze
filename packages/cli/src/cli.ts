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
import { type DoctorOptions, runDoctor } from './commands/doctor.js';
import { runValidate, type ValidateOptions } from './commands/validate.js';
import { EXIT, type ExitCode, type Io, processIo } from './output.js';
import { CLI_VERSION } from './version.js';

/**
 * A command that is specified but not built.
 *
 * Printed as a plain statement with the milestone that will deliver it. The
 * alternative — letting `adze chat` fail with a module resolution error, or worse,
 * printing a fake prompt — is how a project ends up describing planned capabilities
 * as working.
 */
function notImplemented(name: string, what: string, io: Io): ExitCode {
  io.err(
    `adze ${name}: not implemented yet.\n\n` +
      `  ${what}\n\n` +
      '  This lands in milestone M1 (engine and CLI). The tracked list is\n' +
      '  docs/roadmap.md — it has no dates, because inventing a schedule for a\n' +
      '  new project would be fiction. The ordering is the commitment.\n\n' +
      '  Working today: adze apply, adze validate, adze doctor.\n',
  );
  return EXIT.NotImplemented;
}

interface RunState {
  exitCode: ExitCode;
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

  program
    .command('chat')
    .description('interactive session with the agent (not implemented yet — M1)')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      state.exitCode = notImplemented(
        'chat',
        'An interactive session needs the turn machine, the tool registry, and the permission gate from @adze/core, none of which exist yet.',
        io,
      );
    });

  program
    .command('run')
    .description('run a single task to completion (not implemented yet — M1)')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      state.exitCode = notImplemented(
        'run',
        'A non-interactive task needs @adze/core and a configured provider from @adze/providers, neither of which exists yet.',
        io,
      );
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
