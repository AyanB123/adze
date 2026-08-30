/**
 * The guest-module host: how procedural plugin code is loaded and called.
 *
 * ## What is real and what is a seam
 *
 * This file defines the **calling convention** and ships **one working runtime**.
 * Read the two claims separately, because conflating them is exactly the kind of
 * overstatement this repo's honesty rules exist to prevent:
 *
 * - **Real.** {@link jsModuleRuntime} loads a local ES module and calls it. It is
 *   used by first-party plugins and by every test in this package. Its timeout is
 *   enforced by the caller and works.
 * - **A seam.** `wasm32-wasip2` is *not* implemented. {@link unavailableWasmRuntime}
 *   is what a host gets by default, and it **fails the load** with a message saying
 *   so. It does not silently skip the module, because a policy hook that quietly
 *   never runs is worse than a plugin that refuses to install: the first looks like
 *   a working policy and is not.
 *
 * A component-model runtime needs either a native addon or a multi-megabyte WASM
 * interpreter, and this repo prefers WASM over native addons precisely to avoid
 * rebuilding across Electron ABI × OS × arch. Landing that choice is its own
 * decision with its own ADR, so the interface is here and the runtime is not.
 *
 * ## The calling convention, stated so a runtime can be dropped in
 *
 * One entry point per call, JSON in and JSON out:
 *
 * 1. The host serializes the event payload as UTF-8 JSON.
 * 2. The guest exports `invoke(name: string, input: string) -> string`, where
 *    `input` and the return value are JSON. A component-model implementation maps
 *    this onto a WIT interface with `list<u8>` in and out; the JSON boundary is
 *    deliberate so that adding a field to a payload is not an ABI break.
 * 3. The guest returns JSON matching the event's result shape. Anything else is a
 *    hook error, which is *not* the same as a denial — see `hooks.ts`.
 * 4. The host imposes {@link GuestLimits}. A guest exceeding its wall clock is
 *    abandoned, not killed cooperatively, so a guest cannot decline to stop.
 *
 * ## What the JS path cannot enforce, said plainly
 *
 * `maxMemoryBytes` is meaningless for an in-process ES module: a JavaScript guest
 * shares the engine's heap and there is no boundary to meter. {@link GuestRuntime}
 * therefore declares {@link GuestRuntime.enforcesMemoryLimit}, and the JS runtime
 * reports `false`. A host that needs a real memory ceiling needs a real WASM
 * runtime, and the field is how it finds that out instead of assuming.
 */

import type { JsonValue } from '@adze/protocol';

/** Ceilings applied to one guest call. */
export interface GuestLimits {
  /** Wall clock for a single `invoke`. Enforced by every runtime. */
  readonly timeoutMs: number;
  /** Linear-memory ceiling. Enforced only where `enforcesMemoryLimit` is true. */
  readonly maxMemoryBytes: number;
}

export const DEFAULT_GUEST_LIMITS: GuestLimits = {
  timeoutMs: 500,
  // 64 MiB: enough for a policy hook that parses a diff, small enough that a
  // runaway guest fails rather than exhausting the host.
  maxMemoryBytes: 64 * 1024 * 1024,
};

/** A loaded guest, ready to be called. */
export interface GuestModule {
  /** Which runtime produced it, for diagnostics that name the isolation level. */
  readonly runtime: 'wasm' | 'js' | 'native';
  /**
   * Call an exported function.
   *
   * Rejects on a guest fault. It does **not** implement the timeout: the caller
   * owns that, because the caller is the one that knows what a non-answer means
   * for the event being fired.
   */
  invoke(functionName: string, input: JsonValue): Promise<JsonValue>;
  dispose?(): Promise<void> | void;
}

export interface GuestLoadRequest {
  readonly pluginId: string;
  /** Absolute path to the module file. */
  readonly modulePath: string;
  readonly limits: GuestLimits;
}

export type GuestLoadOutcome =
  | { readonly ok: true; readonly module: GuestModule }
  | { readonly ok: false; readonly message: string };

export interface GuestRuntime {
  readonly kind: 'wasm' | 'js' | 'native';
  /**
   * Whether {@link GuestLimits.maxMemoryBytes} is actually enforced.
   *
   * Reported rather than assumed, for the same reason
   * `ValidationResult.validator` names the level that actually ran: a limit that
   * is documented and not enforced is worse than no limit, because a host stops
   * defending against what it believes is already handled.
   */
  readonly enforcesMemoryLimit: boolean;
  load(request: GuestLoadRequest): Promise<GuestLoadOutcome>;
}

/**
 * The default WASM runtime: none.
 *
 * Fails the load loudly. See the file header for why this is a refusal rather than
 * a skip.
 */
export function unavailableWasmRuntime(): GuestRuntime {
  return {
    kind: 'wasm',
    enforcesMemoryLimit: true,
    load: (request) =>
      Promise.resolve({
        ok: false,
        message:
          `plugin '${request.pluginId}' needs a wasm32-wasip2 runtime to load ` +
          `'${request.modulePath}', and none is configured. This build of ` +
          `@adze/plugin-sdk ships the WASM host interface but no WASM runtime, so the ` +
          `module cannot run. The plugin is refused rather than loaded without it: a ` +
          `hook that never runs looks like a policy that is being enforced.`,
      }),
  };
}

