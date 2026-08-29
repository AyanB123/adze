// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: a hand-written character scanner has one branch per character class per context, so its branch count is inherent. Decomposing it into helpers that share a mutable cursor makes correctness harder to verify, not easier — and this code decides whether an edit may touch disk. test/validate.test.ts is the real safety net.

/**
 * Parse validation: the check that turns "the agent corrupted my file" into
 * "the agent refused an edit".
 *
 * Two levels, and it degrades honestly:
 *
 *   `tree-sitter`  a real parse. Requires grammar WASM files to be present.
 *   `structural`   delimiter balance tracked through string and comment states,
 *                  plus indentation coherence for indentation-sensitive
 *                  languages. Always available.
 *
 * The structural fallback exists because the safety property has to hold on a
 * fresh clone, not only after someone downloads grammars. It catches the large
 * majority of real corruption: truncated blocks, unterminated strings,
 * mismatched brackets, and lost indentation.
 */

import type { ValidationResult } from './types.js';

type Family = 'c-like' | 'python' | 'json' | 'unknown';

interface LanguageSpec {
  readonly family: Family;
  readonly lineComments: readonly string[];
  readonly blockComment?: readonly [string, string];
  /** Quote characters that start a single-line string. */
  readonly quotes: readonly string[];
  /** Quote sequences that start a multi-line string. Checked before `quotes`. */
  readonly multilineQuotes: readonly string[];
  /** Backtick template literals with `${}` interpolation. */
  readonly templates: boolean;
  readonly checkBrackets: boolean;
  /** Enforce that a block-opening line is followed by deeper indentation. */
  readonly checkIndentation: boolean;
}

const C_LIKE: LanguageSpec = {
  family: 'c-like',
  lineComments: ['//'],
  blockComment: ['/*', '*/'],
  quotes: ['"', "'"],
  multilineQuotes: [],
  templates: true,
  checkBrackets: true,
  checkIndentation: false,
};

const PYTHON: LanguageSpec = {
  family: 'python',
  lineComments: ['#'],
  quotes: ['"', "'"],
  multilineQuotes: ['"""', "'''"],
  templates: false,
  checkBrackets: true,
  checkIndentation: true,
};

const JSON_SPEC: LanguageSpec = {
  family: 'json',
  lineComments: [],
  quotes: ['"'],
  multilineQuotes: [],
  templates: false,
  checkBrackets: true,
  checkIndentation: false,
};

const SHELL: LanguageSpec = {
  family: 'c-like',
  lineComments: ['#'],
  quotes: ['"', "'"],
  multilineQuotes: [],
  templates: false,
  // Shell uses braces for expansion and `case ... esac` for blocks, so bracket
  // balance produces false positives. String termination is still worth checking.
  checkBrackets: false,
  checkIndentation: false,
};

const BY_EXTENSION: Readonly<Record<string, LanguageSpec>> = {
  ts: C_LIKE,
  tsx: C_LIKE,
  mts: C_LIKE,
  cts: C_LIKE,
  js: C_LIKE,
  jsx: C_LIKE,
  mjs: C_LIKE,
  cjs: C_LIKE,
  java: C_LIKE,
  c: C_LIKE,
  h: C_LIKE,
  cc: C_LIKE,
  cpp: C_LIKE,
  hpp: C_LIKE,
  cs: C_LIKE,
  go: C_LIKE,
  rs: C_LIKE,
  swift: C_LIKE,
  kt: C_LIKE,
  kts: C_LIKE,
  scala: C_LIKE,
  php: C_LIKE,
  dart: C_LIKE,
  py: PYTHON,
  pyi: PYTHON,
  json: JSON_SPEC,
  jsonc: C_LIKE,
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
};

const UNKNOWN: LanguageSpec = {
  family: 'unknown',
  lineComments: [],
  quotes: [],
  multilineQuotes: [],
  templates: false,
  checkBrackets: false,
  checkIndentation: false,
};

