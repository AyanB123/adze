/**
 * `adze apply` — apply an edit through `@adze/apply` and report what happened.
 *
 * The reporting is the point. `tier`, `strategy`, and the validator level that
 * actually ran are printed rather than hidden, because they are the fields that
 * make "apply success rate per model per tier" measurable, and because a user who
 * can see that an edit landed via `indentation-tolerant` matching knows to go and
 * look at the indentation.
 *
 * A refusal exits non-zero. Not because a refusal is a crash — it is the applier
 * working correctly, and the alternative was a corrupted file — but because a
 * caller in a script asked for an edit and did not get one.
 */

import { readFile, writeFile } from 'node:fs/promises';
import type { ApplyRequest, ApplyResult, EditBlock, ValidationResult } from '@adze/apply';
import { applyEdit } from '@adze/apply';
import { EXIT, type ExitCode, field, type Io, styleFor, writeJson } from '../output.js';

export interface ApplyOptions {
  readonly file?: string;
  readonly search?: string;
  readonly replace?: string;
  readonly edits?: string;
  readonly occurrence?: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

/** Shape of an `--edits` file. Validated by hand: the CLI does not depend on zod. */
interface EditsFile {
  readonly edits: readonly EditBlock[];
  readonly replacement?: string;
}

class UsageError extends Error {}

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function parseOccurrence(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new UsageError(`--occurrence must be a positive integer, got '${raw}'`);
  }
  return n;
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    throw new UsageError(`cannot read ${path}: ${reason(cause)}`);
  }
}

/**
 * Validate one entry of an `--edits` file.
 *
 * Checked field by field rather than trusted. These files are usually written by a
 * model or a script, so the failure to design for is a plausible-looking file with
 * one wrong field — and "edits[0].search must be a string" is a message its author
 * can act on, where "invalid edits file" is not.
 */
function parseOneEdit(entry: unknown, index: number, path: string): EditBlock {
  if (typeof entry !== 'object' || entry === null) {
    throw new UsageError(`${path}: edits[${index}] must be an object`);
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.search !== 'string') {
    throw new UsageError(`${path}: edits[${index}].search must be a string`);
  }
  if (typeof e.replace !== 'string') {
    throw new UsageError(`${path}: edits[${index}].replace must be a string`);
  }
  const occurrence = e.occurrence;
  if (occurrence !== undefined && (!Number.isInteger(occurrence) || Number(occurrence) < 1)) {
    throw new UsageError(`${path}: edits[${index}].occurrence must be a positive integer`);
  }
  return {
    search: e.search,
    replace: e.replace,
    ...(occurrence === undefined ? {} : { occurrence: Number(occurrence) }),
  };
}

