#!/usr/bin/env node
/**
 * `adze-bench` — the benchmark entry point.
 *
 * Wired to the root scripts `bench:apply` and `bench:list`.
 *
 * Argument parsing is hand-rolled rather than using commander, so that `bench/`
 * carries no dependency the product does not already have. Two subcommands and four
 * flags do not justify one, and keeping the benchmark's dependency surface at zero
 * is part of keeping it isolated from what ships.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = join(here, '..');
const repoRoot = join(harnessRoot, '..', '..');
const entry = join(harnessRoot, 'dist', 'index.js');

if (!existsSync(entry)) {
  process.stderr.write(
    'adze-bench: @adze/bench-harness has not been built yet.\n\n' +
      '  pnpm install\n' +
      '  pnpm build\n\n' +
      `Expected: ${entry}\n`,
  );
  process.exit(2);
}

// pathToFileURL, not the bare path: a dynamic import of an absolute Windows path
// fails with ERR_UNSUPPORTED_ESM_URL_SCHEME because the drive letter parses as a
// URL scheme.
const harness = await import(pathToFileURL(entry).href);

const USAGE = `adze-bench — Adze benchmark runner

Usage:
  adze-bench apply [options]     run the apply-bench suite
  adze-bench list  [options]     list cases without running them

Options:
  --suite <name>   suite under bench/suites (default: apply-bench)
  --filter <text>  only cases whose id, tag, or description contains <text>
  --out <dir>      write the run here (default: bench/.runs/<stamp>-<suite>)
  --no-write       run and print, write nothing
  --json           machine-readable output on stdout
  -h, --help       this message

Exit codes:
  0  every case met its expectation
  1  at least one case failed
  2  usage error, or the suite could not be loaded
`;

const VALUE_FLAGS = new Set(['--suite', '--filter', '--out']);

function applyFlag(args, arg, value) {
  if (arg === '--suite') args.suite = value;
  else if (arg === '--filter') args.filter = value;
  else args.out = value;
}

function parseArgs(argv) {
  const args = {
    command: undefined,
    suite: 'apply-bench',
    filter: undefined,
    out: undefined,
    write: true,
    json: false,
  };
  const rest = argv.slice(2);

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '-h' || arg === '--help') return { ...args, command: 'help' };
    if (arg === '--json') args.json = true;
    else if (arg === '--no-write') args.write = false;
    else if (VALUE_FLAGS.has(arg)) {
      const value = rest[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      applyFlag(args, arg, value);
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    } else if (args.command === undefined) {
      args.command = arg;
    } else {
      throw new Error(`unexpected argument ${arg}`);
    }
  }
  return args;
}

function matches(benchCase, filter) {
  if (filter === undefined) return true;
  const needle = filter.toLowerCase();
  return (
    benchCase.id.toLowerCase().includes(needle) ||
    benchCase.description.toLowerCase().includes(needle) ||
    (benchCase.tags ?? []).some((t) => t.toLowerCase().includes(needle))
  );
}

let args;
try {
  args = parseArgs(process.argv);
} catch (error) {
  process.stderr.write(`adze-bench: ${error.message}\n\n${USAGE}`);
  process.exit(2);
}

if (args.command === 'help' || args.command === undefined) {
  process.stdout.write(USAGE);
  process.exit(args.command === undefined ? 2 : 0);
}

const suiteDir = join(repoRoot, 'bench', 'suites', args.suite);

let allCases;
try {
  allCases = await harness.loadCases(suiteDir);
} catch (error) {
  process.stderr.write(`adze-bench: ${error.message}\n`);
  process.exit(2);
}

const cases = allCases.filter((c) => matches(c, args.filter));

if (args.command === 'list') {
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          suite: args.suite,
          total: allCases.length,
          listed: cases.length,
          cases: cases.map((c) => ({
            id: c.id,
            description: c.description,
            path: c.path,
            file: c.file,
            expect: c.expect.kind === 'refusal' ? `refusal:${c.expect.reason}` : 'output',
            tags: c.tags ?? [],
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${args.suite}: ${cases.length} of ${allCases.length} case(s)\n\n`);
    for (const c of cases) {
      const expectation = c.expect.kind === 'refusal' ? `refuse ${c.expect.reason}` : 'apply';
      process.stdout.write(`  ${c.id.padEnd(34)} ${expectation.padEnd(22)} ${c.description}\n`);
    }
  }
  process.exit(0);
}

if (args.command !== 'apply') {
  process.stderr.write(`adze-bench: unknown command '${args.command}'\n\n${USAGE}`);
  process.exit(2);
}

if (cases.length === 0) {
  process.stderr.write(
    `adze-bench: no cases matched${args.filter === undefined ? '' : ` filter '${args.filter}'`}\n`,
  );
  process.exit(2);
}

const invocation = ['node', 'bench/harness/bin/adze-bench.mjs', ...process.argv.slice(2)].join(' ');
const outcome = await harness.runSuite(cases, { suite: args.suite, invocation });

let written;
if (args.write) {
  const dir =
    args.out === undefined
      ? join(repoRoot, 'bench', '.runs', `${harness.runStamp()}-${args.suite}`)
      : resolve(args.out);
  written = await harness.writeRun(outcome, dir);
}

if (args.json) {
  process.stdout.write(
    `${JSON.stringify({ report: outcome.report, written: written ?? null }, null, 2)}\n`,
  );
} else {
  process.stdout.write(`${harness.renderConsoleSummary(outcome.report)}\n`);
  if (written !== undefined) {
    process.stdout.write(`\nreport   ${written.reportPath}\n`);
    process.stdout.write(`result   ${written.resultPath}\n`);
    process.stdout.write(
      `trials   ${written.trajectoryCount} trajectory file(s), failures included\n`,
    );
  }
  // Said on every run, not only in the report, because a number quoted from a
  // terminal is the one most likely to end up somewhere without its caveats.
  process.stdout.write(
    '\nThis suite measures the applier against hand-written edits. It is not a\n' +
      'measurement of any model, and its number is not a per-model result.\n',
  );
}

const failed = outcome.report.totals.failed + outcome.report.totals.harnessErrors;
process.exitCode = failed > 0 ? 1 : 0;
