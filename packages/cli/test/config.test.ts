/**
 * Tests for the full `.adze/config.jsonc` system (M2 remainder).
 *
 * No network, no API key, no spend. Every test passes an explicit `env`,
 * `cwd`, and `home`, so nothing reads the developer's own files or variables —
 * the same hermeticity rule as the providers config tests. A resolution test
 * that reports the machine rather than the code is worse than no test.
 *
 * What is asserted here is the contract from the task:
 *
 * - JSONC comments strip before validation, without touching string contents.
 * - Precedence: flags > env > workspace file > user file > defaults.
 * - Unknown keys warn loudly per file with a dotted path, never silently
 *   ignored — and known values still resolve.
 * - Invalid sandbox/approval values narrow fail-closed (read-only / never),
 *   never to the permissive defaults.
 * - A lower layer never weakens a higher layer's refusal into a grant.
 * - A Microsoft Marketplace gallery URL is rejected, never silently used.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LineReader } from '../src/agent/approval.js';
import { runChat } from '../src/commands/chat.js';
import { runDoctor } from '../src/commands/doctor.js';
import { runRun, type TestHooks } from '../src/commands/run.js';
import {
  applyForbidWins,
  CONFIG_FILENAME,
  ConfigError,
  loadCliConfig,
  resolveWithFlags,
  stripJsoncComments,
} from '../src/config/index.js';
import { EXIT, type Io } from '../src/output.js';
import { CLI_VERSION } from '../src/version.js';

const NO_ENV: Record<string, string | undefined> = {};

let dir = '';
let home = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'adze-cfg-'));
  home = await mkdtemp(join(tmpdir(), 'adze-cfg-home-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function writeConfig(root: string, contents: string): Promise<string> {
  const path = join(root, CONFIG_FILENAME);
  await mkdir(join(root, '.adze'), { recursive: true });
  await writeFile(path, contents, 'utf8');
  return path;
}

function load(options: Parameters<typeof loadCliConfig>[0] = {}): ReturnType<typeof loadCliConfig> {
  return loadCliConfig({ env: NO_ENV, cwd: dir, home, ...options });
}

function capture(): Io & { readonly stdout: () => string; readonly stderr: () => string } {
  let out = '';
  let err = '';
  return {
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    stdout: () => out,
    stderr: () => err,
  };
}

function scriptedReader(lines: readonly (string | undefined)[]): LineReader {
  let index = 0;
  return {
    read: async () => {
      if (index >= lines.length) return undefined;
      const line = lines[index];
      index += 1;
      return line;
    },
    close: () => undefined,
  };
}

function localEndpoint(): TestHooks {
  return {
    resolve: {
      env: {},
      ignoreConfigFiles: true,
      providers: {
        local: {
          kind: 'openai-compatible',
          baseURL: 'http://127.0.0.1:8790/v1',
          defaultModel: 'glm-5.2',
          // No retries: nothing listens, and the test asserts on the preamble
          // printed before the request, not on the retry behaviour.
          maxRetries: 0,
        },
      },
    },
  };
}

describe('JSONC comment stripping', () => {
  it('strips line comments', () => {
    expect(stripJsoncComments('{\n// a comment\n"a": 1\n}')).toBe('{\n\n"a": 1\n}');
  });

  it('strips block comments but keeps their newlines', () => {
    expect(stripJsoncComments('{"a": /* inline */ 1}')).toBe('{"a":  1}');
    // The newline inside the comment survives, so a syntax error after
    // stripping still points at the right line.
    expect(stripJsoncComments('{"a": /* one\ntwo */ 1}')).toBe('{"a": \n 1}');
  });

  it('leaves // inside a string URL alone', () => {
    // The mistake this guards against: splitting "https://..." at the slashes
    // produces invalid JSON, and the error names the parser rather than the file.
    const text = '{"gallery": {"openVsxUrl": "https://open-vsx.org"}} // trailing';
    expect(() => JSON.parse(stripJsoncComments(text)) as unknown).not.toThrow();
    expect(JSON.parse(stripJsoncComments(text)) as { gallery: { openVsxUrl: string } }).toEqual({
      gallery: { openVsxUrl: 'https://open-vsx.org' },
    });
  });

  it('parses a commented config file end to end', async () => {
    await writeConfig(
      dir,
      [
        '{',
        '  // engine choice',
        '  "engine": { "model": "local/glm-5.2" }, /* trailing block */',
        '  "approvals": { "policy": "never" }',
        '}',
        '',
      ].join('\n'),
    );

    const loaded = await load();

    expect(loaded.engineModel).toBe('local/glm-5.2');
    expect(loaded.approvalPolicy).toBe('never');
    expect(loaded.warnings).toHaveLength(0);
  });
});