export function detectLanguage(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

function specFor(language: string): LanguageSpec {
  return BY_EXTENSION[language] ?? UNKNOWN;
}

const OPENERS = '([{';
const CLOSERS = ')]}';
const PAIR: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

type Ctx =
  | { readonly kind: 'code' }
  | { readonly kind: 'string'; readonly delim: string; readonly multiline: boolean }
  | { readonly kind: 'template' }
  /** Inside `${ ... }` within a template literal. */
  | { readonly kind: 'interp' };

interface Bracket {
  readonly char: string;
  readonly line: number;
  /** True for the `{` that opened a `${` interpolation in a template literal. */
  readonly opensInterp?: boolean;
}

/**
 * Structural validation. Deliberately conservative: it reports a problem only
 * when the text is definitely malformed, because a false positive here blocks a
 * legitimate edit.
 */
export function validateStructure(content: string, language: string): ValidationResult {
  const spec = specFor(language);
  if (spec.family === 'unknown') {
    return { ok: true, validator: 'none', message: `no validator for '${language || 'unknown'}'` };
  }

  const stack: Ctx[] = [{ kind: 'code' }];
  const brackets: Bracket[] = [];
  let line = 1;
  let i = 0;

  const inCode = (): boolean => {
    const top = stack[stack.length - 1];
    return top !== undefined && (top.kind === 'code' || top.kind === 'interp');
  };

  while (i < content.length) {
    const ch = content[i];
    if (ch === undefined) break;
    if (ch === '\n') {
      line++;
      const top = stack[stack.length - 1];
      // An unterminated single-line string is malformed.
      if (top !== undefined && top.kind === 'string' && !top.multiline) {
        return { ok: false, validator: 'structural', message: `unterminated string literal`, line };
      }
      i++;
      continue;
    }

    const top = stack[stack.length - 1];
    if (top === undefined) break;

    // --- inside a string or template ---
    if (top.kind === 'string' || top.kind === 'template') {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (top.kind === 'template' && ch === '$' && content[i + 1] === '{') {
        stack.push({ kind: 'interp' });
        brackets.push({ char: '{', line, opensInterp: true });
        i += 2;
        continue;
      }
      if (top.kind === 'template') {
        if (ch === '`') {
          stack.pop();
          i++;
          continue;
        }
        i++;
        continue;
      }
      if (top.multiline) {
        if (content.startsWith(top.delim, i)) {
          stack.pop();
          i += top.delim.length;
          continue;
        }
        i++;
        continue;
      }
      if (ch === top.delim) {
        stack.pop();
        i++;
        continue;
      }
      i++;
      continue;
    }

    // --- code context ---
    if (spec.blockComment) {
      const [open, close] = spec.blockComment;
      if (content.startsWith(open, i)) {
        const endIdx = content.indexOf(close, i + open.length);
        if (endIdx === -1) {
          return {
            ok: false,
            validator: 'structural',
            message: 'unterminated block comment',
            line,
          };
        }
        for (let k = i; k < endIdx; k++) if (content[k] === '\n') line++;
        i = endIdx + close.length;
        continue;
      }
    }

    let isLineComment = false;
    for (const lc of spec.lineComments) {
      if (content.startsWith(lc, i)) {
        const nl = content.indexOf('\n', i);
        i = nl === -1 ? content.length : nl;
        isLineComment = true;
        break;
      }
    }
    if (isLineComment) continue;

    let openedMultiline = false;
    for (const mq of spec.multilineQuotes) {
      if (content.startsWith(mq, i)) {
        stack.push({ kind: 'string', delim: mq, multiline: true });
        i += mq.length;
        openedMultiline = true;
        break;
      }
    }
    if (openedMultiline) continue;

    if (spec.templates && ch === '`') {
      stack.push({ kind: 'template' });
      i++;
      continue;
    }

    if (spec.quotes.includes(ch)) {
      stack.push({ kind: 'string', delim: ch, multiline: false });
      i++;
      continue;
    }

    if (spec.checkBrackets && inCode()) {
      if (OPENERS.includes(ch)) {
        brackets.push({ char: ch, line });
        i++;
        continue;
      }
      if (CLOSERS.includes(ch)) {
        const expected = PAIR[ch];
        const last = brackets.pop();
        if (last === undefined) {
          return { ok: false, validator: 'structural', message: `unmatched closing '${ch}'`, line };
        }
        if (last.char !== expected) {
          return {
            ok: false,
            validator: 'structural',
            message: `mismatched bracket: '${last.char}' opened at line ${last.line}, closed by '${ch}'`,
            line,
          };
        }
        // Only the brace that actually opened the `${` returns us to the
        // template. Checking the context alone would pop on the first inner `}`,
        // breaking `${ { k: 1 }.k }`.
        if (last.opensInterp === true) stack.pop();
        i++;
        continue;
      }
    }

    i++;
  }

  const finalTop = stack[stack.length - 1];
  if (finalTop !== undefined && finalTop.kind !== 'code') {
    const what = finalTop.kind === 'template' ? 'template literal' : 'string literal';
    return {
      ok: false,
      validator: 'structural',
      message: `unterminated ${what} at end of file`,
      line,
    };
  }
  if (spec.checkBrackets && brackets.length > 0) {
    const first = brackets[0];
    return {
      ok: false,
      validator: 'structural',
      message: `unclosed '${first?.char ?? '?'}' opened at line ${first?.line ?? 0}`,
      ...(first ? { line: first.line } : {}),
    };
  }

  if (spec.checkIndentation) {
    const indentIssue = checkIndentationCoherence(content);
    if (indentIssue) return indentIssue;
  }

  return { ok: true, validator: 'structural' };
}

/**
 * For indentation-sensitive languages, a line ending in `:` must be followed by
 * a more-indented line. A dropped body is the classic corruption an edit
 * introduces, and braces languages have no equivalent signal.
 */
function checkIndentationCoherence(content: string): ValidationResult | undefined {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const stripped = raw.replace(/#.*$/, '').trimEnd();
    if (!stripped.endsWith(':')) continue;

    const indent = (/^[ \t]*/.exec(raw)?.[0] ?? '').length;
    let next: string | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const cand = lines[j];
      if (cand === undefined) continue;
      if (cand.trim().length === 0) continue;
      next = cand;
      break;
    }
    // End of file after a block opener is malformed; so is a non-deeper line.
    if (next === undefined) {
      return {
        ok: false,
        validator: 'structural',
        message: 'block opener at end of file has no body',
        line: i + 1,
      };
    }
    const nextIndent = (/^[ \t]*/.exec(next)?.[0] ?? '').length;
    if (nextIndent <= indent) {
      return {
        ok: false,
        validator: 'structural',
        message: `block opened at line ${i + 1} has no indented body`,
        line: i + 1,
      };
    }
  }
  return undefined;
}

/**
 * Validate content, preferring a real parse when grammars are available.
 *
 * The tree-sitter path is wired in a follow-up (M1); until then this returns the
 * structural result, and `ValidationResult.validator` tells callers and
 * benchmark reports which level actually ran. We report the level rather than
 * implying a parse we did not perform.
 */
export function validate(content: string, language: string): ValidationResult {
  return validateStructure(content, language);
}
