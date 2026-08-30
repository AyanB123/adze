/**
 * Hidden-character scanning.
 *
 * The requirement is that this is a **hard failure**, so most of these tests assert a
 * refusal rather than a warning. The incident being defended against is a
 * self-propagating worm that hid its payload in invisible characters so reviewers saw
 * blank lines; a scanner that reports and continues would have let it through.
 */

import { describe, expect, it } from 'vitest';
import { describeFindings, notationFor, scanForHiddenCharacters } from '../src/unicode.js';

describe('scanForHiddenCharacters - clean input', () => {
  it('accepts ordinary source', () => {
    expect(scanForHiddenCharacters('const a = 1;\n// a comment\n').ok).toBe(true);
  });

  it('accepts non-ASCII text, which is not the problem being solved', () => {
    // Rejecting non-ASCII would make the scanner useless for a description written in
    // any language but English, and none of these characters are invisible.
    const outcome = scanForHiddenCharacters('Überprüfung der Änderungen — 変更を確認 — проверка');
    expect(outcome.ok).toBe(true);
  });

  it('accepts an emoji that does not need a joiner', () => {
    expect(scanForHiddenCharacters('ship it 🚀').ok).toBe(true);
  });

  it('accepts a single byte-order mark at the very start', () => {
    // Deliberate deviation from the spec: editors add this without being asked, and a
    // leading BOM hides nothing.
    expect(scanForHiddenCharacters('\uFEFF{"id":"acme.x"}').ok).toBe(true);
  });
});

describe('scanForHiddenCharacters - invisible characters', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['zero width space', '\u200B'],
    ['zero width non-joiner', '\u200C'],
    ['zero width joiner', '\u200D'],
    ['word joiner', '\u2060'],
    ['soft hyphen', '\u00AD'],
    ['invisible times', '\u2062'],
    ['hangul filler', '\u3164'],
    ['deprecated format character', '\u206A'],
    ['interlinear annotation anchor', '\uFFF9'],
  ];

  for (const [name, character] of cases) {
    it(`rejects ${name}`, () => {
      const outcome = scanForHiddenCharacters(`deny("ok${character}")`);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.findings[0]?.category).toBe('invisible');
    });
  }

  it('rejects a byte-order mark anywhere but the start', () => {
    const outcome = scanForHiddenCharacters('{"a":1}\uFEFF');
    expect(outcome.ok).toBe(false);
  });

  it('rejects a tag-block character, which encodes invisible ASCII', () => {
    // U+E0041 is an invisible "A". A run of these is a readable instruction that does
    // not appear on screen at all, which is the prompt-injection carrier.
    const outcome = scanForHiddenCharacters('safe\u{E0041}\u{E0042}');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.findings.map((finding) => finding.category)).toEqual(['tag', 'tag']);
  });
});

describe('scanForHiddenCharacters - bidirectional controls', () => {
  it('rejects a right-to-left override', () => {
    const outcome = scanForHiddenCharacters('if (admin) {\u202E /* end */ return; }');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.findings[0]?.category).toBe('bidi-control');
    expect(outcome.findings[0]?.name).toBe('RIGHT-TO-LEFT OVERRIDE');
  });

  it('rejects isolates and pops as well as overrides', () => {
    const outcome = scanForHiddenCharacters('\u2066a\u2069b\u202Cc');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.findings).toHaveLength(3);
  });

  it('rejects a line separator, which most editors do not render as a break', () => {
    const outcome = scanForHiddenCharacters('let a = 1\u2028return');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.findings[0]?.category).toBe('line-separator');
  });
});

describe('scanForHiddenCharacters - locating the finding', () => {
  it('reports every occurrence rather than only the first', () => {
    // Fixing one invisible character per validation pass is a bad experience for what
    // is usually a single bad paste.
    const outcome = scanForHiddenCharacters('a\u200Bb\u200Bc\u200B');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.findings).toHaveLength(3);
  });

  it('gives a 1-based line and column a reviewer can navigate to', () => {
    const outcome = scanForHiddenCharacters('line one\nline\u200Btwo\n');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const finding = outcome.findings[0];
    expect(finding?.line).toBe(2);
    expect(finding?.column).toBe(5);
    expect(finding?.notation).toBe('U+200B');
  });

  it('counts columns in code points, not UTF-16 units', () => {
    // An astral character before the finding must not shift the reported column by
    // two, or the reviewer looks at the wrong place.
    const outcome = scanForHiddenCharacters('🚀\u200B');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.findings[0]?.column).toBe(2);
  });

  it('describes findings with the file, position, and character name', () => {
    const outcome = scanForHiddenCharacters('x\u202Ey');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const described = describeFindings('adze.plugin.json', outcome.findings);
    expect(described).toContain('adze.plugin.json:1:2');
    expect(described).toContain('U+202E');
    expect(described).toContain('RIGHT-TO-LEFT OVERRIDE');
    expect(described).toContain('hard failure');
  });
});

describe('notationFor', () => {
  it('pads to at least four hex digits and uses upper case', () => {
    expect(notationFor(0x00ad)).toBe('U+00AD');
    expect(notationFor(0xe0041)).toBe('U+E0041');
  });
});