describe('precedence: flags > env > workspace > user > defaults', () => {
  it('resolves documented defaults with nothing configured', async () => {
    const loaded = await load();

    expect(loaded.sandboxMode).toBe('workspace-write');
    expect(loaded.sandboxModeSource).toBe('default');
    expect(loaded.approvalPolicy).toBe('on-request');
    expect(loaded.approvalPolicySource).toBe('default');
    expect(loaded.engineModel).toBeUndefined();
    expect(loaded.filesRead).toHaveLength(0);
  });

  it('lets the workspace file win over the user file', async () => {
    await writeConfig(home, JSON.stringify({ sandbox: { mode: 'read-only' } }));
    await writeConfig(dir, JSON.stringify({ sandbox: { mode: 'full-access' } }));

    const loaded = await load();

    expect(loaded.sandboxMode).toBe('full-access');
    expect(loaded.sandboxModeSource).toBe('workspace');
  });

  it('keeps a user-level key the workspace file does not mention', async () => {
    await writeConfig(home, JSON.stringify({ engine: { temperature: 0.2 } }));
    await writeConfig(dir, JSON.stringify({ engine: { model: 'local/glm-5.2' } }));

    const loaded = await load();

    expect(loaded.engineModel).toBe('local/glm-5.2');
    expect(loaded.temperature).toBe(0.2);
    expect(loaded.temperatureSource).toBe('user');
  });

  it('lets the environment win over both files', async () => {
    await writeConfig(home, JSON.stringify({ approvals: { policy: 'untrusted' } }));
    await writeConfig(dir, JSON.stringify({ approvals: { policy: 'never' } }));

    const loaded = await load({ env: { ADZE_APPROVAL_POLICY: 'on-request' } });

    expect(loaded.approvalPolicy).toBe('on-request');
    expect(loaded.approvalPolicySource).toBe('env');
  });

  it('lets a flag win over the environment', async () => {
    await writeConfig(dir, JSON.stringify({ sandbox: { mode: 'read-only' } }));

    const loaded = await load({ env: { ADZE_SANDBOX_MODE: 'full-access' } });
    const resolved = resolveWithFlags({ sandbox: 'read-only' }, loaded, dir);

    expect(resolved.invocation.sandboxMode).toBe('read-only');
  });

  it('falls back to config when the flag is absent', async () => {
    await writeConfig(dir, JSON.stringify({ engine: { model: 'local/glm-5.2' } }));

    const loaded = await load();
    const resolved = resolveWithFlags({}, loaded, dir);

    expect(resolved.invocation.modelRef).toBe('local/glm-5.2');
  });

  it('records which files it read, for doctor', async () => {
    await writeConfig(dir, JSON.stringify({ engine: { model: 'local/glm-5.2' } }));

    const loaded = await load();

    expect(loaded.filesRead).toHaveLength(1);
    expect(loaded.filesRead[0]).toContain('.adze');
  });
});

describe('unknown keys warn loudly, never silently ignored', () => {
  it('warns on a top-level typo with the file and the key', async () => {
    await writeConfig(dir, JSON.stringify({ approval: { policy: 'never' } }));

    const loaded = await load();

    // `approval` (singular) is not `approvals`: the policy did not apply.
    expect(loaded.approvalPolicy).toBe('on-request');
    expect(loaded.warnings.some((warning) => warning.includes("'approval'"))).toBe(true);
    expect(loaded.warnings.some((warning) => warning.includes(dir))).toBe(true);
  });

  it('warns on a nested typo with its dotted path', async () => {
    await writeConfig(dir, JSON.stringify({ approvals: { pollicy: 'never' } }));

    const loaded = await load();

    expect(loaded.approvalPolicy).toBe('on-request');
    expect(loaded.warnings.some((warning) => warning.includes('approvals.pollicy'))).toBe(true);
  });

  it('still resolves the known keys beside an unknown one', async () => {
    await writeConfig(dir, JSON.stringify({ engine: { model: 'local/glm-5.2' }, bogus: true }));

    const loaded = await load();

    expect(loaded.engineModel).toBe('local/glm-5.2');
    expect(loaded.warnings).toHaveLength(1);
  });

  it('never warns for $schema', async () => {
    await writeConfig(
      dir,
      JSON.stringify({
        $schema: '../node_modules/@adze/cli/config.schema.json',
        engine: { model: 'local/glm-5.2' },
      }),
    );

    expect((await load()).warnings).toHaveLength(0);
  });
});

