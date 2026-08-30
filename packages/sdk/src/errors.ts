/**
 * The two errors this package throws.
 *
 * Two rather than one because they carry different instructions: an
 * {@link AdzeConfigError} means fix the configuration and try again, and an
 * {@link AdzeSessionError} means the call was made at the wrong time. A single
 * `AdzeError` would force every consumer to string-match to tell those apart.
 *
 * Nothing from `@adze/core` is ever allowed to escape as itself. Core's
 * `TurnConfigurationError` and its bare `Error`s are translated at the boundary,
 * because an error class is part of an API surface: a consumer who catches
 * `TurnConfigurationError` has taken a dependency on a core internal, and a rename
 * inside core would then break them.
 */

/** The configuration cannot be honoured. Raised before anything runs. */
export class AdzeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdzeConfigError';
  }
}

/** A client or session was used after disposal, or while busy. */
export class AdzeSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdzeSessionError';
  }
}
