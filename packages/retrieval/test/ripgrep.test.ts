/**
 * ripgrep layer tests.
 *
 * Two of these are security tests rather than behaviour tests, and they are the
 * reason argument construction is exported:
 *
 * - A query containing shell metacharacters must be *data*. We spawn with an
 *   argument array and never a shell string, and the pattern rides behind `-e` so
 *   a query beginning with `-` cannot become a flag.
 * - The invocation must be reproducible, so `RIPGREP_CONFIG_PATH` cannot inject
 *   flags from a file outside the repository.
 *
 * The rest cover the bounds: a result cap and a wall-clock timeout, both of which
 * must be *marked* when they fire. An unbounded result set is a denial-of-service
 * on a model's context window, and an unmarked truncation is worse than a small
 * result set because it reads as complete.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRipgrepArgs,
  byteOffsetToColumn,
  escapeRegex,
  normalizeRelativePath,
  resolveRipgrepPath,
  ripgrepListFiles,
  ripgrepSearch,
} from '../src/ripgrep.js';
import { createFixture, SEARCH_FILES } from './fixture.js';

const rg = await resolveRipgrepPath();
/**
 * Behaviour tests need the bundled binary. They are skipped rather than failed
 * when it is absent, because "ripgrep did not install" is an environment fact and
 * the graceful-degradation path has its own tests that do not need the binary.
 */
const withRg = rg.ok ? it : it.skip;

function baseOptions(cwd: string) {
  return { cwd, maxResults: 100, timeoutMs: 10_000 } as const;
}

describe('resolveRipgrepPath', () => {
  it('resolves the bundled binary rather than a system rg', async () => {
    const resolved = await resolveRipgrepPath();
    if (!resolved.ok) {
      // The message must be actionable, since it is what a user sees.
      expect(resolved.message).toContain('ripgrep is unavailable');
      return;
    }
    expect(resolved.path).toMatch(/ripgrep/);
    expect(resolved.path).not.toBe('rg');
  });
});

describe('buildRipgrepArgs — the query is data, never syntax', () => {
  it('passes the pattern behind -e so it can never be read as a flag', () => {
    const args = buildRipgrepArgs({
      pattern: '--version',
      literal: true,
      ...baseOptions('/tmp'),
    });
    const at = args.indexOf('-e');
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe('--version');
    // The pattern must not also appear anywhere a parser would read as a flag.
    expect(args.slice(0, at)).not.toContain('--version');
  });

  it('keeps shell metacharacters intact as a single argument', () => {
    // If any of this were assembled into a shell string, these would execute.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: `${IFS}` is a shell expansion under test, not a template placeholder
    const hostile = '$(rm -rf /); `id`; a && b | c > d & e; ${IFS}';
    const args = buildRipgrepArgs({ pattern: hostile, literal: true, ...baseOptions('/tmp') });
    const at = args.indexOf('-e');
    expect(args[at + 1]).toBe(hostile);
    // Exactly one argument carries it: nothing was split on whitespace or `;`.
    expect(args.filter((argument) => argument.includes('rm -rf'))).toHaveLength(1);
  });

  it('ends flag parsing with -- so a path beginning with a dash stays a path', () => {
    const args = buildRipgrepArgs({
      pattern: 'x',
      literal: true,
      paths: ['--not-a-flag/'],
      ...baseOptions('/tmp'),
    });
    const dashDash = args.lastIndexOf('--');
    expect(dashDash).toBeGreaterThan(-1);
    expect(args.slice(dashDash + 1)).toEqual(['--not-a-flag/']);
  });

  it('refuses external config so an outside file cannot add flags', () => {
    const args = buildRipgrepArgs({ pattern: 'x', literal: true, ...baseOptions('/tmp') });
    expect(args).toContain('--no-config');
  });

  it('maps literal to --fixed-strings and regex to neither', () => {
    expect(buildRipgrepArgs({ pattern: 'a.b', literal: true, ...baseOptions('/tmp') })).toContain(
      '--fixed-strings',
    );
    expect(
      buildRipgrepArgs({ pattern: 'a.b', literal: false, ...baseOptions('/tmp') }),
    ).not.toContain('--fixed-strings');
  });

  it('maps case sensitivity to exactly one flag', () => {
    const flags = (sensitivity: 'sensitive' | 'insensitive' | 'smart' | undefined): string[] =>
      buildRipgrepArgs({
        pattern: 'x',
        literal: true,
        ...(sensitivity === undefined ? {} : { caseSensitivity: sensitivity }),
        ...baseOptions('/tmp'),
      }).filter(
        (a) => a.startsWith('--case') || a.startsWith('--ignore-c') || a.startsWith('--smart'),
      );

    expect(flags('sensitive')).toEqual(['--case-sensitive']);
    expect(flags('insensitive')).toEqual(['--ignore-case']);
    expect(flags('smart')).toEqual(['--smart-case']);
    expect(flags(undefined)).toEqual(['--smart-case']);
  });

  it('spells an exclusion as a negated glob', () => {
    const args = buildRipgrepArgs({
      pattern: 'x',
      literal: true,
      include: ['*.ts'],
      exclude: ['*.test.ts'],
      ...baseOptions('/tmp'),
    });
    expect(args).toContain('*.ts');
    expect(args).toContain('!*.test.ts');
  });

  it('adds --no-ignore only when ignore files are opted out of', () => {
    expect(buildRipgrepArgs({ pattern: 'x', literal: true, ...baseOptions('/tmp') })).not.toContain(
      '--no-ignore',
    );
    expect(
      buildRipgrepArgs({
        pattern: 'x',
        literal: true,
        respectGitignore: false,
        ...baseOptions('/tmp'),
      }),
    ).toContain('--no-ignore');
  });

  it('searches the whole cwd when no paths are given', () => {
    const args = buildRipgrepArgs({ pattern: 'x', literal: true, ...baseOptions('/tmp') });
    expect(args[args.length - 1]).toBe('.');
  });
});

