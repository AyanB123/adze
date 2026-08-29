/**
 * ripgrep process layer.
 *
 * ripgrep is the first signal because most lookups are lexical and it needs no
 * index at all — instant usefulness on a fresh clone. It is Unlicense, so there
 * is no attribution burden, and `@vscode/ripgrep` ships a per-platform binary so
 * we never depend on a system `rg`.
 *
 * Three properties this module exists to guarantee:
 *
 * 1. **The query is data.** We spawn with an argument array, never a shell
 *    string, and pass the pattern behind `-e` so a pattern beginning with `-`
 *    cannot become a flag.
 * 2. **The invocation is reproducible.** `--no-config` is passed and
 *    `RIPGREP_CONFIG_PATH` is stripped from the child environment. Otherwise a
 *    file outside the repository silently adds flags to every search we run,
 *    which is both a correctness problem and an injection vector.
 * 3. **Nothing is unbounded.** A result cap and a wall-clock timeout both kill
 *    the child, and the result says which one fired. A pathological regex must
 *    not hang the engine, and an unbounded result set is a denial-of-service on
 *    a model's context window.
 *
 * We parse `--json`, not the human format. The human format is a display
 * artifact: it elides, it colours, and it changes between releases.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { CaseSensitivity } from './types.js';

/** Thrown when the ripgrep binary cannot be located or executed. */
export class RipgrepUnavailableError extends Error {
  override readonly name = 'RipgrepUnavailableError';
}

export interface RipgrepMatch {
  /** Path as ripgrep reported it, normalised to forward slashes. */
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based character column of the first submatch. */
  readonly column: number;
  /** The matching line, without its terminator. */
  readonly text: string;
  /** The matched text itself, useful for scoring. */
  readonly matchedText: string;
}

export interface RipgrepOptions {
  readonly pattern: string;
  /** When true, the pattern is a literal string rather than a regex. */
  readonly literal: boolean;
  readonly cwd: string;
  /** Subpaths to search. Defaults to the whole `cwd`. */
  readonly paths?: readonly string[];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly caseSensitivity?: CaseSensitivity;
  /** Lines of context to request on each side. */
  readonly contextLines?: number;
  /** Hard cap on matches. The child is killed once reached. */
  readonly maxResults: number;
  readonly timeoutMs: number;
  /** Defaults to true. */
  readonly respectGitignore?: boolean;
  /** Defaults to false. */
  readonly includeHidden?: boolean;
}

export interface RipgrepSearchResult {
  readonly matches: readonly RipgrepMatch[];
  readonly truncated: boolean;
  readonly truncationReason?: 'max-results' | 'timeout';
  /**
   * Every line ripgrep reported, per path, whether it was a match or context.
   * Context is best-effort: it contains what ripgrep sent and nothing more.
   */
  readonly linesByPath: ReadonlyMap<string, ReadonlyMap<number, string>>;
  readonly filesWithMatches: number;
  readonly durationMs: number;
  /** ripgrep's stderr, trimmed. Empty on a clean run. */
  readonly stderr: string;
}

/**
 * Resolve the bundled ripgrep binary.
 *
 * `@vscode/ripgrep` resolves its binary through platform-specific optional
 * dependencies and **throws at import time** when the current platform's
 * package is absent. So the import is dynamic and guarded: a missing binary
 * must degrade this package, not crash the process that loaded it.
 */
export async function resolveRipgrepPath(): Promise<
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string }
> {
  try {
    const mod: unknown = await import('@vscode/ripgrep');
    const candidate = (mod as { readonly rgPath?: unknown }).rgPath;
    if (typeof candidate !== 'string' || candidate.length === 0) {
      return { ok: false, message: "'@vscode/ripgrep' did not export a usable rgPath" };
    }
    return { ok: true, path: candidate };
  } catch (error) {
    return {
      ok: false,
      message:
        `ripgrep is unavailable: ${error instanceof Error ? error.message : String(error)}. ` +
        `Install the optional dependency for ${process.platform}-${process.arch}, ` +
        `or supply a provider without the lexical signal.`,
    };
  }
}

function caseFlag(sensitivity: CaseSensitivity | undefined): string {
  switch (sensitivity) {
    case 'sensitive':
      return '--case-sensitive';
    case 'insensitive':
      return '--ignore-case';
    default:
      return '--smart-case';
  }
}

/**
 * Build the argument array.
 *
 * Exported for tests: argument construction is the security boundary of this
 * module, so it is asserted directly rather than only through behaviour.
 */
