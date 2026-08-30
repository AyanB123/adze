/**
 * `adze.adr-context`: the five glob context providers, built and resolved.
 *
 * Loading a manifest only proves the JSON validated. What has to be true for this plugin to be
 * worth anything is that the patterns match the paths this repository actually has — a provider
 * whose glob is subtly wrong loads cleanly and returns nothing, which presents as a plugin that
 * does nothing.
 *
 * So the providers are built through `buildContextProviders` and resolved against an in-memory
 * filesystem whose paths are taken from the real repository layout.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContextFileSystem } from '../../packages/plugin-sdk/src/context.js';
import { buildContextProviders, type LoadedPlugin } from '../../packages/plugin-sdk/src/loader.js';
import { ENGINE_VERSION, loadFirstPartyPlugin, PLUGINS_ROOT } from './support.js';

/** The paths this repository actually has, as far as these providers care. */
const WORKSPACE = [
  'docs/architecture/adr/0001-engine-first-architecture.md',
  'docs/architecture/adr/0008-plugin-architecture.md',
  'docs/architecture/adr/0011-benchmark-harness.md',
  'docs/architecture/adr/README.md',
  'docs/architecture/README.md',
  'docs/benchmarks/strategy.md',
  'docs/plugins/spec.md',
  'docs/roadmap.md',
  'CONTRIBUTING.md',
  'GOVERNANCE.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'README.md',
  'packages/core/src/turn.ts',
];

function workspaceFiles(paths: readonly string[] = WORKSPACE): ContextFileSystem {
  return {
    list: () => Promise.resolve(paths),
    read: (path) => Promise.resolve(`# ${path}\n\ncontent of ${path}\n`),
  };
}

async function providersOf(plugin: LoadedPlugin, files = workspaceFiles()) {
  const built = buildContextProviders([plugin], { workspaceRoot: '/work', files });
  expect(built.diagnostics).toEqual([]);
  return built.providers;
}

async function resolved(plugin: LoadedPlugin, trigger: string) {
  const providers = await providersOf(plugin);
  const provider = providers.find((candidate) => candidate.trigger === trigger);
  if (provider === undefined) throw new Error(`no provider for ${trigger}`);
  return { provider, resolution: await provider.resolve(trigger) };
}

describe('the plugin loads and every pattern compiles', () => {
  it('registers five providers and one command, with no executable code', async () => {
    const plugin = await loadFirstPartyPlugin('adze-adr-context');

    expect(plugin.manifest.id).toBe('adze.adr-context');
    expect(plugin.contextProviders).toHaveLength(5);
    expect(plugin.commands.map((command) => command.name)).toEqual(['adr-new']);
    // The ADR-0008 claim under test: most plugins need no code at all.
    expect(plugin.hooks).toEqual([]);
    expect(plugin.contextProviders.every((pending) => pending.guest === undefined)).toBe(true);
  });

  it('loads with no host flags at all', async () => {
    // A declarative plugin needs neither `allowUnsandboxedJs` nor a runtime. If this ever
    // starts failing, something procedural has crept in.
    const { loadPlugin } = await import('../../packages/plugin-sdk/src/loader.js');
    const outcome = await loadPlugin(join(PLUGINS_ROOT, 'adze-adr-context'), {
      engineVersion: ENGINE_VERSION,
    });
    expect(outcome.ok).toBe(true);
  });

  it('builds all five providers without a diagnostic', async () => {
    const plugin = await loadFirstPartyPlugin('adze-adr-context');
    const providers = await providersOf(plugin);
    expect(providers.map((provider) => provider.trigger).sort()).toEqual([
      '@adr',
      '@bench-policy',
      '@governance',
      '@invariants',
      '@plugin-spec',
    ]);
  });
});

