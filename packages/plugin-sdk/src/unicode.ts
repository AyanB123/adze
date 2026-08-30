/**
 * Invisible-Unicode and bidirectional-control scanning.
 *
 * This is a **hard failure, not a warning**, and the reason is a specific
 * incident rather than a general worry. The first self-propagating worm on a
 * major extension registry hid its payload in invisible characters, so a human
 * reviewer reading the diff saw blank lines where the malicious code was. Any
 * review process that treats "there is something here you cannot see" as advisory
 * is defeated by the same trick a second time.
 *
 * Two attack shapes are covered, and they are different problems:
 *
 * **Invisible characters** occupy no visual space, so `deny("ok")` and
 * `deny("ok\u200B")` render identically while comparing unequal, and a payload
 * placed between zero-width characters is simply not on screen. This includes the
 * Unicode *tags* block, `U+E0000`–`U+E007F`, which encodes an entire ASCII
 * alphabet invisibly and is the standard carrier for smuggled instructions aimed
 * at a model rather than at a runtime.
 *
 * **Bidirectional controls** reorder rendered text without changing its bytes, so
 * the source a reviewer reads and the source the compiler reads can differ
 * arbitrarily — the "Trojan Source" class. A right-to-left override inside a
 * comment can make an early `return` appear to be inside the comment.
 *
 * ## Two deliberate deviations from the spec
 *
 * The spec says scanning is a build failure and stops there. Two edges needed a
 * decision, and both are recorded here rather than in a commit message:
 *
 * 1. **A single byte-order mark at offset 0 is permitted.** `U+FEFF` anywhere
 *    else is rejected. A leading BOM is a file-encoding artifact that editors on
 *    Windows add without being asked, and rejecting it would fail plugins for a
 *    reason unrelated to the attack — while a BOM in the *middle* of a file is
 *    exactly the invisible-character case and stays fatal.
 * 2. **`U+200D` (zero-width joiner) is rejected even though emoji need it.**
 *    A family emoji in a `description` is a legitimate use and will be refused.
 *    That cost is accepted: ZWJ is the most common zero-width smuggling carrier,
 *    and an author who hits this gets an error naming the code point and its
 *    offset, which takes a minute to fix. Silently allowing it would leave the
 *    widest hole in the scanner.
 *
 * Findings carry a code point, a byte offset, and a 1-based line and column, so
 * the answer to "where" is not "somewhere in this file".
 */

/** One character that must not be in a manifest or in plugin source. */
export interface UnicodeFinding {
  /** The offending code point. */
  readonly codePoint: number;
  /** `U+200B` form, for an error message a human can search for. */
  readonly notation: string;
  /** Unicode's name, so the reader does not have to look it up. */
  readonly name: string;
  readonly category: UnicodeFindingCategory;
  /** UTF-16 code-unit offset into the scanned text. */
  readonly offset: number;
  /** 1-based. */
  readonly line: number;
  /** 1-based, counted in code points. */
  readonly column: number;
}

export type UnicodeFindingCategory =
  /** Renders as nothing. Hides content from a reviewer. */
  | 'invisible'
  /** Reorders rendered text without changing bytes. Trojan Source. */
  | 'bidi-control'
  /** The tags block: an invisible ASCII alphabet. */
  | 'tag'
  /** A line break that most editors do not render as one. */
  | 'line-separator';

export type UnicodeScanOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly findings: readonly UnicodeFinding[] };

interface Rule {
  readonly name: string;
  readonly category: UnicodeFindingCategory;
}

/**
 * The rejected set, one entry per code point so every finding can be named.
 *
 * Ranges are expanded by {@link ruleFor} rather than listed, but each range still
 * carries a name: an error that says `U+E0041` without saying what it is invites
 * the reader to assume it is harmless.
 */
