/**
 * Turning a failure into something the user can act on.
 *
 * Shared by `run`, `chat`, and `models`, because the one error a new user is guaranteed to
 * hit — no API key — must read identically wherever they hit it. A message that differs
 * between two commands makes a user think they have two problems.
 *
 * **No stack traces.** A `ProviderConfigurationError` naming `ANTHROPIC_API_KEY` and a
 * PowerShell line to set it is the difference between a two-second fix and a search
 * engine. An unexpected error still prints its message rather than its stack, with a
 * pointer to the issue tracker, because a stack trace is a request for the user to debug
 * Adze.
 */

import { ProviderConfigurationError, ProviderRequestError } from '@adze/providers';
import { EXIT, type ExitCode, type Io, type Style } from '../output.js';
import { UsageError } from './flags.js';

export interface FailureRender {
  readonly code: ExitCode;
}

/**
 * Print a failure and choose an exit code.
 *
 * A configuration problem is a **usage** error (2), not a failure (1), because the
 * invocation was wrong rather than the work: a script can then tell "fix your setup" from
 * "the agent could not finish the task", which is the whole reason the codes are distinct.
 */
export function renderFailure(error: unknown, io: Io, style: Style): FailureRender {
  if (error instanceof UsageError) {
    io.err(`${style.bad('adze:')} ${error.message}\n`);
    for (const hint of error.hints) io.err(`  ${style.dim(hint)}\n`);
    return { code: EXIT.Usage };
  }

  if (error instanceof ProviderConfigurationError) {
    io.err(`${style.bad('adze:')} ${error.message}\n`);
    if (error.hints.length > 0) io.err('\n');
    for (const hint of error.hints) io.err(`  ${hint}\n`);
    io.err(`\n  ${style.dim('`adze doctor` reports what is configured.')}\n`);
    return { code: EXIT.Usage };
  }

  if (error instanceof ProviderRequestError) {
    // Already carries its own advice, composed in the gateway so every surface says the
    // same thing about the same failure. Already redacted.
    io.err(`${style.bad('adze:')} the model request failed.\n\n${error.message}\n`);
    return { code: EXIT.Failure };
  }

  const message = error instanceof Error ? error.message : String(error);
  io.err(`${style.bad('adze:')} ${message}\n`);
  io.err(
    `\n  ${style.dim('This is unexpected. Please report it with the command you ran:')}\n` +
      `  ${style.dim('https://github.com/AyanB123/adze/issues')}\n` +
      `  ${style.dim('Do not include your API key.')}\n`,
  );
  return { code: EXIT.Failure };
}
