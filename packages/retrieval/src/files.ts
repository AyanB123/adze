/**
 * Filesystem helpers.
 *
 * `walkFiles` exists as the fallback path for when ripgrep is unavailable. It is
 * deliberately worse than ripgrep — it does not read `.gitignore` — and it is
 * bounded so it cannot walk a home directory for a minute. Its purpose is that
 * symbol lookup still works at all when the bundled binary is missing, not that
 * it matches ripgrep's behaviour.
 */

import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import picomatch from 'picomatch';
import { toPosixPath } from './text.js';

/**
 * Directories skipped by the fallback walker.
 *
 * Without `.gitignore` parsing these are the ones that would otherwise dominate
 * the file count in any real repository.
 */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'out',
  'build',
  'target',
  'coverage',
  '.turbo',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.adze',
  '.cache',
]);

export interface WalkOptions {
  readonly root: string;
  readonly maxFiles: number;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  /** Only return files with one of these lower-case extensions. */
  readonly extensions?: readonly string[];
}

export interface WalkResult {
  /** Paths relative to `root`, forward slashes. */
  readonly files: readonly string[];
  readonly truncated: boolean;
}

function extensionOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/**
 * Read one directory, treating an unreadable one as empty.
 *
 * The return type is written out rather than derived from `typeof readdir`.
 * `readdir` is overloaded, and `Awaited<ReturnType<typeof readdir>>` resolves to
 * the *first* overload — the `Dirent<Buffer>` one — so entry names typed as
 * `Buffer` and the walker did not compile.
 */
async function readDirectory(directory: string): Promise<readonly Dirent<string>[]> {
  try {
    return await readdir(directory, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    // An unreadable directory is not a failure of the search.
    return [];
  }
}

/**
 * Compile the include, exclude, and extension filters once.
 *
 * Separated from the walk so the walk itself is just a queue and a bound. The
 * order matters for cost, not correctness: the extension check is a set lookup
 * and the glob checks are not, so the cheap one runs first.
 */
function buildPathFilter(options: WalkOptions): (relativePath: string) => boolean {
  const matchesInclude =
    options.include === undefined || options.include.length === 0
      ? undefined
      : picomatch(options.include as string[]);
  const matchesExclude =
    options.exclude === undefined || options.exclude.length === 0
      ? undefined
      : picomatch(options.exclude as string[]);
  const extensions =
    options.extensions === undefined
      ? undefined
      : new Set(options.extensions.map((e) => e.toLowerCase()));

  return (relativePath: string): boolean => {
    if (extensions !== undefined && !extensions.has(extensionOf(relativePath))) return false;
    if (matchesInclude !== undefined && !matchesInclude(relativePath)) return false;
    if (matchesExclude?.(relativePath) === true) return false;
    return true;
  };
}

/** One directory's worth of results: subdirectories to visit, files to keep. */
interface DirectoryScan {
  readonly subdirectories: readonly string[];
  readonly files: readonly string[];
}

/** Read one directory, partitioning it into what to visit and what to keep. */
async function scanDirectory(
  directory: string,
  root: string,
  accepts: (relativePath: string) => boolean,
): Promise<DirectoryScan> {
  const subdirectories: string[] = [];
  const files: string[] = [];

  for (const entry of await readDirectory(directory)) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) subdirectories.push(absolute);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = toPosixPath(relative(root, absolute));
    if (accepts(relativePath)) files.push(relativePath);
  }

  return { subdirectories, files };
}

/**
 * Bounded breadth-first walk of `root`.
 *
 * Breadth-first so that the cap, when hit, yields files near the top of the tree
 * rather than everything inside the first deep directory it happened to enter.
 */
export async function walkFiles(options: WalkOptions): Promise<WalkResult> {
  const accepts = buildPathFilter(options);
  const files: string[] = [];
  const queue: string[] = [options.root];

  while (queue.length > 0) {
    const directory = queue.shift();
    if (directory === undefined) break;

    const scan = await scanDirectory(directory, options.root, accepts);
    for (const file of scan.files) {
      files.push(file);
      if (files.length >= options.maxFiles) return { files, truncated: true };
    }
    queue.push(...scan.subdirectories);
  }

  return { files, truncated: false };
}

/**
 * Modification times in epoch milliseconds, keyed by the given relative path.
 *
 * Paths that cannot be stat'ed are omitted rather than defaulted, so the ranking
 * layer scores them as "unknown recency" instead of "very old" or "brand new".
 */
export async function modificationTimes(
  root: string,
  paths: readonly string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(paths)];
  const entries = await Promise.all(
    unique.map(async (path): Promise<readonly [string, number] | undefined> => {
      try {
        const info = await stat(join(root, path));
        return [path, info.mtimeMs] as const;
      } catch {
        return undefined;
      }
    }),
  );
  const out = new Map<string, number>();
  for (const entry of entries) {
    if (entry !== undefined) out.set(entry[0], entry[1]);
  }
  return out;
}
