import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isWithin, MemoryFileSystem, resolveWithinRoots } from '../src/fs.js';

/**
 * A filesystem where some paths are aliases the OS resolves away.
 *
 * Models the two real cases the gate has to survive: a Windows 8.3 short path such
 * as `C:\Users\AYANBA~1\...`, which `realpath` expands to the long name, and a macOS
 * symlink such as `/tmp` into `/private/tmp`. Injected rather than created on disk so
 * both are exercised on every runner — a check that could only be verified on the
 * affected OS is a check nobody reviews.
 *
 * Every path goes through `resolve` before comparison, and prefix matching uses the
 * platform separator. Without that the aliases silently never match on Windows,
 * because `resolve('/short')` is `C:\short` — which is how the first draft of these
 * tests passed while exercising nothing.
 */
class AliasingFileSystem extends MemoryFileSystem {
  constructor(private readonly aliases: Readonly<Record<string, string>>) {
    super();
  }

  override async realpath(path: string): Promise<string | undefined> {
    const target = resolve(path);
    for (const [alias, real] of Object.entries(this.aliases)) {
      const from = resolve(alias);
      const to = resolve(real);
      if (target === from) return to;
      if (target.startsWith(from + sep)) return to + target.slice(from.length);
    }
    return await super.realpath(path);
  }
}

describe('isWithin', () => {
  it('accepts the root itself and paths beneath it', () => {
    expect(isWithin('/work', '/work')).toBe(true);
    expect(isWithin('/work', '/work/src/a.ts')).toBe(true);
  });

  it('rejects a sibling that merely shares a prefix', () => {
    // `/work` is a textual prefix of `/work-secrets`, and a prefix check would
    // authorize writes into the second while claiming to permit only the first.
    expect(isWithin('/work', '/work-secrets/creds')).toBe(false);
  });

  it('rejects an escape through ..', () => {
    expect(isWithin('/work', '/work/../etc/passwd')).toBe(false);
  });
});

describe('resolveWithinRoots', () => {
  it('accepts a path inside a plainly-spelled root', async () => {
    const result = await resolveWithinRoots(
      '/work/src/a.ts',
      ['/work'],
      new AliasingFileSystem({}),
    );
    expect(result.within).toBe(true);
    expect(result.root).toBe('/work');
  });

  it('rejects a path outside every root', async () => {
    const result = await resolveWithinRoots(
      '/elsewhere/a.ts',
      ['/work'],
      new AliasingFileSystem({}),
    );
    expect(result.within).toBe(false);
  });

  /**
   * The regression that made the first live agent run unusable.
   *
   * Canonicalizing only the candidate and comparing it against the raw roots means a
   * root spelled with an alias never matches its own contents. The gate denied every
   * read inside the workspace it had been handed, reporting each as "outside the
   * workspace" — a correct-looking message that was completely wrong.
   */
  it('accepts a path inside a root that is itself spelled as an alias', async () => {
    const fs = new AliasingFileSystem({ '/short': '/Long Name' });
    const result = await resolveWithinRoots('/short/work/a.ts', ['/short/work'], fs);
    expect(result.within).toBe(true);
    // The caller's spelling comes back, not the resolved one: it is what they
    // configured and what a denial message should name.
    expect(result.root).toBe('/short/work');
  });

  it('still rejects an alias inside the root that resolves outside it', async () => {
    // Resolving the roots must not become a way in. A symlink within the workspace
    // pointing elsewhere is the classic escape, and it stays denied.
    const fs = new AliasingFileSystem({ '/short/work/link': '/elsewhere' });
    const result = await resolveWithinRoots('/short/work/link/a.ts', ['/short/work'], fs);
    expect(result.within).toBe(false);
  });

  it('accepts a path whose parent directories do not exist yet', async () => {
    // A write often creates its own directories, so an unresolvable tail must not be
    // read as an escape. Nothing here aliases, so the lexical answer stands.
    const result = await resolveWithinRoots(
      '/work/new/nested/a.ts',
      ['/work'],
      new AliasingFileSystem({}),
    );
    expect(result.within).toBe(true);
  });
});