describe('each trigger matches the paths it is meant to', () => {
  it('@adr pulls in every decision record and nothing else', async () => {
    const plugin = await loadFirstPartyPlugin('adze-adr-context');
    const { resolution } = await resolved(plugin, '@adr');

    const sources = resolution.chunks.map((chunk) => chunk.source);
    expect(sources).toContain('docs/architecture/adr/0008-plugin-architecture.md');
    expect(sources).toContain('docs/architecture/adr/README.md');
    // Not the architecture overview, which `@invariants` owns.
    expect(sources).not.toContain('docs/architecture/README.md');
    expect(sources).not.toContain('docs/roadmap.md');
  });

  it('@invariants pulls in the architecture overview and CONTRIBUTING', async () => {
    const plugin = await loadFirstPartyPlugin('adze-adr-context');
    const { resolution } = await resolved(plugin, '@invariants');

    const sources = resolution.chunks.map((chunk) => chunk.source);
    expect(sources).toContain('docs/architecture/README.md');
    expect(sources).toContain('CONTRIBUTING.md');
    // `docs/architecture/*.md` is one level deep on purpose: the ADR directory is `@adr`.
    expect(sources).not.toContain('docs/architecture/adr/0001-engine-first-architecture.md');
  });

  it('@bench-policy pulls in the strategy and ADR-0011', async () => {
    const plugin = await loadFirstPartyPlugin('adze-adr-context');
    const { resolution } = await resolved(plugin, '@bench-policy');

    const sources = resolution.chunks.map((chunk) => chunk.source);
    expect(sources).toContain('docs/benchmarks/strategy.md');
    expect(sources).toContain('docs/architecture/adr/0011-benchmark-harness.md');
  });

  it('@governance pulls in the three governance documents', async () => {
    const plugin = await loadFirstPartyPlugin('adze-adr-context');
    const { resolution } = await resolved(plugin, '@governance');

    expect(resolution.chunks.map((chunk) => chunk.source).sort()).toEqual([
      'CODE_OF_CONDUCT.md',
      'GOVERNANCE.md',
      'SECURITY.md',
    ]);
  });

  it('@plugin-spec pulls in the spec and ADR-0008', async () => {
    const plugin = await loadFirstPartyPlugin('adze-adr-context');
    const { resolution } = await resolved(plugin, '@plugin-spec');

    const sources = resolution.chunks.map((chunk) => chunk.source);
    expect(sources).toContain('docs/plugins/spec.md');
    expect(sources).toContain('docs/architecture/adr/0008-plugin-architecture.md');
  });

  it('returns sources in a stable order', async () => {
    // An unstable provider order is a context-cache miss on every turn, which is the failure
    // core's epoch assembler exists to prevent.
    const plugin = await loadFirstPartyPlugin('adze-adr-context');
    const first = await resolved(plugin, '@adr');
    const second = await resolved(plugin, '@adr');
    expect(first.resolution.chunks.map((chunk) => chunk.source)).toEqual(
      second.resolution.chunks.map((chunk) => chunk.source),
    );
  });
});

describe('the @adr patterns match the real directory on disk', () => {
  it('matches every file actually in docs/architecture/adr', async () => {
    // The in-memory list above is a fixture and could drift from the repository. This reads the
    // real directory, so a renamed ADR folder fails here rather than silently returning nothing
    // in production.
    const adrDirectory = join(PLUGINS_ROOT, '..', 'docs', 'architecture', 'adr');
    const entries = await readdir(adrDirectory);
    const markdown = entries.filter((entry) => entry.endsWith('.md'));
    expect(markdown.length).toBeGreaterThan(5);

    const plugin = await loadFirstPartyPlugin('adze-adr-context');
    const paths = markdown.map((entry) => `docs/architecture/adr/${entry}`);
    const built = buildContextProviders([plugin], {
      workspaceRoot: '/work',
      files: workspaceFiles(paths),
    });
    const provider = built.providers.find((candidate) => candidate.trigger === '@adr');
    if (provider === undefined) throw new Error('no @adr provider');

    const resolution = await provider.resolve('@adr');
    expect(resolution.chunks).toHaveLength(markdown.length);
  });
});

describe('the byte budget truncates and says so', () => {
  it('reports truncation rather than silently dropping content', async () => {
    // Truncation is not an error and must not be silent: a provider that quietly returned a
    // prefix would make the model reason about a subset it believes is the whole set.
    const plugin = await loadFirstPartyPlugin('adze-adr-context');
    const huge: ContextFileSystem = {
      list: () =>
        Promise.resolve(['docs/architecture/adr/0001-a.md', 'docs/architecture/adr/0002-b.md']),
      read: () => Promise.resolve('x'.repeat(200_000)),
    };
    const built = buildContextProviders([plugin], { workspaceRoot: '/work', files: huge });
    const provider = built.providers.find((candidate) => candidate.trigger === '@adr');
    if (provider === undefined) throw new Error('no @adr provider');

    const resolution = await provider.resolve('@adr');
    expect(resolution.truncated).toBe(true);
    const total = resolution.chunks.reduce((sum, chunk) => sum + chunk.content.length, 0);
    expect(total).toBeLessThanOrEqual(131_072);
  });
});

describe('two plugins claiming one trigger', () => {
  it('warns and lets the first loaded win', async () => {
    // The spec's example fixture also claims `@adr`. This is the documented behaviour and the
    // right default — silently merging two providers would make a prompt's meaning depend on
    // load order — but a plugin author needs to know it happens.
    const first = await loadFirstPartyPlugin('adze-adr-context');
    const fixture = await loadFirstPartyPlugin('acme-adr-context');

    const built = buildContextProviders([first, fixture], {
      workspaceRoot: '/work',
      files: workspaceFiles(),
    });

    const collision = built.diagnostics.find((diagnostic) => diagnostic.message.includes('@adr'));
    if (collision === undefined) throw new Error('expected a trigger-collision diagnostic');
    expect(collision.severity).toBe('warning');
    expect(collision.message).toContain('adze.adr-context');
    expect(collision.message).toContain('inactive');

    // One `@adr`, owned by the first plugin loaded.
    const adr = built.providers.filter((provider) => provider.trigger === '@adr');
    expect(adr).toHaveLength(1);
    expect(adr[0]?.pluginId).toBe('adze.adr-context');
  });
});
