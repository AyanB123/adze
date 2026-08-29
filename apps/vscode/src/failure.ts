/**
 * Turning a failure into something the user can act on.
 *
 * **No stack traces, and no silent no-ops.** The one error a new user is guaranteed
 * to hit is "no API key configured", and the difference between a two-second fix and
 * a search engine is whether the message names the environment variable.
 * `@adze/providers` already composes that advice — including a PowerShell and a bash
 * form — so this module's job is to surface it rather than to invent its own wording.
 * A message that differs between the CLI and the extension makes a user think they
 * have two problems.
 *
 * An unexpected error prints its message, never its stack, with a pointer to the
 * issue tracker. A stack trace is a request for the user to debug Adze.
 */

import { ProviderConfigurationError, ProviderRequestError } from '@adze/providers';

export type FailureKind = 'configuration' | 'request' | 'unexpected';

export interface FailureNotice {
  readonly kind: FailureKind;
  /** One line for a notification title. */
  readonly message: string;
  /** Actionable lines: the variable to set, the command to run. Possibly empty. */
  readonly hints: readonly string[];
}

const ISSUE_TRACKER = 'https://github.com/AyanB123/adze/issues';

export function describeFailure(error: unknown): FailureNotice {
  if (error instanceof ProviderConfigurationError) {
    return { kind: 'configuration', message: error.message, hints: [...error.hints] };
  }

  if (error instanceof ProviderRequestError) {
    // Already carries its own advice, composed in the gateway so every surface says
    // the same thing about the same failure, and already redacted of credentials.
    return { kind: 'request', message: 'The model request failed.', hints: [error.message] };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: 'unexpected',
    message,
    hints: [
      'This is unexpected. Please report it with what you were doing:',
      ISSUE_TRACKER,
      'Do not include your API key.',
    ],
  };
}

/** Notification text: the message, then the hints, one per line. */
export function formatNotice(notice: FailureNotice): string {
  return notice.hints.length === 0
    ? notice.message
    : `${notice.message}\n\n${notice.hints.join('\n')}`;
}
