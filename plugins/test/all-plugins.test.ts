/**
 * The sweep: **every** plugin directory in `plugins/` loads through the real loader.
 *
 * This is the test that makes "each plugin actually loads" a property of the directory rather
 * than a claim about the eight that happened to get their own test file. It discovers plugin
 * directories by looking for `adze.plugin.json` — which is the definition of a plugin — so a
 * ninth plugin added later is covered the moment it exists, and a plugin whose manifest stops
 * parsing fails here rather than in a user's session.
 *
 * It also asserts the properties that should hold across all of them: no plugin contributes UI
 * to the engine, every hook plugin declares its runtime honestly, and nothing asks for network
 * access.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type LoadedPlugin,
  loadPlugin,
  loadPlugins,
  MANIFEST_FILENAME,
} from '../../packages/plugin-sdk/src/loader.js';
import { jsModuleRuntime } from '../../packages/plugin-sdk/src/wasm.js';
import { ENGINE_VERSION, PLUGINS_ROOT } from './support.js';

/** Directories under `plugins/` that contain a manifest. */
async function pluginDirectories(): Promise<string[]> {
  const entries = await readdir(PLUGINS_ROOT, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const contents = await readdir(join(PLUGINS_ROOT, entry.name));
    if (contents.includes(MANIFEST_FILENAME)) found.push(entry.name);
  }
  return found.sort();
}

let directories: string[];
let plugins: readonly LoadedPlugin[];

beforeAll(async () => {
  directories = await pluginDirectories();
  const outcome = await loadPlugins(
    directories.map((directory) => join(PLUGINS_ROOT, directory)),
    {
      engineVersion: ENGINE_VERSION,
      jsRuntime: jsModuleRuntime({ allowedRoots: [PLUGINS_ROOT] }),
      allowUnsandboxedJs: true,
    },
  );
  if (outcome.failures.length > 0) {
    throw new Error(
      outcome.failures
        .map(
          (failure) =>
            `${failure.root}\n${failure.diagnostics.map((d) => `  [${d.code}] ${d.message}`).join('\n')}`,
        )
        .join('\n\n'),
    );
  }
  plugins = outcome.plugins;
});

