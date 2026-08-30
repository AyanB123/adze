/**
 * Locating helper binaries, with the host injected.
 *
 * A `which` implementation looks like a utility and is really a test-surface
 * decision. Shelling out to `which` or `where.exe` would mean every capability
 * probe spawns a process, so tests would either spawn real processes — making the
 * result depend on what happens to be installed on the CI runner — or stub at a
 * level too coarse to catch a `PATHEXT` mistake. Reading `PATH` directly with an
 * injected filesystem makes the Windows lookup rules testable on Linux, which is
 * where they will actually be reviewed.
 */

import { access, constants } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

/** The host facts capability detection is allowed to read. Nothing else. */
export interface HostProbe {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** True when the path exists and is executable. */
  isExecutable(path: string): Promise<boolean>;
  /** File contents, or `undefined` when absent or unreadable. */
  readText(path: string): Promise<string | undefined>;
}

/** The real host. Reads only `process.platform`, `process.env`, and the filesystem. */
export function nodeHostProbe(): HostProbe {
  return {
    platform: process.platform,
    env: process.env,
    async isExecutable(path: string): Promise<boolean> {
      try {
        // X_OK is meaningless on Windows — the check degrades to existence there,
        // which is why PATHEXT rather than a permission bit decides what is runnable.
        await access(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    async readText(path: string): Promise<string | undefined> {
      try {
        const { readFile } = await import('node:fs/promises');
        return await readFile(path, 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Extensions that make a bare name runnable on Windows.
 *
 * Used only when `PATHEXT` is unset. Hard-coding the fallback rather than assuming
 * the variable exists matters because a stripped environment — which is what this
 * package hands to subprocesses on purpose — has no `PATHEXT`, and a capability
 * probe returning "taskkill is missing" on a machine where it plainly is not would
 * make every Windows report wrong.
 */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * First matching executable on `PATH`, or `undefined`.
 *
 * An absolute or explicitly relative name bypasses the `PATH` walk, matching what
 * every shell does: `./tool` means that tool, not whichever `tool` is first on the
 * path.
 */
export async function whichExecutable(name: string, probe: HostProbe): Promise<string | undefined> {
  const isWindows = probe.platform === 'win32';
  const p = isWindows ? win32 : posix;

  if (p.isAbsolute(name) || name.startsWith('.')) {
    return (await firstRunnable([name], probe, isWindows)) ?? undefined;
  }

  // Windows spells it `Path` in some shells and `PATH` in others, and a probe that read
  // only one would report every helper binary as missing in the other.
  const raw = probe.env.PATH ?? probe.env.Path ?? '';
  const entries = raw.split(isWindows ? ';' : ':').filter((entry) => entry.length > 0);
  for (const entry of entries) {
    const found = await firstRunnable([p.join(entry, name)], probe, isWindows);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Try each candidate, expanding Windows extensions. */
async function firstRunnable(
  candidates: readonly string[],
  probe: HostProbe,
  isWindows: boolean,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    for (const expanded of expand(candidate, probe, isWindows)) {
      if (await probe.isExecutable(expanded)) return expanded;
    }
  }
  return undefined;
}

function expand(candidate: string, probe: HostProbe, isWindows: boolean): readonly string[] {
  if (!isWindows) return [candidate];
  const exts = (probe.env.PATHEXT ?? DEFAULT_PATHEXT).split(';').filter((ext) => ext.length > 0);
  // The bare name first: an extensionless script with a shebang is still runnable
  // under a shell, and reporting it as absent would be wrong.
  const withExts = exts.map((ext) => candidate + ext.toLowerCase());
  return [candidate, ...withExts, ...exts.map((ext) => candidate + ext)];
}
