/**
 * Credential redaction.
 *
 * A provider error is the one place a secret reliably escapes. The AI SDK's
 * `APICallError` carries the request URL, the request body, and sometimes response
 * headers, and an SDK that helpfully includes an `Authorization` header in a
 * message has handed the key to every place that message goes: the terminal, a CI
 * log, a trajectory artifact published alongside a benchmark report, and — worst —
 * back into the model's context as a tool result.
 *
 * So nothing from a provider reaches a message without passing through here.
 *
 * Two mechanisms, and both are needed.
 *
 * **Exact-value redaction** is the reliable one. The gateway knows the key it was
 * configured with, so it can find that exact string no matter how it is framed. It
 * catches a key inside a JSON body, inside a URL query parameter, and inside a
 * header dump, without knowing anything about the vendor's key format.
 *
 * **Pattern redaction** is the backstop, for a key this process was never told
 * about: one baked into a `baseURL`, one belonging to a different provider that
 * appeared in a proxy's error body, one in a `Bearer` header from an upstream hop.
 * Patterns cannot be complete, which is exactly why they are second rather than
 * only.
 *
 * The redaction is one-way and lossy on purpose. A partially masked key — last four
 * characters shown — is a convenience that shortens a brute-force search, and there
 * is no debugging question that needs it.
 */

/** What replaces a redacted value. Fixed, so it is greppable in a log. */
export const REDACTED = '[redacted]';

/**
 * Key-shaped literals, as a backstop for values this process does not hold.
 *
 * Ordered longest-match-first within the alternation so a vendor prefix wins over
 * the generic bearer rule. Each is anchored on a prefix a vendor actually uses
 * rather than on entropy: an entropy heuristic redacts commit hashes, base64 file
 * contents, and UUIDs, and a diagnostic message with the useful parts blanked out
 * trains people to turn redaction off.
 */
const PATTERNS: readonly RegExp[] = [
  // Anthropic: sk-ant-api03-…, sk-ant-…
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  // OpenAI: sk-…, sk-proj-…, sk-svcacct-…, and organisation/project ids.
  /sk-(?:proj|svcacct|admin)?-?[A-Za-z0-9_-]{16,}/g,
  // OpenRouter and several gateways.
  /sk-or-v1-[A-Za-z0-9]{16,}/g,
  // Google AI Studio.
  /AIza[A-Za-z0-9_-]{16,}/g,
  // Anything presented as a bearer token, whatever its shape.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // `"api_key": "…"`, `x-api-key: …`, `apiKey=…` — the framing, not the value.
  /((?:api[-_]?key|authorization|x-api-key|access[-_]?token)["'\s]*[:=]["'\s]*)[A-Za-z0-9._~+/=-]{12,}/gi,
];

/** Values long enough that redacting them cannot blank out ordinary prose. */
const MIN_SECRET_LENGTH = 8;

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redact known secret values and key-shaped literals from arbitrary text.
 *
 * `secrets` are the values this process holds — configured API keys — and are
 * removed by exact match, which is the only complete method available. The match is
 * literal rather than a built regular expression: a key can legally contain regex
 * metacharacters, and {@link escapeForRegExp} exists for the URL-encoded case below
 * rather than for the plain one.
 *
 * Values shorter than {@link MIN_SECRET_LENGTH} are ignored: an empty or
 * one-character "key" is a misconfiguration, and substituting it everywhere would
 * replace every occurrence of that character in the message.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    out = out.split(secret).join(REDACTED);
    // A key that reached a URL query string arrives percent-encoded, so the literal
    // split above misses it. Both forms are removed, and the escape is why building
    // one pattern per secret is safe.
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) {
      out = out.replace(new RegExp(escapeForRegExp(encoded), 'g'), REDACTED);
    }
  }
  for (const pattern of PATTERNS) {
    // `$1` preserves the framing for the labelled-field pattern and is empty for
    // the others, so `api_key: X` stays readable as `api_key: [redacted]`.
    out = out.replace(pattern, (_match, prefix: string | undefined) =>
      prefix === undefined ? REDACTED : `${prefix}${REDACTED}`,
    );
  }
  return out;
}

/**
 * A redactor bound to a set of held secrets.
 *
 * Passed around rather than re-deriving the secret list at each call site, so a new
 * error path cannot forget to include the configured key.
 */
export type Redactor = (text: string) => string;

export function createRedactor(secrets: readonly string[]): Redactor {
  const held = secrets.filter((s) => s.length >= MIN_SECRET_LENGTH);
  return (text: string) => redact(text, held);
}
