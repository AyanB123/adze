/**
 * Keeping configured credentials out of everything we emit.
 *
 * An MCP server's `env` block is where API keys live. Those values pass through
 * this package on their way to a child process, and this package produces
 * diagnostics that reach a terminal, a CI log, and — because a trajectory is
 * published alongside a benchmark report — a public artifact. So a credential
 * appearing in a message here is a credential published.
 *
 * The approach is **exact-value redaction against the values this process was
 * actually given**, not a pattern hunt. We know the secrets; matching them exactly
 * cannot produce a false negative on the values that matter, and it cannot destroy
 * unrelated text the way an entropy heuristic does. A message with the useful parts
 * blanked out is how people learn to turn redaction off.
 *
 * Redaction is one-way. No masked prefix or suffix is kept: a partial reveal
 * shortens a brute-force search and answers no debugging question that the
 * variable's *name* does not answer better.
 */

/** What replaces a matched secret. Fixed, so it is greppable in a report. */
const REDACTED = '[redacted]';

/**
 * Values shorter than this are never treated as secrets.
 *
 * An `env` block legitimately contains `"1"`, `"true"`, and `"debug"`. Redacting a
 * one-character value would replace every occurrence of that character in every
 * message, which corrupts the diagnostic while protecting nothing — the value is
 * not recoverable-by-guessing anyway at that length.
 */
const MIN_SECRET_LENGTH = 6;

/**
 * The secret values a connection holds, ready to strip from any text.
 *
 * Built once per server from `env` and `headers` rather than consulted per call, so
 * every message this package emits for that server goes through the same set.
 */
export class SecretRegistry {
  private readonly values: readonly string[];

  constructor(sources: readonly (Readonly<Record<string, string>> | undefined)[]) {
    const collected = new Set<string>();
    for (const source of sources) {
      if (source === undefined) continue;
      for (const value of Object.values(source)) {
        if (value.length >= MIN_SECRET_LENGTH) collected.add(value);
      }
    }
    // Longest first: a short secret that happens to be a substring of a longer one
    // would otherwise cut the longer one in half and leave the tail exposed.
    this.values = [...collected].sort((a, b) => b.length - a.length);
  }

  get size(): number {
    return this.values.length;
  }

  /**
   * Remove every known secret from `text`.
   *
   * Both the literal value and its percent-encoded form are removed. The encoded
   * form is not paranoia: a Streamable HTTP endpoint that echoes the request URL
   * back in an error returns the token percent-encoded, and a literal-only match
   * misses it entirely.
   */
  redact(text: string): string {
    let out = text;
    for (const value of this.values) {
      out = replaceAll(out, value, REDACTED);
      const encoded = encodeURIComponent(value);
      if (encoded !== value) out = replaceAll(out, encoded, REDACTED);
    }
    return out;
  }
}

function replaceAll(haystack: string, needle: string, replacement: string): string {
  if (needle.length === 0) return haystack;
  return haystack.split(needle).join(replacement);
}

/**
 * Describe an environment block by its keys alone.
 *
 * What an operator needs when a server fails to authenticate is *which* variable
 * was supplied, because the common mistake is exporting one of two accepted names.
 * The value answers nothing and cannot be un-published.
 */
export function describeEnvKeys(env: Readonly<Record<string, string>> | undefined): string {
  const keys = Object.keys(env ?? {});
  if (keys.length === 0) return '(none)';
  return keys.sort().join(', ');
}
