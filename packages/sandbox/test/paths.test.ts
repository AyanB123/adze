import { describe, expect, it } from 'vitest';
import {
  canonical,
  classifyPath,
  containingRoot,
  flavorFor,
  isWithin,
  normalizeRoots,
} from '../src/paths.js';

describe('flavorFor', () => {
  it('selects win32 rules only for win32', () => {
    expect(flavorFor('win32')).toBe('win32');
    expect(flavorFor('darwin')).toBe('posix');
    expect(flavorFor('linux')).toBe('posix');
    expect(flavorFor('freebsd')).toBe('posix');
  });
});

describe('canonical', () => {
  it('normalizes traversal', () => {
    expect(canonical('/home/user/proj/../proj/src', 'posix')).toBe('/home/user/proj/src');
    expect(canonical('C:\\work\\a\\..\\b', 'win32')).toBe('c:\\work\\b');
  });

  it('strips a trailing separator but keeps a filesystem root', () => {
    expect(canonical('/home/user/', 'posix')).toBe('/home/user');
    expect(canonical('/', 'posix')).toBe('/');
    expect(canonical('C:\\', 'win32')).toBe('c:\\');
  });

  it('folds case on win32 and preserves it on posix', () => {
    expect(canonical('C:\\Work\\Proj', 'win32')).toBe('c:\\work\\proj');
    expect(canonical('/Users/Ada/Proj', 'posix')).toBe('/Users/Ada/Proj');
  });

  it('accepts forward slashes on win32', () => {
    expect(canonical('C:/work/proj', 'win32')).toBe('c:\\work\\proj');
  });

  it('refuses a relative path rather than resolving it against the cwd', () => {
    expect(canonical('src/index.ts', 'posix')).toBeUndefined();
    expect(canonical('./src', 'posix')).toBeUndefined();
    expect(canonical('..', 'posix')).toBeUndefined();
    expect(canonical('work\\proj', 'win32')).toBeUndefined();
    expect(canonical('', 'posix')).toBeUndefined();
  });

  it('treats a UNC path as absolute on win32', () => {
    expect(canonical('\\\\server\\share\\proj', 'win32')).toBe('\\\\server\\share\\proj');
  });
});

describe('isWithin', () => {
  it('accepts the root itself and anything beneath it', () => {
    expect(isWithin('/home/user/proj', '/home/user/proj', 'posix')).toBe(true);
    expect(isWithin('/home/user/proj', '/home/user/proj/src/a.ts', 'posix')).toBe(true);
  });

  // The bug this function exists to prevent: a naive startsWith grants a sibling.
  it('does not match a sibling sharing a name prefix', () => {
    expect(isWithin('/home/user/proj', '/home/user/proj-backup/secrets', 'posix')).toBe(false);
    expect(isWithin('/home/user/proj', '/home/user/projects', 'posix')).toBe(false);
    expect(isWithin('C:\\work\\proj', 'C:\\work\\proj2\\x', 'win32')).toBe(false);
  });

  it('rejects an escape via traversal', () => {
    expect(isWithin('/home/user/proj', '/home/user/proj/../../etc/passwd', 'posix')).toBe(false);
    expect(isWithin('C:\\work\\proj', 'C:\\work\\proj\\..\\..\\Windows', 'win32')).toBe(false);
  });

  // Not folding case on Windows would let c:\proj escape a root declared as C:\proj.
  it('is case-insensitive on win32 and case-sensitive on posix', () => {
    expect(isWithin('C:\\Work\\Proj', 'c:\\work\\proj\\src', 'win32')).toBe(true);
    expect(isWithin('/home/user/proj', '/home/user/PROJ/src', 'posix')).toBe(false);
  });

  it('is never within anything when either path is unusable', () => {
    expect(isWithin('proj', '/home/user/proj/a', 'posix')).toBe(false);
    expect(isWithin('/home/user/proj', 'a.ts', 'posix')).toBe(false);
    expect(isWithin('', '', 'posix')).toBe(false);
  });

  it('treats a posix root of / as containing everything absolute', () => {
    expect(isWithin('/', '/etc/passwd', 'posix')).toBe(true);
  });
});

describe('containingRoot', () => {
  it('returns the first matching root in the caller order', () => {
    const roots = ['/a', '/b'];
    expect(containingRoot(roots, '/b/x', 'posix')).toBe('/b');
    expect(containingRoot(roots, '/c/x', 'posix')).toBeUndefined();
  });
});

describe('classifyPath', () => {
  const roots = { readable: ['/repo'], writable: ['/repo/build'] };

  it('prefers writable when a path is in both lists', () => {
    expect(classifyPath('/repo/build/out.js', roots, 'posix')).toBe('writable');
  });

  it('reports readable inside a readable root', () => {
    expect(classifyPath('/repo/src/a.ts', roots, 'posix')).toBe('readable');
  });

  it('reports denied outside every root', () => {
    expect(classifyPath('/etc/passwd', roots, 'posix')).toBe('denied');
  });

  // A directory writable but unreadable is not a configuration anyone means.
  it('treats a writable root as readable even when absent from the readable list', () => {
    expect(
      classifyPath('/only-writable/x', { readable: [], writable: ['/only-writable'] }, 'posix'),
    ).toBe('writable');
  });
});

describe('normalizeRoots', () => {
  it('collapses a nested root into its parent', () => {
    const result = normalizeRoots(['/repo', '/repo/packages/app'], 'posix');
    expect(result.roots).toEqual(['/repo']);
    expect(result.rejected).toEqual([]);
  });

  it('deduplicates paths that differ only in spelling', () => {
    const result = normalizeRoots(['/repo/', '/repo/./', '/repo/sub/..'], 'posix');
    expect(result.roots).toEqual(['/repo']);
  });

  it('reports a relative root instead of silently dropping it', () => {
    const result = normalizeRoots(['./build', '/repo'], 'posix');
    expect(result.roots).toEqual(['/repo']);
    expect(result.rejected).toEqual(['./build']);
  });

  it('keeps unrelated roots', () => {
    const result = normalizeRoots(['/repo', '/cache'], 'posix');
    expect(result.roots).toEqual(['/repo', '/cache']);
  });

  it('folds win32 case when deduplicating', () => {
    const result = normalizeRoots(['C:\\Work', 'c:\\work\\sub'], 'win32');
    expect(result.roots).toEqual(['c:\\work']);
  });
});
