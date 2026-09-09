/**
 * New plugins join the registries without collisions.
 *
 * `loadPlugins` refuses a duplicate plugin id, and `buildCommandRegistry` /
 * `buildAgentRegistry` refuse a duplicate command or subagent name with the first
 * loaded entry winning. This test loads every plugin directory the way the engine
 * would and asserts the merged registries contain the new contributions with no
 * `duplicate-name` diagnostics — the property a surface assembling commands by
 * concatenation could never establish (plugins/FINDINGS.md finding 5).
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type LoadedPlugin,
  loadPlugins,
  MANIFEST_FILENAME,
} from '../../packages/plugin-sdk/src/loader.js';
import {
  buildAgentRegistry,
  buildCommandRegistry,
} from '../../packages/plugin-sdk/src/registry.js';
import { jsModuleRuntime } from '../../packages/plugin-sdk/src/wasm.js';
import { ENGINE_VERSION, PLUGINS_ROOT } from './support.js';

let plugins: readonly LoadedPlugin[];

beforeAll(async () => {
  const entries = await readdir(PLUGINS_ROOT, { withFileTypes: true });
  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const contents = await readdir(join(PLUGINS_ROOT, entry.name));
    if (contents.includes(MANIFEST_FILENAME)) roots.push(join(PLUGINS_ROOT, entry.name));
  }
  roots.sort();
  const outcome = await loadPlugins(roots, {
    engineVersion: ENGINE_VERSION,
    jsRuntime: jsModuleRuntime({ allowedRoots: [PLUGINS_ROOT] }),
    allowUnsandboxedJs: true,
  });
  if (outcome.failures.length > 0) {
    throw new Error(
      outcome.failures
        .map(
          (f) => `${f.root}\n${f.diagnostics.map((d) => `  [${d.code}] ${d.message}`).join('\n')}`,
        )
        .join('\n\n'),
    );
  }
  plugins = outcome.plugins;
});

describe('every plugin loads together', () => {
  it('includes the five new plugins', () => {
    const ids = plugins.map((plugin) => plugin.manifest.id);
    for (const id of [
      'adze.destructive-guard',
      'adze.esm-hygiene',
      'adze.wip-guard',
      'adze.ops-runbook',
      'adze.narrow-scope',
    ]) {
      expect(ids).toContain(id);
    }
  });
});

describe('the command registry has no collisions', () => {
  it('merges with no duplicate-name diagnostics', () => {
    const registry = buildCommandRegistry(plugins);
    expect(registry.diagnostics).toEqual([]);
  });

  it('contains the new commands alongside the old ones', () => {
    const registry = buildCommandRegistry(plugins);
    const names = registry.commands.map((command) => command.name);
    for (const name of [
      'deploy-checklist',
      'rollback-plan',
      'plan-small',
      'split-commit',
      'test-first',
      'docs-sync',
      'review-diff',
      'commit',
    ]) {
      expect(names).toContain(name);
    }
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('the agent registry has no collisions', () => {
  it('merges with no duplicate-name diagnostics', () => {
    const registry = buildAgentRegistry(plugins);
    expect(registry.diagnostics).toEqual([]);
  });

  it('contains the new subagents alongside the old ones', () => {
    const registry = buildAgentRegistry(plugins);
    const names = registry.agents.map((agent) => agent.name);
    for (const name of [
      'ops-reviewer',
      'scope-auditor',
      'code-review',
      'docs-auditor',
      'apply-forensics',
      'bench-claims',
    ]) {
      expect(names).toContain(name);
    }
    expect(new Set(names).size).toBe(names.length);
  });
});
