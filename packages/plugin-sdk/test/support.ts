/**
 * Shared test fixtures.
 *
 * Everything here is in-memory. No test in this package touches the network, spawns a
 * process, or needs a model key — the two tests that read from disk read the example
 * plugins under `plugins/`, which are committed.
 */

import type { JsonValue } from '@adze/protocol';
import type { ContextFileSystem } from '../src/context.js';
import type { PluginFileSystem } from '../src/loader.js';
import type { GuestModule, GuestRuntime } from '../src/wasm.js';

export type GuestHandler = (
  functionName: string,
  input: JsonValue,
) => JsonValue | Promise<JsonValue>;

/** A guest whose behaviour a test writes directly. */
export function fakeGuest(
  handler: GuestHandler,
  runtime: 'wasm' | 'js' | 'native' = 'js',
): GuestModule {
  return { runtime, invoke: async (functionName, input) => await handler(functionName, input) };
}

/** A guest that never answers, for the timeout path. */
export function hangingGuest(): GuestModule {
  return { runtime: 'js', invoke: () => new Promise<JsonValue>(() => {}) };
}

/** A runtime that hands back one prepared guest for any module path. */
export function fixedRuntime(
  kind: 'wasm' | 'js' | 'native',
  guest: GuestModule,
  enforcesMemoryLimit = false,
): GuestRuntime {
  return {
    kind,
    enforcesMemoryLimit,
    load: () => Promise.resolve({ ok: true, module: guest }),
  };
}

export function memoryPluginFiles(files: Readonly<Record<string, string>>): PluginFileSystem {
  const normalized = new Map(Object.entries(files).map(([key, value]) => [norm(key), value]));
  return {
    readFile: (path) => {
      const found = normalized.get(norm(path));
      if (found === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
      return Promise.resolve(found);
    },
    exists: (path) => Promise.resolve(normalized.has(norm(path))),
  };
}

export function memoryContextFiles(files: Readonly<Record<string, string>>): ContextFileSystem {
  return {
    list: () => Promise.resolve(Object.keys(files)),
    read: (path) => {
      const found = files[path];
      if (found === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
      return Promise.resolve(found);
    },
  };
}

function norm(path: string): string {
  return path.replace(/\\/g, '/');
}

/** A valid manifest, with fields overridden per test. */
export function manifestText(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    id: 'acme.example',
    version: '1.0.0',
    displayName: 'Example',
    description: 'An example plugin.',
    license: 'Apache-2.0',
    repository: 'https://github.com/acme/example',
    engines: { adze: '>=0.0.1 <1.0.0' },
    ...overrides,
  });
}

/** Absolute-looking root that works on both platforms under `node:path`. */
export const ROOT = process.platform === 'win32' ? 'C:/plugins/example' : '/plugins/example';
