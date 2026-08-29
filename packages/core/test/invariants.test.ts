/**
 * The architecture invariants, asserted rather than reviewed.
 *
 * `docs/architecture/README.md` §4 and `.cursor/rules/architecture-invariants.mdc`
 * state these as review rules. A review rule holds until the reviewer is tired, so the
 * ones that can be checked mechanically are checked here.
 *
 * Each assertion below corresponds to a documented way this class of project fails:
 * the engine learning about rendering, service packages growing a dependency web, and
 * benchmark code influencing what ships.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(PACKAGE_ROOT, 'src');

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
 * Import specifiers, from `import`/`export ... from` and dynamic `import()`.
 *
 * Comment lines are stripped first. The package's own doc comments contain usage
 * examples that import `@adze/core`, and a scanner that counted those would report the
 * package importing itself — a false positive that would make the whole file untrusted.
 */
async function importSpecifiers(): Promise<readonly { file: string; specifier: string }[]> {
  const found: { file: string; specifier: string }[] = [];
  for (const file of await sourceFiles(SRC)) {
    const text = stripComments(await readFile(file, 'utf8'));
    const relative = file.slice(SRC.length + 1).replaceAll('\\', '/');
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier !== undefined) found.push({ file: relative, specifier });
    }
  }
  return found;
}

function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

describe('invariant 1 — the engine renders nothing', () => {
  it('imports no surface package', async () => {
    // A reverse dependency means the engine renders, which breaks the whole thesis:
    // losing or gaining a surface would then threaten the project.
    const surfaces = ['@adze/cli', '@adze/vscode', '@adze/ide', '@adze/hub', '@adze/sdk'];
    const offenders = (await importSpecifiers()).filter((entry) =>
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
    // Structured events only. A `console.log` in the engine is a rendering decision made
    // in the wrong layer, and it is invisible to every surface that is not a terminal.
    for (const file of await sourceFiles(SRC)) {
      const text = await readFile(file, 'utf8');
      expect(/\bconsole\.(?:log|info|debug|table|dir)\s*\(/.test(text), file).toBe(false);
    }
  });
});

describe('dependency rules', () => {
  it('imports no other service package', async () => {
    // Service packages must not import each other, so each stays individually swappable
    // and testable. `@adze/apply` is the documented exception: `edit` routes through it,
    // and ADR-0005 makes that the point of the tool.
    const allowed = new Set(['@adze/protocol', '@adze/apply']);
    const offenders = (await importSpecifiers()).filter(
      (entry) => entry.specifier.startsWith('@adze/') && !allowed.has(entry.specifier),
    );
    expect(offenders).toEqual([]);
  });

  it('does not import @adze/retrieval', async () => {
    // Held separately from the rule above because it is the live temptation: the search
    // seam in `retrieval.ts` exists precisely so `glob`, `grep`, and `symbols` can be
    // written without it.
    const offenders = (await importSpecifiers()).filter(
      (entry) => entry.specifier.includes('retrieval') && entry.specifier.startsWith('@adze/'),
    );
    expect(offenders).toEqual([]);
  });

  it('imports nothing from bench', async () => {
    const offenders = (await importSpecifiers()).filter(
      (entry) => entry.specifier.includes('bench/') || entry.specifier.startsWith('bench'),
    );
    expect(offenders).toEqual([]);
  });

  it('declares only protocol, apply, and zod as runtime dependencies', async () => {
    const manifest: unknown = JSON.parse(
      await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    );
    const dependencies =
      typeof manifest === 'object' && manifest !== null && 'dependencies' in manifest
        ? manifest.dependencies
        : {};
    expect(Object.keys(dependencies as Record<string, string>).sort()).toEqual([
      '@adze/apply',
      '@adze/protocol',
      'zod',
    ]);
  });

  it('references dependency versions through the catalog', async () => {
    // A version inlined in a package is how fifteen packages end up on four versions of
    // zod. Workspace links are the other permitted form.
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
  it('every relative specifier ends in .js', async () => {
    // `moduleResolution: nodenext`. An extensionless relative import typechecks and fails
    // at runtime, which is the worst place to find out.
    const offenders = (await importSpecifiers()).filter(
      (entry) => entry.specifier.startsWith('.') && !entry.specifier.endsWith('.js'),
    );
    expect(offenders).toEqual([]);
  });
});
