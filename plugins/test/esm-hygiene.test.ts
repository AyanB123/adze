/**
 * `adze.esm-hygiene`: CommonJS syntax and extensionless imports are refused at the edit.
 *
 * The hook judges added text only, on both `edit.pre` (`edits[].replace` plus whole-file
 * `content`) and the `tool.pre` backstop on `write`. The negative cases prove the scope:
 * documentation quoting forbidden syntax stays writable, and a `.js` specifier passes.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { LoadedPlugin } from '../../packages/plugin-sdk/src/loader.js';
import { dispatch, harness, loadFirstPartyPlugin } from './support.js';

let plugin: LoadedPlugin;

beforeAll(async () => {
  plugin = await loadFirstPartyPlugin('adze-esm-hygiene');
});

async function adding(path: string, replace: string) {
  const h = harness(plugin);
  const outcome = await dispatch(h, 'edit', { path, edits: [{ search: 'PLACEHOLDER', replace }] });
  return { outcome, seen: h.seen() };
}

describe('the plugin loads through the real loader', () => {
  it('registers edit.pre and the write backstop', () => {
    expect(plugin.manifest.id).toBe('adze.esm-hygiene');
    expect(plugin.hooks.map((hook) => hook.event).sort()).toEqual(['edit.pre', 'tool.pre']);
  });
});

describe('CommonJS syntax is denied in source', () => {
  it('denies require() and never writes it', async () => {
    const { outcome, seen } = await adding(
      'packages/core/src/turn.ts',
      "const fs = require('node:fs');",
    );

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.source).toBe('hook');
    expect(outcome.reason).toContain('ESM-only');
    expect(seen).toBeUndefined();
  });

  it('denies module.exports', async () => {
    const { outcome } = await adding('packages/core/src/index.ts', 'module.exports = { Engine };');
    expect(outcome.kind).toBe('denied');
  });

  it('denies __dirname', async () => {
    const { outcome } = await adding('packages/cli/src/run.ts', 'const root = __dirname;');
    if (outcome.kind !== 'denied') throw new Error('expected a denial');
    expect(outcome.reason).toContain('import.meta.url');
  });

  it('allows an import specifier', async () => {
    const { outcome } = await adding(
      'packages/core/src/turn.ts',
      "import { join } from 'node:path';",
    );
    expect(outcome.kind).toBe('executed');
  });
});

describe('relative imports carry the .js extension', () => {
  it('denies an extensionless relative import', async () => {
    const { outcome, seen } = await adding(
      'packages/core/src/turn.ts',
      "import { match } from './match';",
    );

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.reason).toContain('.js');
    expect(seen).toBeUndefined();
  });

  it('denies a .ts specifier', async () => {
    const { outcome } = await adding(
      'packages/core/src/turn.ts',
      "import { match } from './match.ts';",
    );
    if (outcome.kind !== 'denied') throw new Error('expected a denial');
    expect(outcome.reason).toContain('.js');
  });

  it('allows the .js specifier', async () => {
    const { outcome } = await adding(
      'packages/core/src/turn.ts',
      "import { match } from './match.js';",
    );
    expect(outcome.kind).toBe('executed');
  });

  it('allows a bare package import with no extension', async () => {
    const { outcome } = await adding('packages/core/src/x.ts', "import { z } from 'zod';");
    expect(outcome.kind).toBe('executed');
  });
});

describe('the hook stays out of the way otherwise', () => {
  it('ignores markdown quoting forbidden syntax', async () => {
    const { outcome } = await adding(
      'docs/guide.md',
      "Never write `const fs = require('node:fs');` in this repo.",
    );
    expect(outcome.kind).toBe('executed');
  });

  it('checks whole-file content on edit.pre', async () => {
    const h = harness(plugin);
    const outcome = await dispatch(h, 'edit', {
      path: 'packages/core/src/new.ts',
      replacement: "const fs = require('node:fs');\n",
    });
    expect(outcome.kind).toBe('denied');
    expect(h.seen()).toBeUndefined();
  });

  it('checks a whole-file write on the tool.pre backstop', async () => {
    const h = harness(plugin);
    const outcome = await dispatch(h, 'write', {
      path: 'packages/core/src/new.ts',
      content: "import { x } from './x';\n",
    });
    expect(outcome.kind).toBe('denied');
    expect(h.seen()).toBeUndefined();
  });

  it('allows a clean whole-file write', async () => {
    const h = harness(plugin);
    const outcome = await dispatch(h, 'write', {
      path: 'packages/core/src/new.ts',
      content: "import { x } from './x.js';\n",
    });
    expect(outcome.kind).toBe('executed');
  });
});
