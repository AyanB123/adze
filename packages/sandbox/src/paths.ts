/**
 * Path containment arithmetic.
 *
 * Every root check in this package goes through here, and the platform is an
 * argument rather than a global. That is what lets the mode matrix be tested on
 * any CI runner: a Windows root check is exercised on Linux and a POSIX one on
 * Windows, so neither branch can rot behind a `process.platform` guard nobody
 * runs.
 *
 * ## The two bugs this file exists to prevent
 *
 * **Prefix matching without a separator boundary.** `'/home/user/proj-backup'`
 * starts with `'/home/user/proj'`, so a naive `startsWith` grants writes to a
 * sibling directory the user never listed. Comparison is therefore either exact
 * equality or a match on `root + sep`.
 *
 * **Case sensitivity applied in the wrong direction.** On Windows, `c:\proj` and
 * `C:\PROJ` are the same directory, so a case-sensitive containment check would
 * let `c:\proj\x` escape a root declared as `C:\proj`. Windows comparisons fold
 * case; POSIX comparisons do not, because there two names that differ in case are
 * two different files and folding would merge them.
 *
 * Note this is the opposite choice from `samePath` in core's permission gate,
 * which deliberately does *not* fold case. The two are answering different
 * questions. The gate asks whether a tool touched the exact path it declared,
 * where folding would let a declaration for `A.ts` authorize a write to `a.ts`.
 * This file asks whether a path lands inside a directory on a real filesystem,
 * where not folding lets a write escape. Both directions are fail-closed for the
 * question actually being asked.
 *
 * ## What this file cannot do
 *
 * It does not resolve symlinks, junctions, or `\\?\` device paths, because it is
 * pure string arithmetic with no filesystem access. A symlink inside a writable
 * root pointing outside it defeats every check here. Seatbelt and bubblewrap
 * resolve paths in the kernel and are not fooled; the in-process fallback is, and
 * reports {@link Degradation} code `symlink-escape-unchecked` rather than implying
 * otherwise.
 *
 * Kernel resolution cuts both ways, and the second edge cost us a real bug. Because
 * Seatbelt matches `subpath` against the path it has **already resolved**, a rule
 * naming an unresolved spelling matches nothing — on macOS `/var` is a symlink to
 * `/private/var`, so a writable root under `os.tmpdir()` was denied writes it should
 * have allowed. Resolution is therefore a correctness obligation for whoever builds
 * a profile, not only a safety property; see `expandSymlinkedRoots` in
 * `seatbelt.ts`.
 */

import { posix, win32 } from 'node:path';

/** Which set of path rules applies. */
export type PathFlavor = 'posix' | 'win32';

export function flavorFor(platform: string): PathFlavor {
  return platform === 'win32' ? 'win32' : 'posix';
}

function api(flavor: PathFlavor): typeof posix {
  return flavor === 'win32' ? win32 : posix;
}

/**
 * Absolute, normalized, and comparable under `flavor`.
 *
 * Returns `undefined` for a relative path rather than resolving it against
 * `process.cwd()`. Silently resolving would make a containment decision depend on
 * where the engine happened to be started, which is both untestable and the kind
 * of ambient input a security check must not have.
 */
export function canonical(path: string, flavor: PathFlavor): string | undefined {
  const p = api(flavor);
  if (path.length === 0) return undefined;
  const unified = flavor === 'win32' ? path.replace(/\//g, '\\') : path;
  if (!p.isAbsolute(unified)) return undefined;
  const normalized = p.normalize(unified);
  const trimmed = stripTrailingSep(normalized, p.sep);
  return flavor === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/** Trailing separators removed, except on a filesystem root such as `/` or `C:\`. */
function stripTrailingSep(path: string, sep: string): string {
  if (path.length <= 1) return path;
  if (!path.endsWith(sep)) return path;
  // `C:\` and `\\server\share\` keep their separator; `/a/` and `C:\a\` lose it.
  const withoutSep = path.slice(0, -1);
  return withoutSep.endsWith(':') ? path : withoutSep;
}

/**
 * True when `candidate` is `root` or lives beneath it.
 *
 * A path that cannot be canonicalized is never within anything. Failing closed on
 * unparseable input is the only safe direction: the alternative is a relative path
 * being read as "inside whatever the caller meant".
 */
export function isWithin(root: string, candidate: string, flavor: PathFlavor): boolean {
  const r = canonical(root, flavor);
  const c = canonical(candidate, flavor);
  if (r === undefined || c === undefined) return false;
  if (r === c) return true;
  const sep = api(flavor).sep;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return c.startsWith(prefix);
}

/** The first root containing `candidate`, or `undefined`. Order is the caller's. */
export function containingRoot(
  roots: readonly string[],
  candidate: string,
  flavor: PathFlavor,
): string | undefined {
  return roots.find((root) => isWithin(root, candidate, flavor));
}

/** How a plan treats one concrete path. */
export type PathAccess = 'writable' | 'readable' | 'denied';

/**
 * Classify a path against readable and writable root lists.
 *
 * Writable is checked first, and a writable root does not have to appear in the
 * readable list to be readable — a directory you may write but not read is not a
 * configuration anyone means, and treating it as one produces bewildering
 * failures.
 */
export function classifyPath(
  path: string,
  roots: { readonly readable: readonly string[]; readonly writable: readonly string[] },
  flavor: PathFlavor,
): PathAccess {
  if (containingRoot(roots.writable, path, flavor) !== undefined) return 'writable';
  if (containingRoot(roots.readable, path, flavor) !== undefined) return 'readable';
  return 'denied';
}

/**
 * Canonicalize a root list, dropping anything unusable and collapsing nesting.
 *
 * Nested roots are collapsed because a mechanism given both `/a` and `/a/b` binds
 * the same tree twice, and bubblewrap in particular fails on a duplicate bind
 * target rather than ignoring it. Dropping unparseable entries silently would hide
 * a typo in a security-relevant setting, so {@link normalizeRoots} returns the
 * rejects for the caller to surface.
 */
export function normalizeRoots(
  roots: readonly string[],
  flavor: PathFlavor,
): { readonly roots: readonly string[]; readonly rejected: readonly string[] } {
  const rejected: string[] = [];
  const canonicalized: string[] = [];
  for (const root of roots) {
    const c = canonical(root, flavor);
    if (c === undefined) {
      rejected.push(root);
      continue;
    }
    if (!canonicalized.includes(c)) canonicalized.push(c);
  }
  const minimal = canonicalized.filter(
    (candidate) =>
      !canonicalized.some((other) => other !== candidate && isWithin(other, candidate, flavor)),
  );
  return { roots: minimal, rejected };
}