function parseEditsFile(text: string, path: string): EditsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new UsageError(`${path} is not valid JSON: ${reason(cause)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new UsageError(`${path} must contain a JSON object with an 'edits' array`);
  }

  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.edits)) {
    throw new UsageError(`${path}: 'edits' must be an array`);
  }
  const edits = record.edits.map((entry, index) => parseOneEdit(entry, index, path));

  const replacement = record.replacement;
  if (replacement !== undefined && typeof replacement !== 'string') {
    throw new UsageError(`${path}: 'replacement' must be a string when present`);
  }
  return { edits, ...(replacement === undefined ? {} : { replacement }) };
}

/** Reject the ambiguous invocations before reading anything. */
function checkEditSource(options: ApplyOptions): 'inline' | 'file' {
  const hasInline = options.search !== undefined || options.replace !== undefined;
  const hasFile = options.edits !== undefined;

  if (hasInline && hasFile) {
    throw new UsageError('pass either --search/--replace or --edits, not both');
  }
  if (hasFile) return 'file';
  if (hasInline) return 'inline';

  throw new UsageError(
    'nothing to apply: pass --search and --replace, or --edits <file>.\n' +
      "A multi-line search block belongs in --edits: a shell cannot pass a newline through --search without mangling it, and the applier's matching is line-oriented.",
  );
}

function inlineEdits(options: ApplyOptions): readonly EditBlock[] {
  const { search, replace } = options;
  if (search === undefined || replace === undefined) {
    throw new UsageError('--search and --replace must be given together');
  }
  const occurrence = parseOccurrence(options.occurrence);
  return [{ search, replace, ...(occurrence === undefined ? {} : { occurrence }) }];
}

async function buildRequest(options: ApplyOptions): Promise<ApplyRequest> {
  const file = options.file;
  if (file === undefined || file.length === 0) throw new UsageError('--file is required');

  const source = checkEditSource(options);
  const original = await readText(file);

  if (source === 'inline') {
    return { path: file, original, edits: inlineEdits(options) };
  }

  const editsPath = options.edits ?? '';
  const parsed = parseEditsFile(await readText(editsPath), editsPath);
  return {
    path: file,
    original,
    edits: parsed.edits,
    ...(parsed.replacement === undefined ? {} : { replacement: parsed.replacement }),
  };
}

/**
 * Spell out what a validator level means.
 *
 * `none` in particular must not read as a pass. It means the language was unknown
 * and we declined to guess, which is a different claim from "this file parses" —
 * `ValidationResult.validator` is a claim about evidence.
 */
function describeValidator(level: ValidationResult['validator']): string {
  switch (level) {
    case 'tree-sitter':
      return 'tree-sitter (real parse)';
    case 'structural':
      return 'structural (delimiter and indentation check)';
    case 'none':
      return 'none (unknown language — not validated)';
  }
}

function reportSuccess(
  io: Io,
  result: Extract<ApplyResult, { ok: true }>,
  file: string,
  wrote: boolean,
): void {
  const s = styleFor(false);
  const t = result.telemetry;
  io.out(`${s.good('applied')} ${file}\n`);
  io.out(`${field('tier', t.tier)}\n`);
  // A whole-file rewrite locates nothing, so there is no strategy to report. Saying
  // so beats printing 'exact' for a match that never happened.
  io.out(`${field('match strategy', t.strategy ?? 'n/a (whole-file rewrite)')}\n`);
  io.out(`${field('validator', describeValidator(t.validation.validator))}\n`);
  io.out(`${field('tiers attempted', String(t.tiersAttempted))}\n`);
  io.out(`${field('bytes changed', String(t.bytesChanged))}\n`);
  io.out(`${field('edits', String(t.editCount))}\n`);
  io.out(
    wrote
      ? `${s.dim('file written')}\n`
      : `${s.warn('dry run')} ${s.dim('— nothing written; drop --dry-run to apply')}\n`,
  );
}

function reportRefusal(io: Io, result: Extract<ApplyResult, { ok: false }>, file: string): void {
  const s = styleFor(false);
  io.err(`${s.bad('refused')} ${file}\n`);
  io.err(`${field('reason', result.reason)}\n`);
  io.err(`\n${result.message}\n`);

  if (result.candidates !== undefined && result.candidates.length > 0) {
    io.err(`\n${s.bold('candidate matches')}\n`);
    for (const c of result.candidates) {
      io.err(`  line ${c.line}  (${c.strategy}, offsets ${c.start}-${c.end})\n`);
    }
    io.err(
      `\n${s.dim('Add surrounding context to make the block unique, or pass --occurrence <n>.')}\n`,
    );
  }

  io.err(
    `\n${s.dim('A refusal is the applier working: the alternative was writing a file it had broken.')}\n`,
  );
}

function emitRefusal(
  result: Extract<ApplyResult, { ok: false }>,
  file: string,
  io: Io,
  json: boolean,
): ExitCode {
  if (json) {
    writeJson(io, {
      ok: false,
      path: file,
      reason: result.reason,
      message: result.message,
      ...(result.candidates === undefined ? {} : { candidates: result.candidates }),
      telemetry: result.telemetry,
    });
  } else {
    reportRefusal(io, result, file);
  }
  return EXIT.Failure;
}

async function emitSuccess(
  result: Extract<ApplyResult, { ok: true }>,
  file: string,
  dryRun: boolean,
  io: Io,
  json: boolean,
): Promise<ExitCode> {
  if (!dryRun) {
    try {
      await writeFile(file, result.content, 'utf8');
    } catch (cause) {
      const message = `cannot write ${file}: ${reason(cause)}`;
      if (json) writeJson(io, { ok: false, error: 'write-failed', path: file, message });
      else io.err(`adze apply: ${message}\n`);
      return EXIT.Usage;
    }
  }

  if (json) {
    writeJson(io, {
      ok: true,
      path: file,
      written: !dryRun,
      telemetry: result.telemetry,
      locations: result.locations,
      // Included on a dry run and omitted otherwise: on a dry run it is the only
      // way to see the result, and after a write the file *is* the result.
      ...(dryRun ? { content: result.content } : {}),
    });
  } else {
    reportSuccess(io, result, file, !dryRun);
  }
  return EXIT.Ok;
}

export async function runApply(options: ApplyOptions, io: Io): Promise<ExitCode> {
  const json = options.json === true;

  let request: ApplyRequest;
  try {
    request = await buildRequest(options);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    if (json) writeJson(io, { ok: false, error: 'usage', message: error.message });
    else io.err(`adze apply: ${error.message}\n`);
    return EXIT.Usage;
  }

  const result = await applyEdit(request);
  return result.ok
    ? await emitSuccess(result, request.path, options.dryRun === true, io, json)
    : emitRefusal(result, request.path, io, json);
}
