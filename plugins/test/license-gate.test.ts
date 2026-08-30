/**
 * `adze.license-gate`: the forbidden-licence denial, the catalog rule, and the dual-licence
 * case that must not deny.
 *
 * The negative cases carry as much weight as the positive ones here. This plugin is
 * deliberately biased toward allowing when unsure — `scripts/check-licenses.mjs` is the
 * authority and fails CI — so a test that only proved it denies would be testing the half
 * that is easy to get right.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { LoadedPlugin } from '../../packages/plugin-sdk/src/loader.js';
import { dispatch, harness, loadFirstPartyPlugin } from './support.js';

let plugin: LoadedPlugin;

beforeAll(async () => {
  plugin = await loadFirstPartyPlugin('adze-license-gate');
});

async function editing(path: string, replace: string) {
  const h = harness(plugin);
  const outcome = await dispatch(h, 'edit', { path, edits: [{ search: 'PLACEHOLDER', replace }] });
  return { outcome, seen: h.seen() };
}

async function bash(command: string) {
  const h = harness(plugin);
  const outcome = await dispatch(h, 'bash', { command });
  return { outcome, seen: h.seen() };
}

describe('the plugin loads through the real loader', () => {
  it('registers both hooks', () => {
    expect(plugin.manifest.id).toBe('adze.license-gate');
    expect(plugin.hooks.map((hook) => hook.event).sort()).toEqual(['edit.pre', 'tool.pre']);
  });
});

describe('a forbidden licence identifier is denied', () => {
  it.each([
    'GPL-3.0',
    'GPL-3.0-only',
    'AGPL-3.0-or-later',
    'LGPL-2.1',
    'EPL-2.0',
    'SSPL-1.0',
    'BUSL-1.1',
    'MPL-1.1',
    'Elastic-2.0',
    'UNLICENSED',
  ])('denies recording %s in a package.json', async (identifier) => {
    const { outcome, seen } = await editing(
      'packages/thing/package.json',
      `  "license": "${identifier}",`,
    );

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.source).toBe('hook');
    expect(seen).toBeUndefined();
  });

  it('names the forbidden family and the permissive alternatives', async () => {
    const { outcome } = await editing('LICENSE', 'license: AGPL-3.0');
    if (outcome.kind !== 'denied') throw new Error('expected a denial');
    expect(outcome.reason).toContain('AGPL');
    expect(outcome.reason).toContain('Apache-2.0');
  });

  it('denies a Commons Clause rider', async () => {
    const { outcome } = await editing(
      'package.json',
      '  "license": "Apache-2.0 AND Commons Clause",',
    );
    expect(outcome.kind).toBe('denied');
  });

  it.each(['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'CC0-1.0', 'Unlicense'])(
    'allows %s',
    async (identifier) => {
      const { outcome } = await editing('package.json', `  "license": "${identifier}",`);
      expect(outcome.kind).toBe('executed');
    },
  );
});

describe('a dual licence is a choice, not a violation', () => {
  it('allows (MIT OR GPL-3.0), because taking the MIT option is legitimate', async () => {
    // The case that separates a useful gate from an annoying one. Reading an OR expression
    // as forbidden because one option is would deny a large amount of usable code.
    const { outcome } = await editing('package.json', '  "license": "(MIT OR GPL-3.0)",');
    expect(outcome.kind).toBe('executed');
  });

  it('denies MIT AND GPL-3.0, because both apply at once', async () => {
    const { outcome } = await editing('package.json', '  "license": "MIT AND GPL-3.0",');
    expect(outcome.kind).toBe('denied');
  });

  it('denies (GPL-2.0 OR AGPL-3.0), where every option is forbidden', async () => {
    const { outcome } = await editing('package.json', '  "license": "(GPL-2.0 OR AGPL-3.0)",');
    expect(outcome.kind).toBe('denied');
  });
});

describe('a dependency must go through the catalog', () => {
  it('denies an inline version', async () => {
    const { outcome, seen } = await editing(
      'packages/core/package.json',
      '    "some-library": "^2.1.0",',
    );

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.reason).toContain('catalog:');
    expect(outcome.reason).toContain('pnpm-workspace.yaml');
    expect(seen).toBeUndefined();
  });

  it('tells the author to read the LICENSE rather than trust the API field', async () => {
    const { outcome } = await editing('package.json', '    "some-library": "~1.0.0",');
    if (outcome.kind !== 'denied') throw new Error('expected a denial');
    expect(outcome.reason).toContain('NOASSERTION');
  });

  it('allows the correct form', async () => {
    const { outcome } = await editing('packages/core/package.json', '    "zod": "catalog:",');
    expect(outcome.kind).toBe('executed');
  });

  it.each([
    ['the package version field', '  "version": "0.2.0",'],
    ['packageManager', '  "packageManager": "pnpm@10.20.0",'],
    ['an engines constraint', '    "node": ">=22.12.0",'],
    ['a pnpm engines constraint', '    "pnpm": ">=10.0.0",'],
  ])('does not mistake %s for a dependency', async (_label, line) => {
    const { outcome } = await editing('package.json', line);
    expect(outcome.kind).toBe('executed');
  });

  it('leaves the catalog block in pnpm-workspace.yaml alone', async () => {
    // That file is where a version is *supposed* to live, and it is YAML rather than JSON.
    const { outcome } = await editing('pnpm-workspace.yaml', '  some-library: ^2.1.0');
    expect(outcome.kind).toBe('executed');
  });

  it('ignores a file that is not a manifest', async () => {
    const { outcome } = await editing('src/config.ts', 'const deps = { "thing": "^1.0.0" };');
    expect(outcome.kind).toBe('executed');
  });
});

describe('adding a dependency from the command line is denied', () => {
  it.each([
    'pnpm add some-library',
    'npm install some-library',
    'yarn add some-library',
    'bun add some-library',
  ])('denies %s', async (command) => {
    const { outcome, seen } = await bash(command);

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.reason).toContain('LICENSE');
    expect(outcome.reason).toContain('catalog:');
    expect(seen).toBeUndefined();
  });

  it('mentions the install-script rule, which is the other half of the policy', async () => {
    const { outcome } = await bash('pnpm add some-library');
    if (outcome.kind !== 'denied') throw new Error('expected a denial');
    expect(outcome.reason).toContain('onlyBuiltDependencies');
  });

  it('gives ovsx the specific reason, because this repository already established it', async () => {
    const { outcome } = await bash('pnpm add -D ovsx');
    if (outcome.kind !== 'denied') throw new Error('expected a denial');
    expect(outcome.reason).toContain('EPL-2.0');
  });

  it('allows a bare install, which adds nothing new', async () => {
    // `pnpm install` with no package restores the lockfile. Denying it would break the
    // ordinary setup path for no benefit.
    const { outcome } = await bash('pnpm install --frozen-lockfile');
    expect(outcome.kind).toBe('executed');
  });

  it('leaves an unrelated command alone', async () => {
    const { outcome } = await bash('pnpm --version');
    expect(outcome.kind).toBe('executed');
  });
});

describe('a whole-file write of a manifest is checked too', () => {
  it('denies a forbidden licence written by the write tool', async () => {
    // `edit.pre` reports a whole-file write as `edits: []`, so this can only be caught on
    // `tool.pre`. See plugins/FINDINGS.md finding 1.
    const h = harness(plugin);
    const outcome = await dispatch(h, 'write', {
      path: 'packages/thing/package.json',
      content: '{\n  "name": "thing",\n  "license": "GPL-3.0"\n}\n',
    });

    expect(outcome.kind).toBe('denied');
    expect(h.seen()).toBeUndefined();
  });

  it('allows a permissive one', async () => {
    const h = harness(plugin);
    const outcome = await dispatch(h, 'write', {
      path: 'packages/thing/package.json',
      content: '{\n  "name": "thing",\n  "license": "Apache-2.0",\n  "dependencies": {}\n}\n',
    });
    expect(outcome.kind).toBe('executed');
  });
});