describe('normalizeRelativePath', () => {
  it('strips the ./ prefix ripgrep echoes back from the search root', () => {
    // Left in place this cancels the proximity boost, because path segments would
    // compare as ['.', 'src'] against an open file's ['src'].
    expect(normalizeRelativePath('.\\src\\a.ts')).toBe('src/a.ts');
    expect(normalizeRelativePath('./src/a.ts')).toBe('src/a.ts');
    expect(normalizeRelativePath('src/a.ts')).toBe('src/a.ts');
  });

  it('leaves a leading .. alone: it is a real path component', () => {
    expect(normalizeRelativePath('../sibling/a.ts')).toBe('../sibling/a.ts');
  });

  it('does not strip a dotfile name', () => {
    expect(normalizeRelativePath('.github/workflows/ci.yml')).toBe('.github/workflows/ci.yml');
  });
});

describe('byteOffsetToColumn', () => {
  it('is 1-based and matches the byte offset for ASCII', () => {
    expect(byteOffsetToColumn('const a = 1;', 0)).toBe(1);
    expect(byteOffsetToColumn('const a = 1;', 6)).toBe(7);
  });

  it('converts a byte offset past multi-byte text into a character column', () => {
    // 'é' is two bytes in UTF-8 but one UTF-16 code unit. Reporting the byte
    // offset as a column would put the caret one place to the right.
    const line = 'const é = needle;';
    const byteOffset = Buffer.from('const é = ', 'utf8').length;
    expect(byteOffsetToColumn(line, byteOffset)).toBe(line.indexOf('needle') + 1);
  });

  it('clamps an offset beyond the line rather than throwing', () => {
    expect(byteOffsetToColumn('ab', 99)).toBe(3);
  });
});

