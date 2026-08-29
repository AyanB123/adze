#!/usr/bin/env node
/**
 * Generate the published JSON Schema documents for the Adze protocol.
 *
 *   node scripts/generate-json-schema.mjs            # write
 *   node scripts/generate-json-schema.mjs --check    # verify, write nothing
 *
 * The output is committed. It has to be: `package.json` lists `src/generated` in
 * `files`, so the documents must exist in the published tarball, and a consumer
 * validating Adze messages from Python should not have to run our build to get a
 * schema. `--check` is what makes committing them safe — `test/schema.test.ts`
 * fails when a schema changed and the artifacts were not regenerated, so the two
 * cannot drift apart silently.
 *
 * Reads from `dist/`, so run `pnpm build` first. Reading the built output rather
 * than the source is deliberate: it means these documents describe the code that
 * actually ships, not a TypeScript file that might not compile.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const outDir = join(packageRoot, 'src', 'generated');
const distEntry = join(packageRoot, 'dist', 'index.js');

let protocol;
try {
  protocol = await import(`file://${distEntry.replaceAll('\\', '/')}`);
} catch (cause) {
  console.error(
    `Could not load ${distEntry}\n` +
      `Run 'pnpm --filter @adze/protocol build' first — this script reads the built ` +
      `output so the generated schemas describe the code that actually ships.\n` +
      `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
  process.exit(1);
}

const check = process.argv.includes('--check');
const schemas = protocol.protocolJsonSchemas();
const names = Object.keys(schemas).sort();

mkdirSync(outDir, { recursive: true });

let drifted = 0;
for (const name of names) {
  const file = join(outDir, `${name}.json`);
  // Two-space indent with a trailing newline: matches the repository's formatter,
  // so a generated file never shows up as a lint finding.
  const next = `${JSON.stringify(schemas[name], null, 2)}\n`;

  if (check) {
    let current = null;
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      current = null;
    }
    if (current !== next) {
      drifted++;
      console.error(current === null ? `missing: ${name}.json` : `stale:   ${name}.json`);
    }
    continue;
  }

  writeFileSync(file, next, 'utf8');
}

if (check) {
  if (drifted > 0) {
    console.error(
      `\n${drifted} generated schema file(s) are missing or stale.\n` +
        `Run: pnpm --filter @adze/protocol schema:generate`,
    );
    process.exit(1);
  }
  console.error(`${names.length} generated schema file(s) up to date.`);
} else {
  console.error(`Wrote ${names.length} schema file(s) to src/generated/`);
}