describe('every plugin in the directory loads', () => {
  it('finds at least the eight first-party plugins plus the two fixtures', () => {
    expect(directories.length).toBeGreaterThanOrEqual(10);
    expect(directories).toContain('adze-secrets-guard');
    expect(directories).toContain('acme-migration-guard');
  });

  it('loads all of them with no failure', () => {
    expect(plugins).toHaveLength(directories.length);
  });

  it('gives every one a unique id', () => {
    // `loadPlugins` refuses a duplicate id, so this passing means the refusal never fired.
    const ids = plugins.map((plugin) => plugin.manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('namespaces every first-party plugin under adze', () => {
    const firstParty = plugins.filter((plugin) => plugin.root.includes('adze-'));
    expect(firstParty.length).toBeGreaterThanOrEqual(8);
    for (const plugin of firstParty) {
      expect(plugin.manifest.id.startsWith('adze.')).toBe(true);
    }
  });
});

describe('properties that hold across all of them', () => {
  it('asks for no network access anywhere', () => {
    // A plugin that needs the network needs an ADR. None of these do, and asserting it means a
    // future one cannot acquire it quietly.
    for (const plugin of plugins) {
      expect(plugin.permissions.network).toEqual([]);
    }
  });

  it('asks for no environment variables anywhere', () => {
    for (const plugin of plugins) {
      expect(plugin.permissions.env).toEqual([]);
    }
  });

  it('never requests workspace-write', () => {
    // Not one of these plugins needs to write. `workspace-write` produces an install-time
    // warning for exactly this reason, and none of them should be triggering it.
    for (const plugin of plugins) {
      expect(plugin.permissions.filesystem).not.toBe('workspace-write');
    }
  });

  it('declares a runtime on every hook rather than relying on inference', () => {
    // Inference from a file extension works, and stating it means a reader of the manifest can
    // see that the module is unsandboxed without knowing the SDK's inference rules.
    for (const plugin of plugins) {
      for (const hook of plugin.hooks) {
        expect(hook.runtime).toBe('js');
      }
    }
  });

  it('bounds every hook timeout well under the SDK ceiling', () => {
    // A hook is synchronous with respect to the agent's progress, so a slow one is a latency
    // bug the plugin author is not the one to notice.
    for (const plugin of plugins) {
      for (const hook of plugin.hooks) {
        expect(hook.timeoutMs).toBeLessThanOrEqual(1_000);
      }
    }
  });

  it('gives every plugin a non-empty description and a repository', () => {
    for (const plugin of plugins) {
      expect(plugin.manifest.description.length).toBeGreaterThan(20);
      expect(plugin.manifest.repository).toMatch(/^https:\/\//);
      expect(plugin.manifest.license).toBe('Apache-2.0');
    }
  });

  it('contributes UI only to a named surface, never to the engine', () => {
    // Every UI contribution across the whole set produces a refusal notice. There is no
    // engine-side UI collection at all, by construction.
    for (const plugin of plugins) {
      for (const contribution of plugin.ui) {
        expect(['cli', 'vscode', 'ide']).toContain(contribution.surface);
        const refusal = plugin.notices.find(
          (notice) =>
            notice.code === 'ui-refused-by-engine' && notice.message.includes(contribution.id),
        );
        expect(refusal).toBeDefined();
      }
    }
  });
});

describe('the security posture of the loader is not bypassed by any of these', () => {
  it('refuses every js-hook plugin when the host does not opt in', async () => {
    // The check that matters most about the whole set: `runtime: "js"` is unsandboxed, and none
    // of these plugins can be loaded by a host that has not said so. If this ever passes for a
    // plugin with a hook, the opt-in has stopped being a gate.
    const withHooks = plugins.filter((plugin) => plugin.hooks.length > 0);
    expect(withHooks.length).toBeGreaterThanOrEqual(4);

    for (const plugin of withHooks) {
      const outcome = await loadPlugin(plugin.root, { engineVersion: ENGINE_VERSION });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.diagnostics.some((d) => d.code === 'native-not-permitted')).toBe(true);
    }
  });

  it('refuses every plugin against an engine version outside its declared range', async () => {
    // `engines.adze` checked at load is the difference between a clear error and a hook that
    // silently stops matching an argument shape three releases later.
    for (const directory of directories) {
      const outcome = await loadPlugin(join(PLUGINS_ROOT, directory), {
        engineVersion: '2.0.0',
        jsRuntime: jsModuleRuntime({ allowedRoots: [PLUGINS_ROOT] }),
        allowUnsandboxedJs: true,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.diagnostics[0]?.code).toBe('engine-mismatch');
    }
  });

  it('refuses a first-party plugin whose namespace the host has not claimed', async () => {
    const outcome = await loadPlugin(join(PLUGINS_ROOT, 'adze-secrets-guard'), {
      engineVersion: ENGINE_VERSION,
      jsRuntime: jsModuleRuntime({ allowedRoots: [PLUGINS_ROOT] }),
      allowUnsandboxedJs: true,
      claimedNamespaces: ['someone-else'],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.message).toContain('does not recognise as claimed');
  });

  it('accepts them when the adze namespace is claimed', async () => {
    const outcome = await loadPlugin(join(PLUGINS_ROOT, 'adze-secrets-guard'), {
      engineVersion: ENGINE_VERSION,
      jsRuntime: jsModuleRuntime({ allowedRoots: [PLUGINS_ROOT] }),
      allowUnsandboxedJs: true,
      claimedNamespaces: ['adze'],
    });
    expect(outcome.ok).toBe(true);
  });

  it('refuses a hook module outside the directories the host permits', async () => {
    // `allowedRoots` is a containment floor rather than a sandbox: a manifest cannot reach a
    // file elsewhere on disk even if path validation upstream were bypassed.
    const outcome = await loadPlugin(join(PLUGINS_ROOT, 'adze-secrets-guard'), {
      engineVersion: ENGINE_VERSION,
      jsRuntime: jsModuleRuntime({ allowedRoots: [join(PLUGINS_ROOT, 'somewhere-else')] }),
      allowUnsandboxedJs: true,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.message).toContain('outside every directory');
  });
});
