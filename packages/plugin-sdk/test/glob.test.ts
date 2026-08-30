/**
 * Glob matching for declarative context providers.
 *
 * The zero-segment case for `**` is the one that matters: `docs/adr/**\/*.md` has to
 * match `docs/adr/0001.md`, or the spec's own example provider silently returns
 * nothing for the files it most obviously means.
 */

import { describe, expect, it } from 'vitest';
import { compileGlob, compileGlobSet, toPosix } from '../src/glob.js';

function matcher(pattern: string): (path: string) => boolean {
  const compiled = compileGlob(pattern);
  if (!compiled.ok) throw new Error(compiled.message);
  return compiled.matcher;
}

describe('compileGlob', () => {
  it('matches a literal path', () => {
    const matches = matcher('README.md');
    expect(matches('README.md')).toBe(true);
    expect(matches('docs/README.md')).toBe(false);
  });

  it('keeps * inside one segment', () => {
    const matches = matcher('docs/*.md');
    expect(matches('docs/a.md')).toBe(true);
    expect(matches('docs/adr/a.md')).toBe(false);
  });

  it('lets ** cross segments, including zero of them', () => {
    const matches = matcher('docs/**/*.md');
    expect(matches('docs/a.md')).toBe(true);
    expect(matches('docs/adr/a.md')).toBe(true);
    expect(matches('docs/adr/deep/a.md')).toBe(true);
    expect(matches('other/a.md')).toBe(false);
  });

  it('matches the spec example against a real ADR path', () => {
    expect(matcher('docs/adr/**/*.md')('docs/adr/0008-plugin-architecture.md')).toBe(true);
  });

  it('handles ? as exactly one non-separator character', () => {
    const matches = matcher('a?.ts');
    expect(matches('ab.ts')).toBe(true);
    expect(matches('a.ts')).toBe(false);
    expect(matches('a/b.ts')).toBe(false);
  });

  it('handles character classes including negation', () => {
    expect(matcher('[abc].ts')('b.ts')).toBe(true);
    expect(matcher('[!abc].ts')('d.ts')).toBe(true);
    expect(matcher('[!abc].ts')('a.ts')).toBe(false);
  });

  it('handles brace alternation', () => {
    const matches = matcher('src/*.{ts,tsx}');
    expect(matches('src/a.ts')).toBe(true);
    expect(matches('src/a.tsx')).toBe(true);
    expect(matches('src/a.js')).toBe(false);
  });

  it('escapes regex metacharacters that are literal in a glob', () => {
    const matches = matcher('a+b(c).md');
    expect(matches('a+b(c).md')).toBe(true);
    expect(matches('aab(c).md')).toBe(false);
  });

  it('normalizes separators so a manifest behaves the same on every platform', () => {
    // A provider that silently matches nothing on Windows looks like a plugin that
    // does nothing.
    expect(matcher('docs/**/*.md')('docs\\adr\\a.md')).toBe(true);
    expect(toPosix('.\\docs\\a.md')).toBe('docs/a.md');
  });
});

describe('compileGlob - refusals', () => {
  it('refuses an empty pattern', () => {
    expect(compileGlob('').ok).toBe(false);
  });

  it('refuses an unclosed character class or brace group', () => {
    expect(compileGlob('a[bc.ts').ok).toBe(false);
    expect(compileGlob('a{b,c.ts').ok).toBe(false);
    expect(compileGlob('a}b').ok).toBe(false);
  });

  it('refuses an empty character class', () => {
    expect(compileGlob('a[].ts').ok).toBe(false);
  });
});

describe('compileGlobSet', () => {
  it('ORs the patterns together', () => {
    const set = compileGlobSet(['docs/**/*.md', 'README.md']);
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.matches('docs/a.md')).toBe(true);
    expect(set.matches('README.md')).toBe(true);
    expect(set.matches('src/a.ts')).toBe(false);
  });

  it('reports every bad pattern, not just the first', () => {
    const set = compileGlobSet(['a[b', 'c{d', 'ok.md']);
    expect(set.ok).toBe(false);
    if (set.ok) return;
    expect(set.messages).toHaveLength(2);
  });
});
