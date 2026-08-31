/**
 * Shared fixtures for the first-party plugin tests.
 *
 * Two things live here, and the split matters.
 *
 * {@link loadFirstPartyPlugin} loads a real plugin directory off disk through the real
 * {@link loadPlugin}. Nothing is stubbed: the manifest is parsed, `engines.adze` is
 * checked, hidden-character scanning runs on the manifest and on every JavaScript
 * module, and the hook modules are imported. A plugin that would not load in the engine
 * does not load here either.
 *
 * {@link harness} builds a dispatcher wired to that plugin's hooks and to `@adze/core`'s
 * real {@link dispatchToolCall}, {@link HookBus}, {@link PermissionGate}, and
 * {@link ToolRegistry}. This is the part worth insisting on. A mock dispatcher would
 * prove that a hook returns `deny`, which is the easy half and the half that cannot be
 * wrong. What has to be true is that returning `deny` *stops the call*, and that is a
 * fact about core's dispatch order rather than about any plugin — so only core's own
 * code can establish it.
 *
 * ## The spy tools declare no effects on purpose
 *
 * `effects: () => []` means the permission gate has nothing to refuse and allows every
 * call. With a gate that denied, a `denied` outcome would prove nothing: the gate would
 * have produced it whether or not the hook ran. Declaring no effects makes the plugin
 * the only thing in the pipeline capable of denying, so `kind: 'denied'` can only have
 * come from the plugin under test.
 *
 * ## Why `@adze/core` is imported by path
 *
 * `plugins/` is not a workspace package — the committed plugin directories carry no
 * `package.json`, because a plugin is a directory containing `adze.plugin.json` and
 * nothing more (ADR-0008). So there is no `node_modules/@adze` to resolve through, and
 * these imports name the built artifact directly. That is the same file
 * `@adze/plugin-sdk` itself resolves to, so there is exactly one instance of core in the
 * process. Requiring a `package.json` here purely to make an import look tidier would
 * mean the test fixtures were no longer shaped like the thing they test.
 *
 * ## How these tests get run
 *
 * Because `plugins/` is not a workspace package, `turbo run test` cannot see this
 * directory — turbo enumerates packages, and there is none here. These 200-odd tests
 * were therefore written, committed, and then never executed again by CI, which is the
 * quiet way a suite rots: `@adze/plugin-sdk` could break every one of them and the build
 * would stay green.
 *
 * They now run as their own CI step, `pnpm test:plugins`. Deliberately a separate step
 * rather than appended to `pnpm test` with `&&`: a pnpm script containing `&&` opens an
 * interactive shell and runs nothing on Windows, so chaining them would have restored
 * the silence it was meant to fix. If you move or rename this directory, move that
 * script and the CI step with it.
 *
 * No test in this directory touches the network, spawns a process, or needs a model key.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  ContinuationStore,
  type DispatchDeps,
  defineTool,
  dispatchToolCall,
  HookBus,
  MemoryFileSystem,
  NullBroker,
  PermissionGate,
  type RegisteredTool,
  ToolRegistry,
} from '../../packages/core/dist/index.js';
import { toRegisteredHook } from '../../packages/plugin-sdk/src/bridge.js';
import { HookHost, recordingObserver } from '../../packages/plugin-sdk/src/hooks.js';
import { type LoadedPlugin, loadPlugin } from '../../packages/plugin-sdk/src/loader.js';
import { jsModuleRuntime } from '../../packages/plugin-sdk/src/wasm.js';
import type { JsonObject } from '../../packages/protocol/dist/index.js';

/** The `plugins/` directory: the parent of `plugins/test/`. */
export const PLUGINS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The engine version the tests load against.
 *
 * Every first-party manifest declares `>=0.0.1 <1.0.0`, which is the range that matches
 * the repository's current pre-1.0 state. Pinning the check to a literal here rather than
 * reading a package version means a version bump does not silently start skipping the
 * compatibility check.
 */
export const ENGINE_VERSION = '0.0.1';

/**
 * Load one plugin directory the way the engine would.
 *
 * `allowUnsandboxedJs` is required for any plugin with a `runtime: "js"` hook and is
 * passed explicitly rather than defaulted, because that flag is the whole security
 * decision: an ES module imported into this process has the engine's full privileges.
 * A test that got it for free would be testing a host configuration no careful operator
 * would use.
 */
