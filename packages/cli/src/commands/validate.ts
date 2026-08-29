/**
 * `adze validate <files...>` — parse-validate files and report which validator
 * actually ran.
 *
 * The honesty requirement is the whole design here. `@adze/apply`'s validator
 * degrades: a real tree-sitter parse when grammars are present, a structural
 * delimiter-and-indentation check otherwise, and `none` when the language is
 * unknown. Those are three different claims about evidence, so this command reports
 * three different outcomes and never lets `none` read as a pass — a file we
 * declined to inspect is not a file that parses.
 */

import { readFile } from 'node:fs/promises';
import type { ValidationResult } from '@adze/apply';
import { detectLanguage, validate } from '@adze/apply';
import { EXIT, type ExitCode, type Io, styleFor, writeJson } from '../output.js';

export interface ValidateOptions {
  readonly json?: boolean;
}

type Outcome = 'valid' | 'skipped' | 'invalid' | 'unreadable';

interface FileReport {
  readonly path: string;
  readonly outcome: Outcome;
  readonly language: string;
  /** The level that actually ran. Absent when the file could not be read. */
  readonly validator?: ValidationResult['validator'];
  readonly message?: string;
  readonly line?: number;
}

async function validateOne(path: string): Promise<FileReport> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (cause) {
    return {
      path,
      outcome: 'unreadable',
      language: detectLanguage(path),
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }

  const language = detectLanguage(path);
  const result = validate(content, language);

  // `validator: 'none'` with `ok: true` means "we did not look", not "it is fine".
  if (result.validator === 'none') {
    return {
      path,
      outcome: 'skipped',
      language,
      validator: 'none',
      ...(result.message === undefined ? {} : { message: result.message }),
    };
  }

  return {
    path,
    outcome: result.ok ? 'valid' : 'invalid',
    language,
    validator: result.validator,
    ...(result.message === undefined ? {} : { message: result.message }),
    ...(result.line === undefined ? {} : { line: result.line }),
  };
}

interface Counts {
  readonly valid: number;
  readonly skipped: number;
  readonly invalid: number;
  readonly unreadable: number;
}

/** One line per file. Extracted so `runValidate` stays a readable dispatch. */
function renderOne(report: FileReport, io: Io): void {
  const s = styleFor(false);
  switch (report.outcome) {
    case 'valid':
      io.out(`${s.good('ok      ')} ${report.path}  ${s.dim(`(${report.validator})`)}\n`);
      return;
    case 'skipped':
      // On stdout rather than silently dropped: "not validated" is information the
      // caller needs, even though it is not a failure.
      io.out(
        `${s.warn('skipped ')} ${report.path}  ${s.dim(
          `(no validator for '${report.language || 'unknown'}' — not checked)`,
        )}\n`,
      );
      return;
    case 'invalid': {
      const where = report.line === undefined ? '' : ` at line ${report.line}`;
      io.err(
        `${s.bad('invalid ')} ${report.path}  ${s.dim(`(${report.validator})`)}\n` +
          `          ${report.message ?? 'failed validation'}${where}\n`,
      );
      return;
    }
    case 'unreadable':
      io.err(`${s.bad('error   ')} ${report.path}\n          ${report.message ?? 'cannot read'}\n`);
      return;
  }
}

function renderSummary(counts: Counts, io: Io): void {
  const s = styleFor(false);
  const parts = [`${counts.valid} validated`];
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  if (counts.invalid > 0) parts.push(`${counts.invalid} invalid`);
  if (counts.unreadable > 0) parts.push(`${counts.unreadable} unreadable`);
  io.out(`\n${parts.join(', ')}\n`);

  if (counts.skipped > 0) {
    io.out(
      `${s.dim("A skipped file was not checked at all. 'validate' reports the level that ran rather than implying a parse.")}\n`,
    );
  }
}

export async function runValidate(
  files: readonly string[],
  options: ValidateOptions,
  io: Io,
): Promise<ExitCode> {
  const json = options.json === true;

  if (files.length === 0) {
    const message = 'no files given: adze validate <files...>';
    if (json) writeJson(io, { ok: false, error: 'usage', message });
    else io.err(`adze validate: ${message}\n`);
    return EXIT.Usage;
  }

  const reports: FileReport[] = [];
  for (const file of files) {
    reports.push(await validateOne(file));
  }

  const counts: Counts = {
    valid: reports.filter((r) => r.outcome === 'valid').length,
    skipped: reports.filter((r) => r.outcome === 'skipped').length,
    invalid: reports.filter((r) => r.outcome === 'invalid').length,
    unreadable: reports.filter((r) => r.outcome === 'unreadable').length,
  };

  if (json) {
    writeJson(io, { ok: counts.invalid === 0 && counts.unreadable === 0, counts, files: reports });
  } else {
    for (const report of reports) renderOne(report, io);
    renderSummary(counts, io);
  }

  return counts.invalid > 0 || counts.unreadable > 0 ? EXIT.Failure : EXIT.Ok;
}
