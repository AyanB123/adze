/**
 * Shared test fixtures.
 *
 * Not a `.test.ts` file, so vitest does not collect it as a suite.
 *
 * The fake host exists so that capability detection and broker selection are tested
 * for every platform on every platform. A test that only exercised the Windows branch
 * on Windows would be reviewed by whoever happens to develop there, which for a
 * cross-platform sandbox is the wrong review population.
 */

import type { CommandRequest, Containment, SandboxMode } from '../src/types.js';
import type { HostProbe } from '../src/which.js';

export interface FakeHost {
  readonly platform: string;
  /** Paths that exist and are executable. */
  readonly executables?: readonly string[];
  /** File contents keyed by path, for `/proc` sysctl reads. */
  readonly files?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
}

export function fakeProbe(host: FakeHost): HostProbe {
  const executables = new Set(host.executables ?? []);
  const files = host.files ?? {};
  return {
    platform: host.platform,
    env:
      host.env ??
      (host.platform === 'win32' ? { PATH: 'C:\\Windows\\System32' } : { PATH: '/usr/bin:/bin' }),
    async isExecutable(path: string): Promise<boolean> {
      return await Promise.resolve(executables.has(path));
    },
    async readText(path: string): Promise<string | undefined> {
      return await Promise.resolve(files[path]);
    },
  };
}

export function containmentFor(
  mode: SandboxMode,
  overrides: Partial<Containment> = {},
): Containment {
  return { mode, writableRoots: ['/repo'], allowedNetworkHosts: [], ...overrides };
}

export function requestFor(
  command: readonly string[],
  containment: Containment,
  cwd = '/repo',
): CommandRequest {
  return {
    command,
    cwd,
    env: {},
    timeoutMs: 1_000,
    signal: new AbortController().signal,
    containment,
  };
}
