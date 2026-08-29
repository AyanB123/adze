import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveEditPath, samePath } from '../src/edits/paths.js';

describe('resolveEditPath', () => {
  it('resolves a workspace-relative path against the root', () => {
    expect(resolveEditPath(resolve('/w'), 'src/a.ts')).toBe(resolve('/w/src/a.ts'));
  });

  it('leaves an absolute path alone, because the edit tool accepts one', () => {
    const absolute = resolve('/elsewhere/b.ts');
    expect(resolveEditPath(resolve('/w'), absolute)).toBe(absolute);
  });

  it('normalises a traversal rather than leaving it in the path', () => {
    expect(resolveEditPath(resolve('/w'), 'src/../a.ts')).toBe(resolve('/w/a.ts'));
  });
});

describe('samePath', () => {
  it('compares case-insensitively on Windows', () => {
    // Without this the decoration silently never appears for C:\Foo versus c:\foo.
    expect(samePath(resolve('/W/A.ts'), resolve('/w/a.ts'), 'win32')).toBe(true);
  });

  it('compares case-insensitively on macOS', () => {
    expect(samePath(resolve('/W/A.ts'), resolve('/w/a.ts'), 'darwin')).toBe(true);
  });

  it('compares case-sensitively on Linux', () => {
    expect(samePath(resolve('/W/A.ts'), resolve('/w/a.ts'), 'linux')).toBe(false);
  });

  it('still distinguishes genuinely different files', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(samePath(resolve('/w/a.ts'), resolve('/w/b.ts'), platform)).toBe(false);
    }
  });
});
