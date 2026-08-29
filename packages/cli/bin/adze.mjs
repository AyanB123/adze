#!/usr/bin/env node
/**
 * The `adze` entry point.
 *
 * Deliberately thin. Everything real lives in `dist/cli.js` so that the CLI's
 * behaviour is testable without spawning a process, and so this file never needs
 * to change.
 *
 * The one thing it does add is a readable failure when the package has not been
 * built. A bare `ERR_MODULE_NOT_FOUND` naming a `dist/` path is the least helpful
 * possible first experience of a repository, and it is the most likely one for
 * someone who cloned and ran the binary before running the build.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'cli.js');

if (!existsSync(entry)) {
  process.stderr.write(
    'adze: @adze/cli has not been built yet.\n\n' +
      '  pnpm install\n' +
      '  pnpm build\n\n' +
      `Expected: ${entry}\n`,
  );
  process.exit(2);
}

// `pathToFileURL`, not the bare path. A dynamic import of an absolute Windows path
// fails with ERR_UNSUPPORTED_ESM_URL_SCHEME because Node reads the drive letter as
// a URL scheme ('c:'), so this line is the difference between the CLI working and
// not working on Windows at all. It is invisible on macOS and Linux, where an
// absolute path happens to be an acceptable specifier.
const { run } = await import(pathToFileURL(entry).href);
process.exitCode = await run(process.argv);
