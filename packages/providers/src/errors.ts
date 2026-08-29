/**
 * Errors this package raises.
 *
 * Two classes, and the distinction is what the user sees.
 *
 * {@link ProviderConfigurationError} is raised before any network call, for
 * something the user can fix right now: no API key, an unknown provider id, a
 * missing base URL. It carries a `hint` naming the exact environment variable or
 * config key, because "authentication failed" with a stack trace is the single most
 * common first experience of a coding agent and it is entirely avoidable.
 *
 * {@link ProviderRequestError} is raised after a request was attempted and failed
 * for good. It carries the classification the CLI needs in order to say something
 * true — an expired key and a rate limit need different advice — and its message has
 * already been through {@link redact}.
 *
 * Neither ever contains a stack trace in its message, and neither is constructed
 * from an unredacted provider error.
 */

/** What went wrong, at the granularity a surface renders differently. */
export type RequestFailureKind =
  | 'auth'
  | 'rate-limit'
  | 'quota'
  | 'not-found'
  | 'bad-request'
  | 'server'
  | 'network'
  | 'timeout'
  | 'unknown';

/**
 * A configuration problem, raised before a request.
 *
 * The `hint` is the point of the class. Without it a surface has to pattern-match on
 * message text to tell the user which variable to set, which is how "set your API
 * key" ends up naming the wrong one.
 */
export class ProviderConfigurationError extends Error {
  override readonly name = 'ProviderConfigurationError';
  /** One or more concrete next steps, in the order to try them. */
  readonly hints: readonly string[];
  /** Environment variables that would resolve it, when that is the fix. */
  readonly envVars: readonly string[];

  constructor(
    message: string,
    options: { readonly hints?: readonly string[]; readonly envVars?: readonly string[] } = {},
  ) {
    super(message);
    this.hints = options.hints ?? [];
    this.envVars = options.envVars ?? [];
  }
}

/** A request that was attempted and failed. Message already redacted. */
export class ProviderRequestError extends Error {
  override readonly name = 'ProviderRequestError';
  readonly kind: RequestFailureKind;
  readonly provider: string;
  readonly model: string;
  /** HTTP status when the failure came from a response. */
  readonly status: number | undefined;
  /** True when the SDK considered it worth retrying and retries ran out. */
  readonly retried: boolean;

  constructor(options: {
    readonly message: string;
    readonly kind: RequestFailureKind;
    readonly provider: string;
    readonly model: string;
    readonly status?: number | undefined;
    readonly retried?: boolean;
  }) {
    super(options.message);
    this.kind = options.kind;
    this.provider = options.provider;
    this.model = options.model;
    this.status = options.status;
    this.retried = options.retried ?? false;
  }
}

/**
 * Classify an HTTP status into something a surface can act on.
 *
 * 402 and 429 are separated because they need opposite advice: waiting fixes a rate
 * limit and never fixes an exhausted balance. Collapsing them into "try again later"
 * is advice that is wrong half the time.
 */
export function classifyStatus(status: number | undefined): RequestFailureKind {
  if (status === undefined) return 'unknown';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 404) return 'not-found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad-request';
  return 'unknown';
}

/**
 * What to tell the user for a given failure, keyed by classification.
 *
 * Lives here rather than in the CLI so every surface says the same thing. A user who
 * reads one message in the terminal and a different one in the editor cannot tell
 * whether they are looking at two problems.
 */
export function adviceFor(kind: RequestFailureKind, envVars: readonly string[]): readonly string[] {
  switch (kind) {
    case 'auth':
      return [
        `The provider rejected the credential. Check ${
          envVars.length > 0 ? envVars.join(' or ') : 'your configured API key'
        }.`,
        'A key that worked yesterday can be revoked, or scoped to a different project.',
      ];
    case 'quota':
      return [
        'The account has no remaining balance or credit. Waiting will not clear this.',
        'Add credit with the provider, then re-run.',
      ];
    case 'rate-limit':
      return [
        'Rate limited after the configured retries. Re-run, or lower concurrency.',
        'Adze already retried with backoff; a persistent 429 means the limit is below what this task needs.',
      ];
    case 'not-found':
      return [
        'The model id was not found. Check spelling against `adze models`.',
        'A dated snapshot can be retired; the undated alias usually still resolves.',
      ];
    case 'bad-request':
      return [
        'The provider rejected the request as malformed. This is usually an Adze bug — please report it.',
        'Include the model id and the failing step. Do not include your API key.',
      ];
    case 'server':
      return ['The provider reported a server-side failure. Re-running usually works.'];
    case 'network':
      return [
        'No route to the provider. Check connectivity, and any proxy or firewall.',
        'If you are pointing at a local server, confirm it is listening on the configured base URL.',
      ];
    case 'timeout':
      return ['The request timed out. Re-run, or raise the wall-clock budget.'];
    case 'unknown':
      return ['Re-run once. If it persists, please report it with the model id.'];
  }
}
