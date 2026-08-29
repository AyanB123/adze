/**
 * Filesystem and text utility tests.
 *
 * `walkFiles` is the fallback for when ripgrep is unavailable, and it is
 * deliberately worse: it does not read `.gitignore`. Its purpose is that symbol
 * lookup still works at all when the bundled binary is missing. So the tests here
 * pin the bound and the skip list, which are what keep "worse" from becoming
 * "walks a home directory for a minute".
 *
 * `modificationTimes` omits what it cannot stat rather than defaulting, because
 * the ranking layer scores an unknown mtime as unknown rather than as brand new.
 */

import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modificationTimes, walkFiles } from '../src/files.js';
import {
  estimateTokens,
  indentWidth,
  indexLines,
  isBlank,
  leadingWhitespace,
  toPosixPath,
} from '../src/text.js';
import { createFixture, SEARCH_FILES } from './fixture.js';

describe('walkFiles', () => {
  it('returns paths relative to the root with forward slashes', async () => {
    const fixture = await createFixture({ 'src/nested/deep/a.ts': 'x\n' });
    try {
      const result = await walkFiles({ root: fixture.root, maxFiles: 100 });
      expect(result.files).toEqual(['src/nested/deep/a.ts']);
      for (const file of result.files) expect(file).not.toContain('\\');
    } finally {
      await fixture.cleanup();
    }
  });

  it('skips the directories that would otherwise dominate any real repository', async () => {
    const fixture = await createFixture({
      'src/a.ts': 'x\n',
      'node_modules/pkg/index.js': 'x\n',
      'dist/a.js': 'x\n',
      'target/debug/a.rs': 'x\n',
      'coverage/lcov.info': 'x\n',
      '.git/config': 'x\n',
      '__pycache__/a.pyc': 'x\n',
      '.adze/index/vectors.bin': 'x\n',
    });
    try {
      const result = await walkFiles({ root: fixture.root, maxFiles: 100 });
      expect(result.files).toEqual(['src/a.ts']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not read .gitignore, and the docs say so', async () => {
    // Stated as a fact rather than a defect: this is the documented difference
    // from ripgrep, and the provider reports it as a diagnostic when it degrades.
    const fixture = await createFixture(SEARCH_FILES, { initGit: true });
    try {
      const result = await walkFiles({ root: fixture.root, maxFiles: 100 });
      expect(result.files).toContain('ignored/secret.ts');
    } finally {
      await fixture.cleanup();
    }
  });

  it('stops at the file cap and marks truncation', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i++) files[`f${i}.ts`] = 'x\n';
    const fixture = await createFixture(files);
    try {
      const result = await walkFiles({ root: fixture.root, maxFiles: 7 });
      expect(result.files).toHaveLength(7);
      expect(result.truncated).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('walks breadth-first, so a cap yields files near the top of the tree', async () => {
    const fixture = await createFixture({
      'top.ts': 'x\n',
      'a/one.ts': 'x\n',
      'a/b/two.ts': 'x\n',
      'a/b/c/three.ts': 'x\n',
    });
    try {
      const result = await walkFiles({ root: fixture.root, maxFiles: 2 });
      // Depth-first would return everything inside the first deep directory.
      expect(result.files).toContain('top.ts');
      expect(result.files).not.toContain('a/b/c/three.ts');
    } finally {
      await fixture.cleanup();
    }
  });

  it('filters by extension', async () => {
    const fixture = await createFixture({ 'a.ts': 'x\n', 'b.py': 'x\n', 'c.md': 'x\n' });
    try {
      const result = await walkFiles({
        root: fixture.root,
        maxFiles: 100,
        extensions: ['ts', 'py'],
      });
      expect([...result.files].sort()).toEqual(['a.ts', 'b.py']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('matches extensions case-insensitively', async () => {
    const fixture = await createFixture({ 'a.TS': 'x\n' });
    try {
      const result = await walkFiles({ root: fixture.root, maxFiles: 10, extensions: ['ts'] });
      expect(result.files).toEqual(['a.TS']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('applies include and exclude globs', async () => {
    const fixture = await createFixture({
      'src/a.ts': 'x\n',
      'src/a.test.ts': 'x\n',
      'docs/b.md': 'x\n',
    });
    try {
      const included = await walkFiles({
        root: fixture.root,
        maxFiles: 100,
        include: ['src/**'],
      });
      expect([...included.files].sort()).toEqual(['src/a.test.ts', 'src/a.ts']);

      const excluded = await walkFiles({
        root: fixture.root,
        maxFiles: 100,
        include: ['src/**'],
        exclude: ['**/*.test.ts'],
      });
      expect(excluded.files).toEqual(['src/a.ts']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('treats an unreadable directory as empty rather than failing the walk', async () => {
    const fixture = await createFixture({ 'a.ts': 'x\n' });
    try {
      const result = await walkFiles({
        root: join(fixture.root, 'does-not-exist'),
        maxFiles: 10,
      });
      expect(result.files).toHaveLength(0);
      expect(result.truncated).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('returns nothing for an empty directory', async () => {
    const fixture = await createFixture({});
    try {
      const result = await walkFiles({ root: fixture.root, maxFiles: 10 });
      expect(result.files).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('modificationTimes', () => {
  it('reports an mtime per readable path', async () => {
    const fixture = await createFixture({ 'a.ts': 'x\n', 'b.ts': 'y\n' });
    try {
      const when = new Date(1_700_000_000_000);
      await utimes(join(fixture.root, 'a.ts'), when, when);
      const times = await modificationTimes(fixture.root, ['a.ts', 'b.ts']);
      expect(times.get('a.ts')).toBeCloseTo(1_700_000_000_000, -3);
      expect(times.get('b.ts')).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('omits a path it cannot stat instead of defaulting it', async () => {
    // A default would make ranking treat a vanished file as brand new or ancient.
    const fixture = await createFixture({ 'a.ts': 'x\n' });
    try {
      const times = await modificationTimes(fixture.root, ['a.ts', 'gone.ts']);
      expect(times.has('a.ts')).toBe(true);
      expect(times.has('gone.ts')).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('stats a duplicated path once', async () => {
    const fixture = await createFixture({ 'a.ts': 'x\n' });
    try {
      const times = await modificationTimes(fixture.root, ['a.ts', 'a.ts', 'a.ts']);
      expect(times.size).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('handles an empty path list', async () => {
    const fixture = await createFixture({});
    try {
      expect((await modificationTimes(fixture.root, [])).size).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('resolves a directory that no longer exists without throwing', async () => {
    const times = await modificationTimes(join('/definitely', 'not', 'here'), ['a.ts']);
    expect(times.size).toBe(0);
  });
});

describe('indexLines', () => {
  it('keeps exact character offsets', () => {
    const lines = indexLines('ab\ncd\n');
    expect(lines.map((l) => l.text)).toEqual(['ab', 'cd', '']);
    expect(lines[0]).toMatchObject({ start: 0, end: 2 });
    expect(lines[1]).toMatchObject({ start: 3, end: 5 });
  });

  it('excludes a carriage return from the line text and its end offset', () => {
    const lines = indexLines('ab\r\ncd\r\n');
    expect(lines[0]?.text).toBe('ab');
    expect(lines[0]?.end).toBe(2);
    expect(lines[1]?.text).toBe('cd');
  });

  it('handles text with no trailing newline', () => {
    const lines = indexLines('only');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: 'only', start: 0, end: 4 });
  });

  it('returns one empty line for empty input', () => {
    expect(indexLines('')).toEqual([{ text: '', start: 0, end: 0 }]);
  });

  it('lets a slice by offset reproduce the line', () => {
    const source = 'alpha\nbeta\ngamma\n';
    for (const line of indexLines(source)) {
      expect(source.slice(line.start, line.end)).toBe(line.text);
    }
  });
});

describe('text helpers', () => {
  it('reads leading whitespace without assuming a tab width', () => {
    expect(leadingWhitespace('\t  x')).toBe('\t  ');
    expect(leadingWhitespace('x')).toBe('');
    expect(indentWidth('\t  x')).toBe(3);
  });

  it('treats a whitespace-only line as blank', () => {
    expect(isBlank('')).toBe(true);
    expect(isBlank('  \t ')).toBe(true);
    expect(isBlank(' x ')).toBe(false);
  });

  it('estimates tokens at four characters each, never zero for real text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('normalises separators so results compare equal across platforms', () => {
    expect(toPosixPath('src\\a\\b.ts')).toBe('src/a/b.ts');
    expect(toPosixPath('src/a/b.ts')).toBe('src/a/b.ts');
  });
});
