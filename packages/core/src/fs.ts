/**
 * Filesystem access, behind an interface.
 *
 * Two reasons this is not a direct `node:fs/promises` import at each call site.
 *
 * **Path containment has to be one function.** `isWithin` is what the permission
 * gate uses to decide whether a write lands inside `writableRoots`, and a second
 * copy of that logic somewhere else is a second chance to get it wrong. It is
 * exported and directly tested for that reason.
 *
 * **A write must be atomic.** A whole-file replacement that is interrupted
 * halfway leaves the user with neither the old file nor the new one, which is the
 * corruption class `@adze/apply` exists to prevent — refusing to write a broken
 * file is worthless if the write itself can truncate it. So `writeFile` here means
 * write-a-temp-then-rename, and the interface documents that as part of its
 * contract rather than leaving it to whichever implementation shows up.
 */

import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface FileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
}

export interface EngineFileSystem {
  readFile(path: string): Promise<string>;
  /** Atomic: writes a sibling temp file and renames it over the target. */
  writeFile(path: string, contents: string): Promise<void>;
  /** `undefined` when the path does not exist. Never throws for absence. */
  stat(path: string): Promise<FileStat | undefined>;
  /**
   * Canonical path with symlinks resolved, or `undefined` if it does not exist.
   *
   * Used by the gate to re-check containment after resolution, so a symlink inside
   * a writable root cannot point a write outside it.
   */
  realpath(path: string): Promise<string | undefined>;
}

/**
 * True when `candidate` is `root` or lives beneath it.
 *
 * Implemented with `path.relative` rather than string prefixing, because
 * `/work` is a prefix of `/workspace-secrets` and a prefix check would authorize
 * writes into the second while claiming to permit only the first.
 *
 * Purely lexical: it resolves `..` but knows nothing about symlinks. That is why
 * the gate calls it a second time against a realpath — see
 * {@link resolveWithinRoots}.
 */
export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === '') return true;
  return !rel.startsWith('..') && !isAbsolute(rel);
}

export interface ContainmentCheck {
  /** The path to use, absolute and resolved. */
  readonly path: string;
  readonly within: boolean;
  /** The root that contained it, when one did. */
  readonly root?: string;
}

/**
 * Resolve `candidate` and report whether it stays inside any of `roots`.
 *
 * Checked twice: once lexically, and once against the canonical path of the
 * nearest existing ancestor. The second pass is what catches a symlinked
 * directory inside a writable root pointing somewhere else — the common way a
 * lexical-only check is defeated.
 *
 * It is a best effort and is documented as one. A path created *between* this
 * check and the write is not covered, and defeating that race requires
 * OS-level containment (`@adze/sandbox`, ADR-0007). The gate is a policy
 * boundary; it is not a kernel.
 */
export async function resolveWithinRoots(
  candidate: string,
  roots: readonly string[],
  fs: EngineFileSystem,
): Promise<ContainmentCheck> {
  const absolute = resolve(candidate);
  const lexical = roots.find((root) => isWithin(root, absolute));
  if (lexical === undefined) return { path: absolute, within: false };

  const canonical = await canonicalize(absolute, fs);
  let matched = roots.find((root) => isWithin(root, canonical));

  if (matched === undefined) {
    // The root itself may be spelled with an alias the OS resolves away, in which
    // case comparing a canonical candidate against a raw root fails and the
    // workspace rejects itself. On Windows `%TEMP%` is commonly an 8.3 short path
    // (`C:\Users\AYANBA~1\...`) that realpath expands; on macOS `/tmp` and `/var`
    // are symlinks into `/private`. Both are the normal spelling of a scratch
    // directory, so this was not an edge case: every read inside such a workspace
    // was reported as outside it.
    //
    // Canonicalizing the roots is deferred to here rather than done up front
    // because this is a per-tool-call hot path and the raw comparison succeeds
    // whenever the caller already passed a resolved root.
    const canonicalRoots = await Promise.all(
      roots.map(async (root) => await canonicalize(resolve(root), fs)),
    );
    const index = canonicalRoots.findIndex((root) => isWithin(root, canonical));
    // Report the caller's spelling, not ours: it is what they configured, and it is
    // what a denial message or an approval prompt should name back to them.
    if (index !== -1) matched = roots[index];
  }

  if (matched === undefined) return { path: absolute, within: false };
  return { path: absolute, within: true, root: matched };
}

/** Canonical path of the nearest existing ancestor, with the rest reattached. */
async function canonicalize(absolute: string, fs: EngineFileSystem): Promise<string> {
  const segments: string[] = [];
  let current = absolute;
  for (;;) {
    const resolved = await fs.realpath(current);
    if (resolved !== undefined) {
      return segments.length === 0 ? resolved : join(resolved, ...segments.reverse());
    }
    const parent = dirname(current);
    // Reached the filesystem root without finding anything that exists.
    if (parent === current) return absolute;
    segments.push(current.slice(parent.length).replace(/^[\\/]/, ''));
    current = parent;
  }
}

/** `node:fs` implementation. The only place in the engine that touches disk. */
export const nodeFileSystem: EngineFileSystem = {
  async readFile(path) {
    return await readFile(path, 'utf8');
  },

  async writeFile(path, contents) {
    const target = resolve(path);
    await mkdir(dirname(target), { recursive: true });
    // Same directory as the target so the rename cannot cross a filesystem
    // boundary, which would silently degrade to a copy and lose atomicity.
    const temp = `${target}.adze-${process.pid.toString(36)}-${Date.now().toString(36)}.tmp`;
    try {
      await writeFile(temp, contents, 'utf8');
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  },

  async stat(path) {
    try {
      const info = await stat(path);
      return { isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size };
    } catch {
      return undefined;
    }
  },

  async realpath(path) {
    try {
      await access(path, constants.F_OK);
      return await realpath(path);
    } catch {
      return undefined;
    }
  },
};

/** In-memory filesystem. For tests, and for embedding where disk is not available. */
export class MemoryFileSystem implements EngineFileSystem {
  private readonly files = new Map<string, string>();
  private readonly directories = new Set<string>();

  constructor(seed: Readonly<Record<string, string>> = {}) {
    for (const [path, contents] of Object.entries(seed)) this.seed(path, contents);
  }

  seed(path: string, contents: string): void {
    const target = resolve(path);
    this.files.set(target, contents);
    let dir = dirname(target);
    for (;;) {
      this.directories.add(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  seedDirectory(path: string): void {
    this.directories.add(resolve(path));
  }

  async readFile(path: string): Promise<string> {
    const contents = this.files.get(resolve(path));
    if (contents === undefined) throw new Error(`ENOENT: no such file '${path}'`);
    return await Promise.resolve(contents);
  }

  async writeFile(path: string, contents: string): Promise<void> {
    this.seed(path, contents);
    await Promise.resolve();
  }

  async stat(path: string): Promise<FileStat | undefined> {
    const target = resolve(path);
    const file = this.files.get(target);
    if (file !== undefined) {
      return await Promise.resolve({
        isFile: true,
        isDirectory: false,
        size: Buffer.byteLength(file, 'utf8'),
      });
    }
    if (this.directories.has(target)) {
      return await Promise.resolve({ isFile: false, isDirectory: true, size: 0 });
    }
    return await Promise.resolve(undefined);
  }

  async realpath(path: string): Promise<string | undefined> {
    const target = resolve(path);
    const exists = this.files.has(target) || this.directories.has(target);
    return await Promise.resolve(exists ? target : undefined);
  }
}