describe('invalid values narrow fail-closed, never to the permissive default', () => {
  it("narrows a typo'd sandbox mode to read-only", async () => {
    await writeConfig(dir, JSON.stringify({ sandbox: { mode: 'read-onyl' } }));

    const loaded = await load();

    expect(loaded.sandboxMode).toBe('read-only');
    expect(loaded.warnings.some((warning) => warning.includes('read-only'))).toBe(true);
  });

  it("narrows a typo'd approval policy to never", async () => {
    await writeConfig(dir, JSON.stringify({ approvals: { policy: 'nevr' } }));

    const loaded = await load();

    expect(loaded.approvalPolicy).toBe('never');
    expect(loaded.warnings.some((warning) => warning.includes("'never'"))).toBe(true);
  });

  it('ignores an out-of-range temperature rather than clamping it', async () => {
    await writeConfig(dir, JSON.stringify({ engine: { temperature: 9 } }));

    const loaded = await load();

    expect(loaded.temperature).toBeUndefined();
    expect(loaded.warnings).toHaveLength(1);
  });

  it('ignores an invalid env value and keeps the file value', async () => {
    await writeConfig(dir, JSON.stringify({ approvals: { policy: 'never' } }));

    const loaded = await load({ env: { ADZE_APPROVAL_POLICY: 'sometimes' } });

    expect(loaded.approvalPolicy).toBe('never');
    expect(loaded.approvalPolicySource).toBe('workspace');
    expect(loaded.warnings.some((warning) => warning.includes('ADZE_APPROVAL_POLICY'))).toBe(true);
  });
});

describe('a lower layer never weakens a refusal into a grant', () => {
  it('drops a workspace allow overlapped by a user forbid', async () => {
    await writeConfig(home, JSON.stringify({ commandRules: { forbid: ['rm'] } }));
    await writeConfig(dir, JSON.stringify({ commandRules: { allow: ['rm -rf /tmp/scratch'] } }));

    const loaded = await load();

    expect(loaded.forbidRules.map((rule) => rule.prefix)).toEqual(['rm']);
    expect(loaded.allowRules).toHaveLength(0);
    expect(loaded.warnings.some((warning) => warning.includes('never weakened'))).toBe(true);
  });

  it('lets a user forbid stand over a workspace allow', async () => {
    await writeConfig(home, JSON.stringify({ commandRules: { forbid: ['pnpm'] } }));
    await writeConfig(dir, JSON.stringify({ commandRules: { allow: ['pnpm test'] } }));

    const loaded = await load();

    // The prohibition wins regardless of layer: a checked-in file must not
    // re-allow what the user's standing policy forbade. To allow it, narrow
    // or remove the forbid — the warning names it.
    expect(loaded.allowRules).toHaveLength(0);
    expect(loaded.forbidRules.map((rule) => rule.prefix)).toEqual(['pnpm']);
  });

  it('lets a flag forbid drop a file allow', async () => {
    await writeConfig(dir, JSON.stringify({ commandRules: { allow: ['git push'] } }));

    const loaded = await load();
    const resolved = resolveWithFlags({ forbid: ['git'] }, loaded, dir);

    expect(
      resolved.commandRules.filter((rule) => rule.action === 'allow').map((rule) => rule.prefix),
    ).toEqual([]);
    expect(resolved.warnings.some((warning) => warning.includes("'git push'"))).toBe(true);
  });

  it('lets a file forbid stand over a flag allow, loudly', async () => {
    await writeConfig(dir, JSON.stringify({ commandRules: { forbid: ['git push'] } }));

    const loaded = await load();
    const resolved = resolveWithFlags({ allow: ['git push'] }, loaded, dir);

    // Deliberate friction: the command line cannot quietly re-allow what the
    // file forbids. The warning names the forbidding layer.
    expect(
      resolved.commandRules.filter((rule) => rule.action === 'allow').map((rule) => rule.prefix),
    ).toEqual([]);
    expect(resolved.warnings.some((warning) => warning.includes('workspace'))).toBe(true);
  });

  it('applies forbid-wins on exact collisions at equal rank', () => {
    const warnings: string[] = [];
    const allow = applyForbidWins(
      [{ prefix: 'git push', source: 'workspace' }],
      [{ prefix: 'git push', source: 'workspace' }],
      warnings,
    );

    expect(allow).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });
});