export function buildRipgrepArgs(options: RipgrepOptions): string[] {
  const args: string[] = [
    '--json',
    // Reproducibility: never let a config file outside the repo add flags.
    '--no-config',
    // Makes `$` behave as authors expect in CRLF checkouts.
    '--crlf',
    caseFlag(options.caseSensitivity),
  ];

  if (options.literal) args.push('--fixed-strings');
  if (options.respectGitignore === false) args.push('--no-ignore');
  if (options.includeHidden === true) args.push('--hidden');

  const context = options.contextLines ?? 0;
  if (context > 0) args.push('--context', String(context));

  for (const glob of options.include ?? []) args.push('--glob', glob);
  // ripgrep spells exclusion as a negated include, which keeps precedence
  // rules in one place inside ripgrep rather than duplicated here.
  for (const glob of options.exclude ?? []) args.push('--glob', `!${glob}`);

  // `-e` marks the next argument as the pattern. Without it a query such as
  // `--foo` or `-i` would be parsed as a flag.
  args.push('-e', options.pattern);

  // `--` ends flag parsing, so a path beginning with `-` stays a path.
  args.push('--');
  const paths = options.paths ?? [];
  if (paths.length > 0) args.push(...paths);
  else args.push('.');

  return args;
}

/** ripgrep inherits the ambient environment minus anything that alters flags. */
function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'RIPGREP_CONFIG_PATH') continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface RgPathObject {
  readonly text?: unknown;
}

/**
 * Normalise a path ripgrep reported into a clean relative path.
 *
 * ripgrep echoes the search root back in every path, so searching `.` yields
 * `.\sub\a.ts` on Windows and `./sub/a.ts` elsewhere. Left alone, that leading
 * `./` is silently corrosive: `proximityScore` splits on `/` and would compare
 * `['.', 'sub']` against an open file's `['sub']`, finding no shared prefix and
 * cancelling the proximity boost; and the `walkFiles` fallback produces clean
 * paths, so the same file would key differently depending on which code path
 * found it. Strip it once, here, where paths enter the package.
 */
export function normalizeRelativePath(raw: string): string {
  let path = raw.replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  return path;
}

function readPath(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const text = (value as RgPathObject).text;
  return typeof text === 'string' ? normalizeRelativePath(text) : undefined;
}

function readLineText(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const text = (value as RgPathObject).text;
  if (typeof text !== 'string') return undefined;
  // ripgrep includes the terminator in `lines.text`.
  return text.replace(/\r?\n$/, '');
}

/**
 * Convert a ripgrep byte offset within a line into a 1-based character column.
 *
 * ripgrep reports byte offsets; JavaScript strings are UTF-16 code units. On a
 * line containing non-ASCII text these differ, and reporting the byte offset as
 * a column puts the caret in the wrong place.
 */
export function byteOffsetToColumn(lineText: string, byteOffset: number): number {
  if (byteOffset <= 0) return 1;
  const bytes = Buffer.from(lineText, 'utf8');
  const clamped = Math.min(byteOffset, bytes.length);
  return bytes.subarray(0, clamped).toString('utf8').length + 1;
}

interface Submatch {
  readonly start?: unknown;
  readonly match?: unknown;
}

function firstSubmatch(value: unknown): { readonly start: number; readonly text: string } {
  if (!Array.isArray(value) || value.length === 0) return { start: 0, text: '' };
  const first: unknown = value[0];
  if (typeof first !== 'object' || first === null) return { start: 0, text: '' };
  const sub = first as Submatch;
  const start = typeof sub.start === 'number' ? sub.start : 0;
  const text = readLineText(sub.match) ?? '';
  return { start, text };
}

interface ParserState {
  readonly matches: RipgrepMatch[];
  readonly linesByPath: Map<string, Map<number, string>>;
  filesWithMatches: number;
}

function recordLine(state: ParserState, path: string, line: number, text: string): void {
  let forPath = state.linesByPath.get(path);
  if (forPath === undefined) {
    forPath = new Map<number, string>();
    state.linesByPath.set(path, forPath);
  }
  forPath.set(line, text);
}

/**
 * Consume one NDJSON event.
 *
 * Returns true once the match cap is reached, which tells the caller to kill
 * the child rather than read a result set it has already decided to discard.
 */
function handleEvent(state: ParserState, event: unknown, maxResults: number): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const { type, data } = event as { readonly type?: unknown; readonly data?: unknown };
  if (typeof data !== 'object' || data === null) return false;

  const record = data as {
    readonly path?: unknown;
    readonly lines?: unknown;
    readonly line_number?: unknown;
    readonly submatches?: unknown;
  };
  const path = readPath(record.path);
  if (path === undefined) return false;

  if (type === 'end') {
    state.filesWithMatches++;
    return false;
  }
  if (type !== 'match' && type !== 'context') return false;

  const text = readLineText(record.lines);
  const lineNumber = typeof record.line_number === 'number' ? record.line_number : undefined;
  if (text === undefined || lineNumber === undefined) return false;

  recordLine(state, path, lineNumber, text);
  if (type === 'context') return false;

  const sub = firstSubmatch(record.submatches);
  state.matches.push({
    path,
    line: lineNumber,
    column: byteOffsetToColumn(text, sub.start),
    text,
    matchedText: sub.text,
  });
  return state.matches.length >= maxResults;
}