/**
 * What a JavaScript guest module must export.
 *
 * A single `invoke` rather than one export per event, so the same module can serve
 * `tool.pre` and `edit.pre` and share whatever it parsed. `input` is already-parsed
 * JSON rather than a string on this path: the serialization exists for the WASM
 * boundary, and paying for it in-process would only obscure errors.
 */
export interface JsGuestExports {
  invoke(functionName: string, input: JsonValue): JsonValue | Promise<JsonValue>;
}

function hasInvoke(value: unknown): value is JsGuestExports {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { invoke?: unknown };
  return typeof candidate.invoke === 'function';
}

/**
 * A working runtime for first-party plugins written as ES modules.
 *
 * **This is in-process and unsandboxed.** It is not a substitute for WASM and is
 * not offered as one: a host that loads a third-party plugin through this runtime
 * is running that plugin's code with the engine's full privileges, which is why
 * `loader.ts` treats `runtime: "js"` from an untrusted source the same way it
 * treats `native` — as something that needs an explicit opt-in.
 *
 * `allowedRoots` is a containment floor rather than a sandbox. It rejects a module
 * path outside the directories the host named, so a manifest cannot reach a file
 * elsewhere on disk even if path validation upstream were bypassed.
 */
export function jsModuleRuntime(options: {
  readonly allowedRoots: readonly string[];
}): GuestRuntime {
  return {
    kind: 'js',
    enforcesMemoryLimit: false,
    async load(request: GuestLoadRequest): Promise<GuestLoadOutcome> {
      const normalized = normalizePath(request.modulePath);
      const permitted = options.allowedRoots.some((root) =>
        isWithin(normalizePath(root), normalized),
      );
      if (!permitted) {
        return {
          ok: false,
          message:
            `plugin '${request.pluginId}' asked to load '${request.modulePath}', which is ` +
            `outside every directory this host permits. Refused.`,
        };
      }

      let namespace: unknown;
      try {
        namespace = (await import(pathToFileUrl(normalized))) as unknown;
      } catch (error) {
        return {
          ok: false,
          message:
            `plugin '${request.pluginId}' module '${request.modulePath}' could not be ` +
            `imported: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      const candidate = (namespace as { default?: unknown }).default;
      const exports = hasInvoke(namespace)
        ? namespace
        : hasInvoke(candidate)
          ? candidate
          : undefined;
      if (exports === undefined) {
        return {
          ok: false,
          message:
            `plugin '${request.pluginId}' module '${request.modulePath}' does not export ` +
            `'invoke(functionName, input)'. That is the whole guest contract; see the ` +
            `@adze/plugin-sdk README.`,
        };
      }

      return {
        ok: true,
        module: {
          runtime: 'js',
          invoke: async (functionName, input) => await exports.invoke(functionName, input),
        },
      };
    },
  };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function isWithin(root: string, candidate: string): boolean {
  const base = root.endsWith('/') ? root : `${root}/`;
  return candidate === root || candidate.startsWith(base);
}

/**
 * Build a `file://` URL for a dynamic import.
 *
 * Hand-built rather than via `node:url` so this module stays importable in any
 * runtime that provides `import()`. The encoding is not optional: an absolute path
 * containing a space — which every `C:\Users\First Last\...` path has — is not a
 * valid URL until it is encoded, and the failure is an opaque module-resolution
 * error rather than anything that mentions the space.
 */
function pathToFileUrl(normalized: string): string {
  const withLeadingSlash = /^[A-Za-z]:/.test(normalized) ? `/${normalized}` : normalized;
  const encoded = withLeadingSlash
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `file://${encoded}`;
}

/** Sentinel returned when a guest call does not finish inside its budget. */
export const GUEST_TIMEOUT = Symbol('adze.plugin.guest.timeout');

export type GuestCallOutcome =
  | { readonly kind: 'value'; readonly value: JsonValue }
  | { readonly kind: 'timeout'; readonly elapsedMs: number }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Call a guest with a hard wall clock.
 *
 * The invocation is inside the `try`, so a guest that throws *synchronously* — the
 * ordinary shape of a bug in a non-async handler — becomes an `error` outcome
 * rather than an exception escaping into the turn machine. `@adze/core`'s hook bus
 * documents the same trap, and it is the same bug twice if this function gets it
 * wrong: a plugin with a typo would kill the agent instead of being reported.
 */
export async function callGuest(
  module: GuestModule,
  functionName: string,
  input: JsonValue,
  timeoutMs: number,
): Promise<GuestCallOutcome> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;

  try {
    const raced = await Promise.race([
      Promise.resolve(module.invoke(functionName, input)),
      new Promise<typeof GUEST_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(GUEST_TIMEOUT), timeoutMs);
      }),
    ]);
    if (raced === GUEST_TIMEOUT) {
      return { kind: 'timeout', elapsedMs: Date.now() - startedAt };
    }
    return { kind: 'value', value: raced };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