describe('escapeRegex', () => {
  it('neutralises every metacharacter it claims to', () => {
    expect(escapeRegex('a.b*c+d?e^f$g{h}i(j)k|l[m]n')).toBe(
      String.raw`a\.b\*c\+d\?e\^f\$g\{h\}i\(j\)k\|l\[m\]n`,
    );
  });

  withRg('produces a pattern ripgrep treats as literal text', async () => {
    const fixture = await createFixture({ 'a.ts': 'const x = a.b;\nconst y = axb;\n' });
    try {
      const result = await ripgrepSearch({
        pattern: escapeRegex('a.b'),
        literal: false,
        ...baseOptions(fixture.root),
      });
      expect(result.stderr).toBe('');
      // Unescaped, `a.b` would also match `axb`.
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]?.line).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('ripgrepSearch — literal and regex', () => {
  withRg('finds a literal match and reports path, line, and column', async () => {
    const fixture = await createFixture(SEARCH_FILES, { initGit: true });
    try {
      const result = await ripgrepSearch({
        pattern: 'retryWithBackoff',
        literal: true,
        ...baseOptions(fixture.root),
      });
      const hit = result.matches.find((m) => m.path === 'src/alpha.ts');
      expect(hit).toBeDefined();
      expect(hit?.line).toBe(1);
      expect(hit?.column).toBe('export function '.length + 1);
      expect(hit?.matchedText).toBe('retryWithBackoff');
      // Paths are clean and relative, with no ./ prefix and no backslashes.
      for (const match of result.matches) {
        expect(match.path).not.toMatch(/^\.\//);
        expect(match.path).not.toContain('\\');
      }
    } finally {
      await fixture.cleanup();
    }
  });

  withRg('treats a literal query as text, not as a pattern', async () => {
    const fixture = await createFixture({ 'a.ts': 'const x = 1;\n' });
    try {
      const result = await ripgrepSearch({
        pattern: 'c.nst',
        literal: true,
        ...baseOptions(fixture.root),
      });
      expect(result.matches).toHaveLength(0);
      expect(result.stderr).toBe('');
    } finally {
      await fixture.cleanup();
    }
  });

  withRg('applies a regex when literal is false', async () => {
    const fixture = await createFixture({ 'a.ts': 'const x = 1;\nlet y = 2;\n' });
    try {
      const result = await ripgrepSearch({
        pattern: String.raw`^(const|let)\s+\w+`,
        literal: false,
        ...baseOptions(fixture.root),
      });
      expect(result.matches).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  });

  withRg('reports a pattern that does not compile as information, not an exception', async () => {
    const fixture = await createFixture({ 'a.ts': 'x\n' });
    try {
      // "Your pattern is invalid" is something the caller must act on, so it
      // arrives as a normal result with stderr set rather than as a throw.
      const result = await ripgrepSearch({
        pattern: '(unclosed',
        literal: false,
        ...baseOptions(fixture.root),
      });
      expect(result.matches).toHaveLength(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('ripgrepSearch — globs and case', () => {
  withRg('restricts to an include glob', async () => {
    const fixture = await createFixture(SEARCH_FILES, { initGit: true });
    try {
      const result = await ripgrepSearch({
        pattern: 'needle',
        literal: true,
        include: ['*.md'],
        ...baseOptions(fixture.root),
      });
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches.every((m) => m.path.endsWith('.md'))).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  withRg('removes paths matching an exclude glob', async () => {
    const fixture = await createFixture(SEARCH_FILES, { initGit: true });
    try {
      const all = await ripgrepSearch({
        pattern: 'needle',
        literal: true,
        ...baseOptions(fixture.root),
      });
      expect(all.matches.some((m) => m.path.endsWith('.md'))).toBe(true);

      const excluded = await ripgrepSearch({
        pattern: 'needle',
        literal: true,
        exclude: ['*.md'],
        ...baseOptions(fixture.root),
      });
      expect(excluded.matches.some((m) => m.path.endsWith('.md'))).toBe(false);
      expect(excluded.matches.length).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  });

  withRg('honours explicit case sensitivity in both directions', async () => {
    const fixture = await createFixture({ 'a.ts': 'Needle\nneedle\n' });
    try {
      const sensitive = await ripgrepSearch({
        pattern: 'needle',
        literal: true,
        caseSensitivity: 'sensitive',
        ...baseOptions(fixture.root),
      });
      expect(sensitive.matches).toHaveLength(1);
      expect(sensitive.matches[0]?.line).toBe(2);

      const insensitive = await ripgrepSearch({
        pattern: 'needle',
        literal: true,
        caseSensitivity: 'insensitive',
        ...baseOptions(fixture.root),
      });
      expect(insensitive.matches).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  });

  withRg('smart case is insensitive for a lowercase query and sensitive otherwise', async () => {
    const fixture = await createFixture({ 'a.ts': 'Needle\nneedle\n' });
    try {
      const lower = await ripgrepSearch({
        pattern: 'needle',
        literal: true,
        caseSensitivity: 'smart',
        ...baseOptions(fixture.root),
      });
      expect(lower.matches).toHaveLength(2);

      const mixed = await ripgrepSearch({
        pattern: 'Needle',
        literal: true,
        caseSensitivity: 'smart',
        ...baseOptions(fixture.root),
      });
      expect(mixed.matches).toHaveLength(1);
      expect(mixed.matches[0]?.line).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('ripgrepSearch — .gitignore', () => {
  withRg('skips ignored paths by default', async () => {
    const fixture = await createFixture(SEARCH_FILES, { initGit: true });
    try {
      const result = await ripgrepSearch({
        pattern: 'needle',
        literal: true,
        ...baseOptions(fixture.root),
      });
      const paths = result.matches.map((m) => m.path);
      expect(paths).not.toContain('ignored/secret.ts');
      expect(paths).not.toContain('debug.log');
      expect(paths).toContain('src/beta.ts');
    } finally {
      await fixture.cleanup();
    }
  });

  withRg('sees ignored paths when respectGitignore is false', async () => {
    const fixture = await createFixture(SEARCH_FILES, { initGit: true });
    try {
      const result = await ripgrepSearch({
        pattern: 'needle',
        literal: true,
        respectGitignore: false,
        ...baseOptions(fixture.root),
      });
      const paths = result.matches.map((m) => m.path);
      expect(paths).toContain('ignored/secret.ts');
      expect(paths).toContain('debug.log');
    } finally {
      await fixture.cleanup();
    }
  });

  withRg('skips dotfiles unless hidden files are requested', async () => {
    const fixture = await createFixture({
      '.env.example': 'SECRET=needle\n',
      'a.ts': 'const x = "needle";\n',
    });
    try {
      const visible = await ripgrepSearch({
        pattern: 'needle',
        literal: true,
        ...baseOptions(fixture.root),
      });
      expect(visible.matches.map((m) => m.path)).toEqual(['a.ts']);

      const hidden = await ripgrepSearch({
        pattern: 'needle',
        literal: true,
        includeHidden: true,
        ...baseOptions(fixture.root),
      });
      expect(hidden.matches.map((m) => m.path).sort()).toEqual(['.env.example', 'a.ts']);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('ripgrepSearch — context lines', () => {
  withRg('records surrounding lines when context is requested', async () => {
    const fixture = await createFixture({ 'a.ts': 'one\ntwo\nneedle\nfour\nfive\n' });
    try {
      const result = await ripgrepSearch({
        pattern: 'needle',
        literal: true,
        contextLines: 2,
        ...baseOptions(fixture.root),
      });
      const lines = result.linesByPath.get('a.ts');
      expect(lines?.get(1)).toBe('one');
      expect(lines?.get(2)).toBe('two');
      expect(lines?.get(3)).toBe('needle');
      expect(lines?.get(4)).toBe('four');
      expect(lines?.get(5)).toBe('five');
      // Context lines are not matches.
      expect(result.matches).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  withRg('strips the line terminator from recorded text', async () => {
    const fixture = await createFixture({ 'crlf.ts': 'alpha\r\nneedle\r\nomega\r\n' });
    try {
      const result = await ripgrepSearch({
        pattern: 'needle',
        literal: true,
        ...baseOptions(fixture.root),
      });
      expect(result.matches[0]?.text).toBe('needle');
      expect(result.matches[0]?.text).not.toMatch(/[\r\n]/);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('ripgrepSearch — bounds are marked, never silent', () => {
  withRg('stops at the result cap and says why', async () => {
    const many = Array.from({ length: 500 }, (_, i) => `const needle${i} = ${i};`).join('\n');
    const fixture = await createFixture({ 'big.ts': `${many}\n` });
    try {
      const result = await ripgrepSearch({
        pattern: 'needle',
        literal: true,
        cwd: fixture.root,
        maxResults: 10,
        timeoutMs: 10_000,
      });
      expect(result.matches).toHaveLength(10);
      expect(result.truncated).toBe(true);
      expect(result.truncationReason).toBe('max-results');
    } finally {
      await fixture.cleanup();
    }
  });

  withRg('does not mark truncation when everything fitted', async () => {
    const fixture = await createFixture({ 'a.ts': 'needle\n' });
    try {
      const result = await ripgrepSearch({
        pattern: 'needle',
        literal: true,
        cwd: fixture.root,
        maxResults: 10,
        timeoutMs: 10_000,
      });
      expect(result.matches).toHaveLength(1);
      expect(result.truncated).toBe(false);
      expect(result.truncationReason).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  withRg(
    'a pathological regex hits the timeout instead of hanging',
    async () => {
      // Nested quantifiers over a long run of the same character: the classic
      // catastrophic-backtracking shape. Whatever the engine does with it, the
      // caller gets a bounded answer — either a timeout, a refusal on stderr, or
      // a fast linear result. What must never happen is an unbounded wait, and
      // the test's own timeout is what asserts that.
      const line = `${'a'.repeat(6000)}b`;
      const fixture = await createFixture({ 'evil.txt': `${line}\n` });
      try {
        const startedAt = Date.now();
        const result = await ripgrepSearch({
          pattern: '(a+)+(a+)+(a+)+c',
          literal: false,
          cwd: fixture.root,
          maxResults: 100,
          timeoutMs: 750,
        });
        const elapsed = Date.now() - startedAt;
        // The budget plus process teardown, generously. The point is boundedness.
        expect(elapsed).toBeLessThan(8000);
        if (result.truncated) expect(result.truncationReason).toBe('timeout');
      } finally {
        await fixture.cleanup();
      }
    },
    20_000,
  );

  withRg(
    'an impossibly small budget times out and is marked as a timeout',
    async () => {
      const many = Array.from({ length: 4000 }, (_, i) => `line ${i} needle`).join('\n');
      const files: Record<string, string> = {};
      for (let i = 0; i < 40; i++) files[`src/f${i}.ts`] = `${many}\n`;
      const fixture = await createFixture(files);
      try {
        const result = await ripgrepSearch({
          pattern: 'needle',
          literal: true,
          cwd: fixture.root,
          maxResults: 1_000_000,
          timeoutMs: 1,
        });
        // Either the timer fired, or the search genuinely beat a 1 ms budget. Both
        // are bounded; an unmarked partial result is what would be wrong.
        if (result.matches.length < 160_000) {
          expect(result.truncated).toBe(true);
          expect(result.truncationReason).toBe('timeout');
        }
      } finally {
        await fixture.cleanup();
      }
    },
    20_000,
  );
});

describe('ripgrepSearch — environment hygiene', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  withRg('ignores RIPGREP_CONFIG_PATH so an outside file cannot add flags', async () => {
    const fixture = await createFixture({
      'a.ts': 'needle\n',
      'rc.conf': '--glob=!*.ts\n',
    });
    vi.stubEnv('RIPGREP_CONFIG_PATH', `${fixture.root}/rc.conf`);
    try {
      const result = await ripgrepSearch({
        pattern: 'needle',
        literal: true,
        ...baseOptions(fixture.root),
      });
      // If the config leaked through, `*.ts` would have been excluded.
      expect(result.matches.map((m) => m.path)).toContain('a.ts');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('ripgrepListFiles', () => {
  withRg('lists files under the same ignore rules as a search', async () => {
    const fixture = await createFixture(SEARCH_FILES, { initGit: true });
    try {
      const result = await ripgrepListFiles({
        cwd: fixture.root,
        maxFiles: 100,
        timeoutMs: 10_000,
      });
      expect(result.files).toContain('src/alpha.ts');
      expect(result.files).not.toContain('ignored/secret.ts');
      expect(result.files).not.toContain('debug.log');
      for (const file of result.files) expect(file).not.toMatch(/^\.\//);
    } finally {
      await fixture.cleanup();
    }
  });

  withRg('marks truncation at the file cap', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`f${i}.ts`] = 'x\n';
    const fixture = await createFixture(files);
    try {
      const result = await ripgrepListFiles({
        cwd: fixture.root,
        maxFiles: 5,
        timeoutMs: 10_000,
      });
      expect(result.files).toHaveLength(5);
      expect(result.truncated).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  withRg('applies include and exclude globs', async () => {
    const fixture = await createFixture({ 'a.ts': 'x\n', 'b.py': 'x\n', 'c.md': 'x\n' });
    try {
      const included = await ripgrepListFiles({
        cwd: fixture.root,
        include: ['*.ts', '*.py'],
        maxFiles: 100,
        timeoutMs: 10_000,
      });
      expect([...included.files].sort()).toEqual(['a.ts', 'b.py']);

      const excluded = await ripgrepListFiles({
        cwd: fixture.root,
        exclude: ['*.md'],
        maxFiles: 100,
        timeoutMs: 10_000,
      });
      expect([...excluded.files].sort()).toEqual(['a.ts', 'b.py']);
    } finally {
      await fixture.cleanup();
    }
  });
});
