/**
 * The architecture invariants for this package, asserted rather than reviewed.
 *
 * The same mechanism `@adze/core` uses, with the rules that apply to a *service*
 * package: no surface import, no sibling service import, versions through the catalog,
 * `.js` on every relative specifier. And one rule specific to the gateway, which is the
 * only package in the repo whose job is to make outbound network calls: its own test
 * suite must make none.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(PACKAGE_ROOT, 'src');
const TEST = join(PACKAGE_ROOT, 'test');

async function sourceFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Comment lines are stripped before scanning.
 *
 * This package's doc comments contain usage examples that import `@adze/providers` and
 * name `@adze/cli`, and a scanner that counted those would report violations that are
 * documentation. A file full of false positives is a file nobody trusts.
 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

async function importSpecifiers(
  root: string,
): Promise<readonly { file: string; specifier: string }[]> {
  const found: { file: string; specifier: string }[] = [];
  for (const file of await sourceFiles(root)) {
    const text = stripComments(await readFile(file, 'utf8'));
    const relative = file.slice(root.length + 1).replaceAll('\\', '/');
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier !== undefined) found.push({ file: relative, specifier });
    }
  }
  return found;
}

describe('invariant 1 — surfaces render, services do not', () => {
  it('imports no surface package', async () => {
    const surfaces = ['@adze/cli', '@adze/vscode', '@adze/ide', '@adze/hub', '@adze/sdk'];
    const offenders = (await importSpecifiers(SRC)).filter((entry) =>
      surfaces.some((surface) => entry.specifier.startsWith(surface)),
    );
    expect(offenders).toEqual([]);
  });

  it('emits no terminal escapes', async () => {
    for (const file of await sourceFiles(SRC)) {
      const text = await readFile(file, 'utf8');
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the absence of an ANSI escape requires naming it
      expect(/\u001b\[/.test(text), file).toBe(false);
    }
  });

  it('has no console output', async () => {
    // A gateway that logs is a gateway that logs a request body, and a request body is
    // where the API key lives.
    for (const file of await sourceFiles(SRC)) {
      const text = await readFile(file, 'utf8');
      expect(/\bconsole\.(?:log|info|debug|table|dir|warn|error)\s*\(/.test(text), file).toBe(
        false,
      );
    }
  });
});

describe('dependency rules', () => {
  it('imports no sibling service package', async () => {
    // Service packages must not import each other, so each stays individually swappable.
    // `@adze/core` is the interface this package implements and `@adze/protocol` is the
    // contract; `apply`, `retrieval`, `sandbox`, `mcp`, and `plugin-sdk` are siblings.
    const allowed = new Set(['@adze/core', '@adze/protocol']);
    const offenders = (await importSpecifiers(SRC)).filter(
      (entry) => entry.specifier.startsWith('@adze/') && !allowed.has(entry.specifier),
    );
    expect(offenders).toEqual([]);
  });

  it('imports nothing from bench', async () => {
    const offenders = (await importSpecifiers(SRC)).filter(
      (entry) => entry.specifier.includes('bench/') || entry.specifier.startsWith('bench'),
    );
    expect(offenders).toEqual([]);
  });

  it('references every dependency version through the catalog', async () => {
    const manifest: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    } = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    const all = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const [name, range] of Object.entries(all)) {
      expect([name, range]).toEqual([name, expect.stringMatching(/^(?:catalog:|workspace:)/)]);
    }
  });
});

describe('relative imports carry the .js extension', () => {
  it('every relative specifier ends in .js or .json', async () => {
    // `moduleResolution: nodenext`. An extensionless relative import typechecks and fails
    // at runtime, which is the worst place to find out.
    const offenders = (await importSpecifiers(SRC)).filter(
      (entry) =>
        entry.specifier.startsWith('.') &&
        !entry.specifier.endsWith('.js') &&
        !entry.specifier.endsWith('.json'),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the test suite makes no network call', () => {
  it('never imports a real provider adapter', async () => {
    // The whole suite runs against `MockLanguageModelV4` through the gateway's
    // LanguageModelFactory seam. A test that constructed `createAnthropic` would, on a
    // developer machine with a key exported, quietly start billing — and would fail in CI
    // for a reason that looks like a code bug.
    const forbidden = ['@ai-sdk/anthropic', '@ai-sdk/openai', '@ai-sdk/openai-compatible'];
    const offenders = (await importSpecifiers(TEST)).filter((entry) =>
      forbidden.some((name) => entry.specifier.startsWith(name)),
    );
    expect(offenders).toEqual([]);
  });

  it('names no live API host', async () => {
    const hosts = ['api.anthropic.com', 'api.openai.com', 'openrouter.ai'];
    for (const file of await sourceFiles(TEST)) {
      const text = await readFile(file, 'utf8');
      for (const host of hosts) {
        // A host may appear as a literal in a fixture URL for an error message, but never
        // as a base URL a test would actually dial.
        const dialled = new RegExp(`baseURL:\\s*['"\`][^'"\`]*${host.replace('.', '\\.')}`);
        expect(dialled.test(text), `${file} configures a live host`).toBe(false);
      }
    }
  });

  it('never reads the ambient environment for credentials', async () => {
    // A resolution test that reads the process environment passes or fails depending on
    // whose machine it runs on, and a config test that reads the real home directory puts a
    // developer's key inside a fixture's blast radius.
    //
    // This file is excluded from its own scan: the pattern it looks for necessarily
    // appears in the pattern itself, and a self-match would make the assertion
    // permanently red.
    const forbidden = /process\s*\.\s*env/;
    for (const file of await sourceFiles(TEST)) {
      if (file.endsWith('invariants.test.ts')) continue;
      const text = stripComments(await readFile(file, 'utf8'));
      expect(forbidden.test(text), `${file} reads the process environment`).toBe(false);
    }
  });
});
