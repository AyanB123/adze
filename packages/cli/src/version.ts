/**
 * Version and engine constants.
 *
 * The version is read from `package.json` at runtime rather than baked in by the
 * build, so `adze --version` cannot disagree with the package a user installed —
 * which is exactly the kind of mismatch that makes a bug report unusable.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Must match `engines.node` in the root `package.json`. */
export const MINIMUM_NODE_VERSION = '22.12.0';

function readVersion(): string {
  try {
    // Resolved from this module's own URL, so it works from `dist/` and from
    // `src/` under vitest without a build-time constant to keep in sync.
    const path = fileURLToPath(new URL('../package.json', import.meta.url));
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof raw === 'object' && raw !== null) {
      const version = (raw as Record<string, unknown>).version;
      if (typeof version === 'string' && version.length > 0) return version;
    }
  } catch {
    // Fall through. A missing or unreadable package.json is not worth crashing a
    // diagnostic command over.
  }
  return '0.0.0-unknown';
}

export const CLI_VERSION = readVersion();
