/**
 * Temporary fixture trees for retrieval tests.
 *
 * Every fixture is a real directory under the OS temp dir, created per test and
 * removed afterwards. Nothing here touches the network, and nothing writes inside
 * the repository — a test that leaves files in the workspace changes the result of
 * the next `.gitignore`-sensitive test.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Fixture {
  readonly root: string;
  cleanup(): Promise<void>;
}

/**
 * Create a fixture tree from a path → contents map.
 *
 * `initGit` matters more than it looks: ripgrep only honours `.gitignore` when it
 * detects a git repository, so a `.gitignore` test without it silently asserts
 * nothing. Verified empirically rather than assumed — without `git init` the
 * ignored file *is* returned.
 */
export async function createFixture(
  files: Readonly<Record<string, string>>,
  options: { readonly initGit?: boolean } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'adze-retrieval-'));

  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(root, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
  }

  if (options.initGit === true) {
    // Local only. `git init` makes no network call and we never add a remote.
    spawnSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore', shell: false });
  }

  return {
    root,
    cleanup: async (): Promise<void> => {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/** The standard tree most search tests use. */
export const SEARCH_FILES: Readonly<Record<string, string>> = {
  '.gitignore': 'ignored/\n*.log\n',
  'src/alpha.ts': [
    'export function retryWithBackoff(attempts: number): void {',
    '  // needle: retry logic lives here',
    '  for (let i = 0; i < attempts; i++) {',
    '    doWork(i);',
    '  }',
    '}',
    '',
    'export const RETRY_LIMIT = 5;',
    '',
  ].join('\n'),
  'src/beta.ts': [
    'export class UserService {',
    '  findUser(id: string): string {',
    '    return id;',
    '  }',
    '}',
    '',
    'export function needleHelper(): void {}',
    '',
  ].join('\n'),
  'src/nested/gamma.py': ['def retry_with_backoff(attempts):', '    return attempts', ''].join(
    '\n',
  ),
  'docs/guide.md': '# Guide\n\nSee needle in the source.\n',
  'ignored/secret.ts': 'export const needle = "should not be found";\n',
  'debug.log': 'needle appears in a log file too\n',
};
