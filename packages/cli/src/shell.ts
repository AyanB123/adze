/**
 * Where the `bash` tool's shell comes from.
 *
 * `@adze/core` gives the tool `['bash', '-lc']` on every platform, and resolves
 * `bash` on `PATH`. That is the right default and it has one common failure: on
 * Windows, `bash` on `PATH` is usually WSL's launcher, which exists whether or not a
 * healthy distribution sits behind it and exits non-zero for every command when one
 * does not. `adze doctor` detects that state and advises Git for Windows' bash as the
 * fix — advice nobody could act on, because there was no way to say which shell to
 * use.
 *
 * ## Why two variables rather than one command string
 *
 * Splitting a single `ADZE_SHELL="C:\Program Files\Git\bin\bash.exe -lc"` on
 * whitespace would break on exactly the path this feature exists to support. The
 * program is therefore taken verbatim and the flag is separate, so no quoting rule has
 * to be invented or remembered.
 *
 * ## Why an environment variable rather than a flag
 *
 * A broken shell is a property of the machine, not of one invocation. Someone who has
 * to set it wants it set once, and wants `doctor` to agree with `run` without being
 * passed the same argument twice.
 */

/** Program used when nothing overrides it. Mirrors `@adze/core`'s own default. */
export const DEFAULT_SHELL_PROGRAM = 'bash';

/** Flag used when nothing overrides it. `-lc` is what a login shell needs to take a string. */
export const DEFAULT_SHELL_FLAG = '-lc';

export const SHELL_PROGRAM_ENV = 'ADZE_SHELL';
export const SHELL_FLAG_ENV = 'ADZE_SHELL_FLAG';

export interface ShellPrefix {
  /** argv prefix to hand the `bash` tool. */
  readonly prefix: readonly [string, string];
  /** True when the environment asked for something other than the default. */
  readonly overridden: boolean;
}

/**
 * Resolve the shell argv prefix from the environment.
 *
 * Always returns a usable prefix, so callers never branch on absence. `overridden`
 * exists so a diagnostic can say *why* it is probing what it is probing — reporting a
 * configured shell as though it were the default would hide the one setting most
 * likely to be wrong.
 *
 * An empty or whitespace-only value is treated as unset rather than as a request to
 * run the empty string, because `ADZE_SHELL=` in a dotenv file is how someone clears
 * a variable.
 */
export function resolveShellPrefix(env: Readonly<Record<string, string | undefined>>): ShellPrefix {
  const program = trimmed(env[SHELL_PROGRAM_ENV]);
  const flag = trimmed(env[SHELL_FLAG_ENV]);
  return {
    prefix: [program ?? DEFAULT_SHELL_PROGRAM, flag ?? DEFAULT_SHELL_FLAG],
    overridden: program !== undefined || flag !== undefined,
  };
}

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.trim();
  return cleaned.length === 0 ? undefined : cleaned;
}

/** One line naming the variables, for a diagnostic that has just failed to run a shell. */
export function shellOverrideAdvice(): string {
  return (
    `Set ${SHELL_PROGRAM_ENV} to a working shell to override this — on Windows that is ` +
    `usually "C:\\Program Files\\Git\\bin\\bash.exe". ${SHELL_FLAG_ENV} overrides the ` +
    `flag, which defaults to ${DEFAULT_SHELL_FLAG}.`
  );
}