export async function loadFirstPartyPlugin(directory: string): Promise<LoadedPlugin> {
  const root = join(PLUGINS_ROOT, directory);
  const outcome = await loadPlugin(root, {
    engineVersion: ENGINE_VERSION,
    jsRuntime: jsModuleRuntime({ allowedRoots: [PLUGINS_ROOT] }),
    allowUnsandboxedJs: true,
  });
  if (!outcome.ok) {
    // Thrown rather than asserted so the failing diagnostic is the test output. A bare
    // `expect(outcome.ok).toBe(true)` reports `false !== true` and hides the reason,
    // which for a loader is the only useful part.
    throw new Error(
      `plugin '${directory}' failed to load:\n${outcome.diagnostics
        .map((diagnostic) => `  [${diagnostic.code}] ${diagnostic.message}`)
        .join('\n')}`,
    );
  }
  return outcome.plugin;
}

export interface Harness {
  readonly deps: DispatchDeps;
  readonly observer: ReturnType<typeof recordingObserver>;
  /** Arguments the tool body received, or `undefined` if it never ran. */
  seen(): JsonObject | undefined;
}

/**
 * A spy tool that records its arguments and declares no effects.
 *
 * The schema is a permissive union of what `edit`, `write`, and `bash` accept, so one
 * definition can stand in for each of them by name. Name is what matters: the
 * `edit.pre` derivation in `@adze/plugin-sdk`'s bridge keys off the tool's name, so only
 * a tool actually called `edit` or `write` reaches it.
 */
function spyTool(name: string, record: (args: JsonObject) => void): RegisteredTool {
  return defineTool({
    name,
    description: 'records the arguments it was called with',
    schema: z.object({
      path: z.string().optional(),
      content: z.string().optional(),
      command: z.string().optional(),
      edits: z.array(z.object({ search: z.string(), replace: z.string() })).optional(),
      replacement: z.string().optional(),
      note: z.string().optional(),
    }),
    effects: () => [],
    execute: async (args) => {
      record(args as JsonObject);
      return await Promise.resolve({ ok: true, content: [{ type: 'text', text: 'ran' }] });
    },
  });
}

export interface HarnessOptions {
  /** Whether a human has approved writing a path. Defaults to "nobody has". */
  readonly approvedByHuman?: (path: string) => boolean;
  readonly onFailure?: 'allow' | 'deny';
}

/**
 * Wire a loaded plugin's hooks into core's real dispatch pipeline.
 *
 * Registers `edit`, `write`, and `bash` spies, which is the full set of tools the
 * first-party policy hooks have opinions about.
 */
export function harness(plugin: LoadedPlugin, options: HarnessOptions = {}): Harness {
  let received: JsonObject | undefined;

  const registry = new ToolRegistry();
  for (const name of ['edit', 'write', 'bash', 'read']) {
    registry.register(
      spyTool(name, (args) => {
        received = args;
      }),
    );
  }

  const observer = recordingObserver();
  const host = new HookHost({
    observer,
    ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
  });
  for (const hook of plugin.hooks) host.register(hook);

  const bus = new HookBus();
  bus.register(
    toRegisteredHook({
      host,
      ...(options.approvedByHuman === undefined
        ? {}
        : { approvedByHuman: options.approvedByHuman }),
    }),
  );

  const gate = new PermissionGate({
    workspaceRoot: '/work',
    sandbox: { mode: 'read-only', writableRoots: [], allowedNetworkHosts: [], commandRules: [] },
    approvals: 'never',
    broker: new NullBroker(),
    fs: new MemoryFileSystem(),
    nextRequestId: () => 'appr_1',
    platform: 'linux',
  });

  return {
    observer,
    seen: () => received,
    deps: {
      registry,
      gate,
      hooks: bus,
      continuations: new ContinuationStore(() => 'cont_1'),
      workspaceRoot: '/work',
      sessionId: 'sess_1',
      turnId: 'turn_1',
      limits: { maxResultBytes: 4096, timeoutMs: 1_000 },
      signal: new AbortController().signal,
      search: undefined,
      todos: [],
      runSubagent: undefined,
    },
  };
}

/** Dispatch one tool call through core. */
export async function dispatch(h: Harness, name: string, args: JsonObject) {
  return await dispatchToolCall({ callId: 'c1', name, arguments: args, step: 0 }, h.deps);
}

/**
 * Build a credential-shaped string at runtime.
 *
 * Never a literal. A test fixture containing a real-looking key would be committed to
 * the repository, indexed by every secret scanner pointed at it, and would need
 * `secrets-guard`'s own exemption marker to survive the guard it is testing — which
 * would make the fixture prove the exemption rather than the rule.
 */
export function fakeCredential(prefix: string, length: number): string {
  return prefix + 'A1b2C3d4E5f6G7h8'.repeat(Math.ceil(length / 16)).slice(0, length);
}
