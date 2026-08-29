import { describe, expect, it } from 'vitest';
import { findMatch, indexLines, reindentReplacement } from '../src/match.js';

describe('indexLines', () => {
  it('preserves exact offsets across LF', () => {
    const lines = indexLines('a\nbb\nccc');
    expect(lines.map((l) => l.text)).toEqual(['a', 'bb', 'ccc']);
    expect(lines[0]?.start).toBe(0);
    expect(lines[1]?.start).toBe(2);
    expect(lines[2]?.start).toBe(5);
  });

  it('strips CR from line text but keeps offsets consistent with the source', () => {
    const src = 'a\r\nb';
    const lines = indexLines(src);
    expect(lines.map((l) => l.text)).toEqual(['a', 'b']);
    expect(src.slice(lines[1]?.start ?? 0)).toBe('b');
  });
});

describe('findMatch — exact', () => {
  it('finds a byte-identical match', () => {
    const r = findMatch('const a = 1;\nconst b = 2;\n', 'const b = 2;');
    expect(r.strategy).toBe('exact');
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.line).toBe(2);
  });

  it('returns every occurrence rather than choosing one', () => {
    const r = findMatch('x();\ny();\nx();\n', 'x();');
    expect(r.strategy).toBe('exact');
    expect(r.matches).toHaveLength(2);
    expect(r.matches.map((m) => m.line)).toEqual([1, 3]);
  });

  it('matches mid-line, not only whole lines', () => {
    const r = findMatch('foo(bar, baz)', 'bar, baz');
    expect(r.strategy).toBe('exact');
    expect(r.matches[0]?.start).toBe(4);
  });
});

describe('findMatch — whitespace-normalized', () => {
  it('tolerates differing internal spacing', () => {
    const haystack = 'if (a   ===   b) {\n  go();\n}\n';
    const r = findMatch(haystack, 'if (a === b) {');
    expect(r.strategy).toBe('whitespace-normalized');
    expect(r.matches).toHaveLength(1);
  });

  it('does not fire when exact already matched', () => {
    const r = findMatch('a = 1', 'a = 1');
    expect(r.strategy).toBe('exact');
  });
});

describe('findMatch — indentation-tolerant', () => {
  it('matches a block quoted from the wrong nesting level', () => {
    const haystack = ['class A {', '  method() {', '    return 1;', '  }', '}'].join('\n');
    // Model quoted the body with no leading indentation.
    const needle = ['method() {', '  return 1;', '}'].join('\n');
    const r = findMatch(haystack, needle);
    expect(r.strategy).toBe('indentation-tolerant');
    expect(r.matches[0]?.line).toBe(2);
    expect(r.matches[0]?.foundIndent).toBe('  ');
    expect(r.matches[0]?.searchIndent).toBe('');
  });

  it('still requires relative indentation inside the block to match', () => {
    const haystack = ['def f():', '    a = 1', '    b = 2'].join('\n');
    // `b` is indented differently relative to `a` than in the source.
    const needle = ['def f():', '  a = 1', '      b = 2'].join('\n');
    expect(findMatch(haystack, needle).matches).toHaveLength(0);
  });
});

describe('findMatch — anchored', () => {
  it('splices an elided interior when both anchors are unique', () => {
    const haystack = ['function big() {', '  a();', '  b();', '  c();', '}', ''].join('\n');
    const needle = ['function big() {', '  ...', '}'].join('\n');
    const r = findMatch(haystack, needle);
    expect(r.strategy).toBe('anchored');
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.line).toBe(1);
  });

  it('refuses when the anchor lines are not unique', () => {
    const haystack = ['{', '  a();', '}', '{', '  b();', '}'].join('\n');
    const needle = ['{', '  ...', '}'].join('\n');
    // Ambiguous anchors would mean guessing at the span, so no match is returned.
    expect(findMatch(haystack, needle).matches).toHaveLength(0);
  });

  it('requires at least three lines', () => {
    expect(findMatch('a\nb\n', 'a\nb').strategy).not.toBe('anchored');
  });
});

describe('findMatch — refusal', () => {
  it('returns nothing for an absent needle rather than a nearest guess', () => {
    const r = findMatch('const a = 1;\n', 'const totallyDifferent = 99;');
    expect(r.matches).toHaveLength(0);
    expect(r.strategy).toBeUndefined();
  });

  it('does not fuzzy-match a single changed identifier', () => {
    // A near-miss on source is a different program. This must NOT match.
    const r = findMatch('deleteUser(id);\n', 'deleteUsers(id);');
    expect(r.matches).toHaveLength(0);
  });
});

describe('reindentReplacement', () => {
  it('rebases replacement lines onto the indentation found in the file', () => {
    const match = {
      start: 0,
      end: 0,
      line: 1,
      strategy: 'indentation-tolerant' as const,
      foundIndent: '    ',
      searchIndent: '',
    };
    const out = reindentReplacement('method() {\n  return 2;\n}', match);
    expect(out).toBe('    method() {\n      return 2;\n    }');
  });

  it('leaves blank lines untouched', () => {
    const match = {
      start: 0,
      end: 0,
      line: 1,
      strategy: 'indentation-tolerant' as const,
      foundIndent: '  ',
      searchIndent: '',
    };
    expect(reindentReplacement('a\n\nb', match)).toBe('  a\n\n  b');
  });

  it('is a no-op for strategies that carry no indent information', () => {
    const match = { start: 0, end: 0, line: 1, strategy: 'exact' as const };
    expect(reindentReplacement('a\n  b', match)).toBe('a\n  b');
  });
});
