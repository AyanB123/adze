/**
 * Minimal JSONC handling for `.adze/config.jsonc`.
 *
 * The file allows `//` line comments and block comments; everything else is
 * strict JSON. Comments are stripped before `JSON.parse` so the parser
 * dependency stays zero and a trailing comma remains an error rather than a
 * dialect — the task scope is comments only, and silently accepting a second
 * dialect would make two files that look alike parse differently.
 *
 * Stripping is string-aware: `//` inside `"https://..."` is data, not a comment.
 * Only double-quoted strings are recognised, because the payload is JSON. Block
 * comments preserve their newlines so a syntax error after stripping still points
 * at the right line.
 */

interface Scanner {
  readonly text: string;
  index: number;
  out: string;
}

function at(scanner: Scanner, offset = 0): string | undefined {
  return scanner.text[scanner.index + offset];
}

/** Copy a double-quoted string verbatim, honouring backslash escapes. */
function copyString(scanner: Scanner): void {
  let escaped = false;
  for (;;) {
    const char = at(scanner);
    if (char === undefined) return;
    scanner.out += char;
    scanner.index += 1;
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '"') {
      return;
    }
  }
}

/** Skip a `//` comment up to (not including) the newline. */
function skipLineComment(scanner: Scanner): void {
  scanner.index += 2;
  while (at(scanner) !== undefined && at(scanner) !== '\n') scanner.index += 1;
}

/** Skip a block comment, preserving newlines for error positions. */
function skipBlockComment(scanner: Scanner): void {
  scanner.index += 2;
  while (at(scanner) !== undefined && !(at(scanner) === '*' && at(scanner, 1) === '/')) {
    if (at(scanner) === '\n') scanner.out += '\n';
    scanner.index += 1;
  }
  scanner.index += 2;
}

/** Remove comments without touching string contents. Never throws. */
export function stripJsoncComments(text: string): string {
  const scanner: Scanner = { text, index: 0, out: '' };
  while (at(scanner) !== undefined) {
    const char = at(scanner);
    if (char === '"') {
      scanner.out += char;
      scanner.index += 1;
      copyString(scanner);
    } else if (char === '/' && at(scanner, 1) === '/') {
      skipLineComment(scanner);
    } else if (char === '/' && at(scanner, 1) === '*') {
      skipBlockComment(scanner);
    } else if (char !== undefined) {
      scanner.out += char;
      scanner.index += 1;
    }
  }
  return scanner.out;
}

/** Parse JSONC: strip comments, then strict `JSON.parse`. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsoncComments(text)) as unknown;
}
