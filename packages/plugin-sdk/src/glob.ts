/**
 * Glob matching for declarative context providers.
 *
 * `@adze/retrieval` already depends on `picomatch` and does this better, but
 * `@adze/plugin-sdk` may not import a sibling service package — that rule is what
 * keeps them individually swappable — and adding a second copy of the dependency to
 * the package that decides whether third-party code loads is a worse trade than
 * eighty lines of regex construction.
 *
 * Supported, matching the subset the spec's examples use:
 *
 * - `*` — any run of characters except `/`
 * - `**` — any run including `/`; as a whole path segment it also matches zero
 *   segments, so `docs/**\/*.md` matches `docs/a.md` as well as `docs/adr/a.md`
 * - `?` — exactly one character except `/`
 * - `[abc]`, `[a-z]`, `[!abc]` — character classes
 * - `{a,b}` — alternation
 *
 * Paths are compared with `/` separators regardless of platform, so a manifest
 * written on Linux behaves identically on Windows. That is not cosmetic: a plugin
 * whose provider silently matches nothing on one OS looks like a plugin that does
 * nothing.
 */

export type GlobOutcome =
  | { readonly ok: true; readonly matcher: (path: string) => boolean }
  | { readonly ok: false; readonly message: string };

/** Normalize to `/` separators and strip a leading `./`. */
export function toPosix(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Compile one pattern.
 *
 * Returns an outcome rather than throwing so a bad pattern in a manifest becomes a
 * load diagnostic naming the pattern, instead of an exception during a turn.
 */
export function compileGlob(pattern: string): GlobOutcome {
  const source = toPosix(pattern);
  if (source.length === 0) return { ok: false, message: 'an empty pattern matches nothing.' };

  let regex = '';
  let index = 0;
  let braceDepth = 0;

  while (index < source.length) {
    const token = translateToken(source, index, braceDepth, pattern);
    if (!token.ok) return { ok: false, message: token.message };
    regex += token.regex;
    index = token.next;
    braceDepth = token.braceDepth;
  }

  if (braceDepth > 0) {
    return { ok: false, message: `'${pattern}' has an unclosed brace group.` };
  }

  return compileAnchored(regex, pattern);
}

type TokenOutcome =
  | {
      readonly ok: true;
      readonly regex: string;
      readonly next: number;
      readonly braceDepth: number;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Translate the token starting at `index`.
 *
 * `braceDepth` is threaded through rather than closed over so the translation of one
 * token is a pure function of its inputs — `{` and `}` are the only tokens whose
 * meaning depends on what came before, and `,` is the only one that reads the depth.
 */
function translateToken(
  source: string,
  index: number,
  braceDepth: number,
  pattern: string,
): TokenOutcome {
  const character = source[index];
  // The loop bound guarantees a character; `noUncheckedIndexedAccess` does not know it.
  if (character === undefined) return { ok: true, regex: '', next: source.length, braceDepth };

  switch (character) {
    case '*': {
      const star = translateStar(source, index);
      return { ok: true, regex: star.regex, next: star.next, braceDepth };
    }
    case '?':
      return { ok: true, regex: '[^/]', next: index + 1, braceDepth };
    case '[':
      return translateClass(source, index, pattern, braceDepth);
    case '{':
      return { ok: true, regex: '(?:', next: index + 1, braceDepth: braceDepth + 1 };
    case '}':
      if (braceDepth === 0) {
        return { ok: false, message: `'${pattern}' closes a brace group that was never opened.` };
      }
      return { ok: true, regex: ')', next: index + 1, braceDepth: braceDepth - 1 };
    case ',':
      return { ok: true, regex: braceDepth > 0 ? '|' : ',', next: index + 1, braceDepth };
    default:
      return {
        ok: true,
        regex: character.replace(/[.+^$()|\\\-\]]/g, '\\$&'),
        next: index + 1,
        braceDepth,
      };
  }
}

function translateStar(
  source: string,
  index: number,
): { readonly regex: string; readonly next: number } {
  if (source[index + 1] !== '*') return { regex: '[^/]*', next: index + 1 };

  const precededBySlash = index === 0 || source[index - 1] === '/';
  const followedBySlash = source[index + 2] === '/';
  // `a/**/b` must also match `a/b`. Consuming the trailing slash here is what makes
  // the zero-segment case work.
  if (precededBySlash && followedBySlash) return { regex: '(?:[^/]+/)*', next: index + 3 };
  return { regex: '.*', next: index + 2 };
}

function translateClass(
  source: string,
  index: number,
  pattern: string,
  braceDepth: number,
): TokenOutcome {
  const close = source.indexOf(']', index + 1);
  if (close < 0) {
    return { ok: false, message: `'${pattern}' has an unclosed character class.` };
  }
  let body = source.slice(index + 1, close);
  if (body.length === 0) {
    return { ok: false, message: `'${pattern}' has an empty character class.` };
  }
  if (body.startsWith('!') || body.startsWith('^')) body = `^${body.slice(1)}`;
  return {
    ok: true,
    regex: `[${body.replace(/\\/g, '\\\\')}]`,
    next: close + 1,
    braceDepth,
  };
}

function compileAnchored(regex: string, pattern: string): GlobOutcome {
  try {
    const compiled = new RegExp(`^${regex}$`);
    return { ok: true, matcher: (path: string) => compiled.test(toPosix(path)) };
  } catch (error) {
    return {
      ok: false,
      message: `'${pattern}' could not be compiled: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export type GlobSetOutcome =
  | { readonly ok: true; readonly matches: (path: string) => boolean }
  | { readonly ok: false; readonly messages: readonly string[] };

/** Compile several patterns into one OR matcher. Every bad pattern is reported. */
export function compileGlobSet(patterns: readonly string[]): GlobSetOutcome {
  const matchers: ((path: string) => boolean)[] = [];
  const messages: string[] = [];

  for (const pattern of patterns) {
    const compiled = compileGlob(pattern);
    if (compiled.ok) matchers.push(compiled.matcher);
    else messages.push(compiled.message);
  }

  if (messages.length > 0) return { ok: false, messages };
  return { ok: true, matches: (path) => matchers.some((matcher) => matcher(path)) };
}
