/**
 * Environment scrubbing.
 *
 * Mirrors `scrubEnvironment` in `@adze/core`'s broker rather than importing it, for
 * the dependency reason given in `types.ts`. The rule is duplicated deliberately and
 * the wording of that rule matters more than the code:
 *
 * **This is a mitigation, not a boundary.** An environment variable is one of many
 * ways a subprocess reaches a secret — a credential file, a keychain, an agent
 * socket, an inherited file descriptor — and only OS-level containment closes the
 * rest. Removing credential-shaped names lowers the cost of the most common
 * accident, which is a model-authored command echoing the environment into a log
 * that gets pasted into an issue. It stops nothing determined.
 */

/**
 * Names that look like credentials.
 *
 * Word-boundary anchored on `_` rather than substring matched, so `KEYCLOAK_URL`
 * and `MONKEY_PATCH` survive while `API_KEY`, `KEY`, and `AWS_SECRET_ACCESS_KEY`
 * do not. A substring match would strip enough harmless variables to make the
 * feature something users turn off, and a feature that is off protects nothing.
 */
const CREDENTIAL_PATTERN = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)(?:_|$)/i;

export interface ScrubOptions {
  /** Names to pass through even though they look like credentials. */
  readonly allow?: readonly string[];
  /** Additional names to remove. */
  readonly deny?: readonly string[];
}

/**
 * Build a subprocess environment with credential-shaped names removed.
 *
 * `deny` beats `allow`. When a caller has said both things about one name, the
 * restrictive reading is the safe one, and it is also the one that makes a
 * copy-pasted config with an overlap fail closed.
 */
export function scrubEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  options: ScrubOptions = {},
): Record<string, string> {
  const allow = new Set(options.allow ?? []);
  const deny = new Set(options.deny ?? []);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (deny.has(name)) continue;
    if (!allow.has(name) && CREDENTIAL_PATTERN.test(name)) continue;
    out[name] = value;
  }
  return out;
}

/** True when the name would be scrubbed. Exported so a surface can explain itself. */
export function looksLikeCredential(name: string): boolean {
  return CREDENTIAL_PATTERN.test(name);
}