describe('gallery: never the Microsoft Marketplace', () => {
  it('rejects a Marketplace URL from the file with a warning', async () => {
    await writeConfig(
      dir,
      JSON.stringify({ gallery: { openVsxUrl: 'https://marketplace.visualstudio.com/_apis' } }),
    );

    const loaded = await load();

    expect(loaded.galleryOpenVsxUrl).toBeUndefined();
    expect(loaded.warnings.some((warning) => warning.includes('Marketplace'))).toBe(true);
  });

  it('rejects a Marketplace URL from the environment', async () => {
    const loaded = await load({
      env: { ADZE_OPENVSX_URL: 'https://marketplace.visualstudio.com/x' },
    });

    expect(loaded.galleryOpenVsxUrl).toBeUndefined();
    expect(loaded.warnings.some((warning) => warning.includes('ADZE_OPENVSX_URL'))).toBe(true);
  });

  it('accepts an Open VSX URL', async () => {
    await writeConfig(dir, JSON.stringify({ gallery: { openVsxUrl: 'https://open-vsx.org' } }));

    const loaded = await load();

    expect(loaded.galleryOpenVsxUrl).toBe('https://open-vsx.org');
    expect(loaded.galleryOpenVsxUrlSource).toBe('workspace');
  });
});

describe('malformed files', () => {
  it('throws a ConfigError naming the file on bad JSONC syntax', async () => {
    await writeConfig(dir, '{ "engine": ');

    await expect(load()).rejects.toThrow(ConfigError);
    await expect(load()).rejects.toThrow(/not valid JSONC/);
  });

  it('refuses a non-object top level', async () => {
    await writeConfig(dir, '[1, 2, 3]');

    await expect(load()).rejects.toThrow(/must hold a JSON object/);
  });
});

describe('the committed schema artifact', () => {
  it('exists, parses, and covers every top-level config key', async () => {
    // Resolved from this file's location so the test runs from any cwd:
    // test/ -> cli/, where config.schema.json lives.
    const schemaPath = new URL('../config.schema.json', import.meta.url);
    const { readFile: read } = await import('node:fs/promises');
    const schema = JSON.parse(await read(schemaPath, 'utf8')) as {
      properties?: Record<string, unknown>;
    };
    const keys = Object.keys(schema.properties ?? {});

    for (const key of [
      '$schema',
      'engines',
      'engine',
      'sandbox',
      'approvals',
      'commandRules',
      'plugins',
      'workflows',
      'gallery',
      'defaultModel',
    ]) {
      expect(keys).toContain(key);
    }
  });
});