/** Kill a child process, tolerating one that has already exited. */
function killQuietly(child: ChildProcess): void {
  try {
    child.kill();
  } catch {
    // Already gone. Nothing to do, and nothing worth reporting.
  }
}

/**
 * Run one ripgrep search.
 *
 * Rejects with {@link RipgrepUnavailableError} when the binary is missing or
 * cannot be spawned. Every other failure — including a bad regex — comes back
 * as a normal result with `stderr` populated, because "your pattern did not
 * compile" is information for the caller, not an exception.
 */
export async function ripgrepSearch(options: RipgrepOptions): Promise<RipgrepSearchResult> {
  const resolved = await resolveRipgrepPath();
  if (!resolved.ok) throw new RipgrepUnavailableError(resolved.message);

  const startedAt = performance.now();
  const args = buildRipgrepArgs(options);

  return await new Promise<RipgrepSearchResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(resolved.path, args, {
        cwd: options.cwd,
        env: childEnvironment(),
        // Explicit: the query must never reach a shell.
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(
        new RipgrepUnavailableError(`failed to spawn ripgrep at '${resolved.path}'`, {
          cause: error,
        }),
      );
      return;
    }

    const state: ParserState = { matches: [], linesByPath: new Map(), filesWithMatches: 0 };
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let stderr = '';
    let truncationReason: 'max-results' | 'timeout' | undefined;
    let settled = false;

    const timer = setTimeout(() => {
      truncationReason = 'timeout';
      killQuietly(child);
    }, options.timeoutMs);
    // A pending timer must not keep the process alive on its own.
    timer.unref?.();

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        matches: state.matches,
        truncated: truncationReason !== undefined,
        ...(truncationReason ? { truncationReason } : {}),
        linesByPath: state.linesByPath,
        filesWithMatches: state.filesWithMatches,
        durationMs: performance.now() - startedAt,
        stderr: stderr.trim(),
      });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncationReason !== undefined) return;
      pending += decoder.write(chunk);
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.length > 0) {
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            // A malformed line is ripgrep-side noise; the rest of the stream is
            // still usable, so skip it rather than failing the whole search.
            newline = pending.indexOf('\n');
            continue;
          }
          if (handleEvent(state, event, options.maxResults)) {
            truncationReason = 'max-results';
            killQuietly(child);
            return;
          }
        }
        newline = pending.indexOf('\n');
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      // Bound stderr too: a broken invocation can produce a lot of it.
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new RipgrepUnavailableError(`ripgrep failed to run at '${resolved.path}'`, {
          cause: error,
        }),
      );
    });

    child.on('close', finish);
  });
}

export interface RipgrepListFilesOptions {
  readonly cwd: string;
  readonly paths?: readonly string[];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly maxFiles: number;
  readonly timeoutMs: number;
  readonly respectGitignore?: boolean;
  readonly includeHidden?: boolean;
}

export interface RipgrepListFilesResult {
  readonly files: readonly string[];
  readonly truncated: boolean;
}

/**
 * List files ripgrep would search, honouring the same ignore rules.
 *
 * Used as the file source for symbol extraction when there is no query to
 * prefilter on. Reusing ripgrep here rather than writing a second directory
 * walker keeps one definition of "which files count".
 */
export async function ripgrepListFiles(
  options: RipgrepListFilesOptions,
): Promise<RipgrepListFilesResult> {
  const resolved = await resolveRipgrepPath();
  if (!resolved.ok) throw new RipgrepUnavailableError(resolved.message);

  const args: string[] = ['--files', '--no-config'];
  if (options.respectGitignore === false) args.push('--no-ignore');
  if (options.includeHidden === true) args.push('--hidden');
  for (const glob of options.include ?? []) args.push('--glob', glob);
  for (const glob of options.exclude ?? []) args.push('--glob', `!${glob}`);
  args.push('--');
  const paths = options.paths ?? [];
  if (paths.length > 0) args.push(...paths);
  else args.push('.');

  return await new Promise<RipgrepListFilesResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(resolved.path, args, {
        cwd: options.cwd,
        env: childEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      reject(new RipgrepUnavailableError('failed to spawn ripgrep', { cause: error }));
      return;
    }

    const files: string[] = [];
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let truncated = false;
    let settled = false;

    const timer = setTimeout(() => {
      truncated = true;
      killQuietly(child);
    }, options.timeoutMs);
    timer.unref?.();

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ files, truncated });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated) return;
      pending += decoder.write(chunk);
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (line.length > 0) {
          files.push(normalizeRelativePath(line));
          if (files.length >= options.maxFiles) {
            truncated = true;
            killQuietly(child);
            return;
          }
        }
        newline = pending.indexOf('\n');
      }
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new RipgrepUnavailableError('ripgrep failed to run', { cause: error }));
    });

    child.on('close', finish);
  });
}

/**
 * Escape a literal string for use inside a ripgrep regex.
 *
 * Needed when a caller wants word-boundary semantics around a name the user
 * typed, since `--fixed-strings` and `\b` are mutually exclusive.
 */
export function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}