const EXACT: ReadonlyMap<number, Rule> = new Map<number, Rule>([
  // --- Bidirectional controls (Trojan Source) ------------------------------
  [0x202a, { name: 'LEFT-TO-RIGHT EMBEDDING', category: 'bidi-control' }],
  [0x202b, { name: 'RIGHT-TO-LEFT EMBEDDING', category: 'bidi-control' }],
  [0x202c, { name: 'POP DIRECTIONAL FORMATTING', category: 'bidi-control' }],
  [0x202d, { name: 'LEFT-TO-RIGHT OVERRIDE', category: 'bidi-control' }],
  [0x202e, { name: 'RIGHT-TO-LEFT OVERRIDE', category: 'bidi-control' }],
  [0x2066, { name: 'LEFT-TO-RIGHT ISOLATE', category: 'bidi-control' }],
  [0x2067, { name: 'RIGHT-TO-LEFT ISOLATE', category: 'bidi-control' }],
  [0x2068, { name: 'FIRST STRONG ISOLATE', category: 'bidi-control' }],
  [0x2069, { name: 'POP DIRECTIONAL ISOLATE', category: 'bidi-control' }],
  [0x200e, { name: 'LEFT-TO-RIGHT MARK', category: 'bidi-control' }],
  [0x200f, { name: 'RIGHT-TO-LEFT MARK', category: 'bidi-control' }],
  [0x061c, { name: 'ARABIC LETTER MARK', category: 'bidi-control' }],

  // --- Zero-width and invisible -------------------------------------------
  [0x00ad, { name: 'SOFT HYPHEN', category: 'invisible' }],
  [0x180e, { name: 'MONGOLIAN VOWEL SEPARATOR', category: 'invisible' }],
  [0x200b, { name: 'ZERO WIDTH SPACE', category: 'invisible' }],
  [0x200c, { name: 'ZERO WIDTH NON-JOINER', category: 'invisible' }],
  [0x200d, { name: 'ZERO WIDTH JOINER', category: 'invisible' }],
  [0x2060, { name: 'WORD JOINER', category: 'invisible' }],
  [0x2061, { name: 'FUNCTION APPLICATION', category: 'invisible' }],
  [0x2062, { name: 'INVISIBLE TIMES', category: 'invisible' }],
  [0x2063, { name: 'INVISIBLE SEPARATOR', category: 'invisible' }],
  [0x2064, { name: 'INVISIBLE PLUS', category: 'invisible' }],
  [0xfeff, { name: 'ZERO WIDTH NO-BREAK SPACE (BOM)', category: 'invisible' }],

  // Invisible characters with a code chart entry that looks like a letter slot.
  // These are the homoglyph-adjacent fillers; each renders as nothing.
  [0x115f, { name: 'HANGUL CHOSEONG FILLER', category: 'invisible' }],
  [0x1160, { name: 'HANGUL JUNGSEONG FILLER', category: 'invisible' }],
  [0x17b4, { name: 'KHMER VOWEL INHERENT AQ', category: 'invisible' }],
  [0x17b5, { name: 'KHMER VOWEL INHERENT AA', category: 'invisible' }],
  [0x3164, { name: 'HANGUL FILLER', category: 'invisible' }],
  [0xffa0, { name: 'HALFWIDTH HANGUL FILLER', category: 'invisible' }],

  // --- Line breaks most editors do not render as breaks -------------------
  [0x2028, { name: 'LINE SEPARATOR', category: 'line-separator' }],
  [0x2029, { name: 'PARAGRAPH SEPARATOR', category: 'line-separator' }],
]);

function ruleFor(codePoint: number): Rule | undefined {
  const exact = EXACT.get(codePoint);
  if (exact !== undefined) return exact;

  // Deprecated format characters. Retained by Unicode, used by nothing legitimate.
  if (codePoint >= 0x206a && codePoint <= 0x206f) {
    return { name: 'DEPRECATED FORMAT CHARACTER', category: 'invisible' };
  }
  // Interlinear annotation. Explicitly "not for interchange" per Unicode.
  if (codePoint >= 0xfff9 && codePoint <= 0xfffb) {
    return { name: 'INTERLINEAR ANNOTATION CONTROL', category: 'invisible' };
  }
  // Variation selectors supplement. The base block U+FE00..U+FE0F is allowed
  // because emoji presentation needs it; this supplement has no such use and is
  // a known carrier.
  if (codePoint >= 0xe0100 && codePoint <= 0xe01ef) {
    return { name: 'VARIATION SELECTOR SUPPLEMENT', category: 'invisible' };
  }
  // The tags block: an invisible ASCII alphabet.
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) {
    return { name: 'UNICODE TAG CHARACTER (invisible ASCII)', category: 'tag' };
  }
  return undefined;
}

export function notationFor(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Scan text for characters that must not appear in a plugin.
 *
 * Every finding is reported rather than only the first: an author fixing one
 * invisible character at a time, with a full validation pass between each, is a
 * bad experience for something that is usually a single paste gone wrong.
 */
export function scanForHiddenCharacters(text: string): UnicodeScanOutcome {
  const findings: UnicodeFinding[] = [];
  let line = 1;
  let column = 1;
  let offset = 0;

  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) break;

    if (character === '\n') {
      line += 1;
      column = 1;
      offset += character.length;
      continue;
    }

    // See the header: a leading BOM is an editor artifact, not a hiding place.
    const isLeadingBom = codePoint === 0xfeff && offset === 0;
    if (!isLeadingBom) {
      const rule = ruleFor(codePoint);
      if (rule !== undefined) {
        findings.push({
          codePoint,
          notation: notationFor(codePoint),
          name: rule.name,
          category: rule.category,
          offset,
          line,
          column,
        });
      }
    }

    offset += character.length;
    column += 1;
  }

  return findings.length === 0 ? { ok: true } : { ok: false, findings };
}

/**
 * Render findings as a refusal a reviewer can act on.
 *
 * Addressed to a human deciding whether to trust a plugin, so it leads with the
 * count and then locates each character precisely. `label` names the file.
 */
export function describeFindings(label: string, findings: readonly UnicodeFinding[]): string {
  const plural = findings.length === 1 ? 'character' : 'characters';
  const lines = findings.map(
    (finding) =>
      `  ${label}:${finding.line}:${finding.column} ${finding.notation} ` +
      `${finding.name} [${finding.category}]`,
  );
  return (
    `${label} contains ${findings.length} hidden or bidirectional ${plural}, ` +
    `which is a hard failure rather than a warning: text that a reviewer cannot ` +
    `see is text that was not reviewed.\n${lines.join('\n')}`
  );
}
