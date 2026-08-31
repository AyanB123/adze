import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHELL_FLAG,
  DEFAULT_SHELL_PROGRAM,
  resolveShellPrefix,
  SHELL_FLAG_ENV,
  SHELL_PROGRAM_ENV,
  shellOverrideAdvice,
} from '../src/shell.js';

describe('resolveShellPrefix', () => {
  it('defaults to the same prefix core uses', () => {
    const { prefix, overridden } = resolveShellPrefix({});
    expect(prefix).toEqual([DEFAULT_SHELL_PROGRAM, DEFAULT_SHELL_FLAG]);
    expect(overridden).toBe(false);
  });

  it('takes the program verbatim, spaces included', () => {
    // The whole reason this is two variables. Splitting a single command string on
    // whitespace would break on exactly the path the feature exists to support.
    const program = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const { prefix, overridden } = resolveShellPrefix({ [SHELL_PROGRAM_ENV]: program });
    expect(prefix).toEqual([program, DEFAULT_SHELL_FLAG]);
    expect(overridden).toBe(true);
  });

  it('allows the flag to be overridden on its own', () => {
    const { prefix, overridden } = resolveShellPrefix({ [SHELL_FLAG_ENV]: '-c' });
    expect(prefix).toEqual([DEFAULT_SHELL_PROGRAM, '-c']);
    expect(overridden).toBe(true);
  });

  it('overrides both when both are set', () => {
    const { prefix } = resolveShellPrefix({
      [SHELL_PROGRAM_ENV]: '/usr/local/bin/zsh',
      [SHELL_FLAG_ENV]: '-lc',
    });
    expect(prefix).toEqual(['/usr/local/bin/zsh', '-lc']);
  });

  it('treats an empty or whitespace value as unset', () => {
    // `ADZE_SHELL=` in a dotenv file is how someone clears a variable, not a request to
    // execute the empty string — which would fail with a spawn error naming nothing.
    for (const value of ['', '   ', '\t']) {
      const { prefix, overridden } = resolveShellPrefix({ [SHELL_PROGRAM_ENV]: value });
      expect(prefix).toEqual([DEFAULT_SHELL_PROGRAM, DEFAULT_SHELL_FLAG]);
      expect(overridden).toBe(false);
    }
  });

  it('trims surrounding whitespace from a real value', () => {
    const { prefix } = resolveShellPrefix({ [SHELL_PROGRAM_ENV]: '  /bin/bash  ' });
    expect(prefix).toEqual(['/bin/bash', DEFAULT_SHELL_FLAG]);
  });

  it('ignores unrelated variables', () => {
    const { overridden } = resolveShellPrefix({ SHELL: '/bin/zsh', PATH: '/usr/bin' });
    // `SHELL` is the user's interactive shell and says nothing about what can run
    // `-lc <string>`; reading it would silently change the agent's shell.
    expect(overridden).toBe(false);
  });
});

describe('shellOverrideAdvice', () => {
  it('names both variables, so the advice can be acted on', () => {
    // The reason this exists: doctor previously detected a broken shell and recommended
    // Git for Windows without any way to select it.
    const advice = shellOverrideAdvice();
    expect(advice).toContain(SHELL_PROGRAM_ENV);
    expect(advice).toContain(SHELL_FLAG_ENV);
    expect(advice).toContain('bash.exe');
  });
});