describe('doctor reports resolved config with a source per value', () => {
  it('lists values, sources, files read, and warnings', async () => {
    await writeConfig(
      dir,
      JSON.stringify({
        engine: { model: 'local/glm-5.2' },
        approvals: { policy: 'never' },
        commandRules: { forbid: ['git push'] },
        bogus: true,
      }),
    );

    const io = capture();
    const code = await runDoctor(
      {
        __testHooks: {
          cwd: dir,
          resolve: { env: {}, ignoreConfigFiles: true },
          config: { env: NO_ENV, cwd: dir, home },
        },
      },
      io,
    );

    expect(code).toBe(EXIT.Ok);
    const out = io.stdout();
    expect(out).toContain('Config');
    expect(out).toContain('local/glm-5.2');
    expect(out).toContain('workspace');
    expect(out).toContain('never');
    expect(out).toContain('default');
    expect(out).toContain("'bogus'");
    // Rule rows carry their layer source too, not a blanket "default".
    expect(out).toContain('git push');
    expect(out).toContain('git push (from workspace');
    // The sandbox section follows the same resolved values, not the constants.
    expect(out).toContain('never');
  });

  it('reports an unreadable config file instead of throwing', async () => {
    await writeConfig(dir, '{ "engine": ');

    const io = capture();
    const code = await runDoctor(
      {
        __testHooks: {
          cwd: dir,
          resolve: { env: {}, ignoreConfigFiles: true },
          config: { env: NO_ENV, cwd: dir, home },
        },
      },
      io,
    );

    expect(code).toBe(EXIT.Ok);
    expect(io.stdout()).toContain('unreadable');
  });

  it('exposes per-value sources under --json', async () => {
    await writeConfig(dir, JSON.stringify({ sandbox: { mode: 'read-only' } }));

    const io = capture();
    await runDoctor(
      {
        json: true,
        __testHooks: {
          cwd: dir,
          resolve: { env: {}, ignoreConfigFiles: true },
          config: { env: NO_ENV, cwd: dir, home },
        },
      },
      io,
    );

    const parsed = JSON.parse(io.stdout()) as {
      config: { values: { sandboxMode: { value: string; source: string } } };
      sandbox: { defaultMode: string };
    };
    expect(parsed.config.values.sandboxMode).toEqual({ value: 'read-only', source: 'workspace' });
    expect(parsed.sandbox.defaultMode).toBe('read-only');
  });
});

describe('run and chat honour the config chain', () => {
  it('run prints the effective sandbox and approval line plus config warnings', async () => {
    await writeConfig(
      dir,
      JSON.stringify({
        sandbox: { mode: 'read-onyl' },
        approvals: { policy: 'never' },
        engine: { model: 'local/glm-5.2' },
      }),
    );

    const io = capture();
    // The local endpoint is configured but nothing listens: setup succeeds and
    // the preamble prints, then the first model request fails with exit 1.
    // The assertion is on the preamble, which is what this task owns.
    // `cwd: dir` keeps the trajectory file in the temp dir, not the repo.
    const code = await runRun(
      'hello',
      {
        cwd: dir,
        __testHooks: {
          ...localEndpoint(),
          config: { env: NO_ENV, cwd: dir, home },
        },
      },
      io,
    );

    expect(code).toBe(EXIT.Failure);
    // Fail-closed narrowing applied: the typo became read-only, and the warning
    // trail says so next to the line it changes.
    expect(io.stderr()).toContain('read-only');
    expect(io.stderr()).toContain('approvals: never');
    expect(io.stderr()).toContain('config warning');
  });

  it('chat banner shows the file-resolved mode, and a flag beats the file', async () => {
    await writeConfig(
      dir,
      JSON.stringify({ approvals: { policy: 'never' }, engine: { model: 'local/glm-5.2' } }),
    );

    const fromFile = capture();
    await runChat(
      {
        cwd: dir,
        __testHooks: {
          ...localEndpoint(),
          config: { env: NO_ENV, cwd: dir, home },
          reader: scriptedReader([undefined]),
        },
      },
      fromFile,
    );
    expect(fromFile.stdout()).toContain('approvals: never');

    const fromFlag = capture();
    await runChat(
      {
        cwd: dir,
        approval: 'on-request',
        __testHooks: {
          ...localEndpoint(),
          config: { env: NO_ENV, cwd: dir, home },
          reader: scriptedReader([undefined]),
        },
      },
      fromFlag,
    );
    expect(fromFlag.stdout()).toContain('approvals: on-request');
    expect(fromFlag.stdout()).not.toContain('approvals: never');
  });

  it('/init stamps the running engine version into engines', async () => {
    const io = capture();
    await runChat(
      {
        cwd: dir,
        __testHooks: {
          ...localEndpoint(),
          config: { env: NO_ENV, cwd: dir, home },
          reader: scriptedReader(['/init', undefined]),
        },
      },
      io,
    );

    expect(io.stdout()).toContain('created .adze/config.jsonc');
    const config = await readFile(join(dir, '.adze', 'config.jsonc'), 'utf8');
    expect(config).toContain(`"adze": "${CLI_VERSION}"`);
    expect(config).not.toMatch(/sk-ant|apiKey/i);
  });
});
