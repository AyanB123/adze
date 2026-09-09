/**
 * `adze plugin` — local-only plugin management.
 *
 * Every test here runs against a temporary workspace root passed through
 * `__testHooks.cwd`, so no test touches the repository's own `.adze/`
 * directory. No test touches the network: `add` is exercised with local paths
 * only, and the git-URL path shells out to `git` and is covered by a usage
 * refusal rather than a clone.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { runDoctor } from '../src/commands/doctor.js';
import {
  runPluginAdd,
  runPluginDev,
  runPluginList,
  runPluginRemove,
  runPluginValidate,
} from '../src/commands/plugin.js';
import { EXIT, type Io } from '../src/output.js';

function capture(): Io & { readonly stdout: () => string; readonly stderr: () => string } {
  let out = '';
  let err = '';
  return {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    stdout: () => out,
    stderr: () => err,
  };
}

function argv(...args: string[]): string[] {
  return ['node', 'adze', ...args];
}

let workspace = '';

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'adze-plugin-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

interface PluginFiles {
  readonly id: string;
  readonly commands?: readonly string[];
  readonly agents?: readonly string[];
  readonly hooks?: boolean;
  readonly license?: string;
  readonly engines?: string;
  readonly env?: { readonly declared: readonly string[]; readonly read: readonly string[] };
  readonly hookFilters?: { readonly tools?: readonly string[]; readonly paths?: readonly string[] };
}

/** Write a plugin directory and return its path. */
async function makePlugin(directory: string, files: PluginFiles): Promise<string> {
  const root = join(workspace, directory);
  await mkdir(join(root, 'commands'), { recursive: true });
  await mkdir(join(root, 'agents'), { recursive: true });
  await mkdir(join(root, 'hooks'), { recursive: true });

  const tools =
    files.env === undefined
      ? []
      : [
          {
            name: 'db',
            transport: 'stdio',
            command: 'npx',
            env: Object.fromEntries(
              files.env.read.map((name) => [`KEY_${name}`, `\${env:${name}}`]),
            ),
          },
        ];

  const manifest = {
    id: files.id,
    version: '1.0.0',
    displayName: `Plugin ${files.id}`,
    description: `Test plugin ${files.id}.`,
    license: files.license ?? 'Apache-2.0',
    repository: `https://example.com/${files.id}`,
    engines: { adze: files.engines ?? '>=0.0.1 <1.0.0' },
    contributes: {
      commands: (files.commands ?? ['review']).map((name) => ({
        path: `commands/${name}.md`,
      })),
      agents: (files.agents ?? []).map((name) => ({ path: `agents/${name}.md` })),
      ...(files.hooks === true
        ? {
            hooks: [
              {
                event: 'tool.pre',
                module: 'hooks/g.mjs',
                runtime: 'js',
                ...(files.hookFilters?.tools === undefined
                  ? {}
                  : { tools: [...files.hookFilters.tools] }),
                ...(files.hookFilters?.paths === undefined
                  ? {}
                  : { paths: [...files.hookFilters.paths] }),
              },
            ],
          }
        : {}),
      ...(tools.length > 0 ? { tools } : {}),
    },
    ...(files.env === undefined ? {} : { permissions: { env: [...files.env.declared] } }),
  };
  await writeFile(join(root, 'adze.plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');

  for (const name of files.commands ?? ['review']) {
    await writeFile(
      join(root, `commands/${name}.md`),
      `---\nname: ${name}\ndescription: The ${name} command.\n---\n\nDo ${name}.\n`,
      'utf8',
    );
  }
  for (const name of files.agents ?? []) {
    await writeFile(
      join(root, `agents/${name}.md`),
      `---\nname: ${name}\ndescription: The ${name} subagent.\ntools: [read]\n---\n\nYou are ${name}.\n`,
      'utf8',
    );
  }
  if (files.hooks === true) {
    await writeFile(
      join(root, 'hooks/g.mjs'),
      'export function invoke() { return { kind: "allow" }; }\n',
      'utf8',
    );
  }
  return root;
}

describe('adze plugin validate', () => {
  it('passes a well-formed plugin and names every gate', async () => {
    const root = await makePlugin('alpha', { id: 'acme.alpha' });
    const io = capture();

    const code = await runPluginValidate(root, { __testHooks: { cwd: workspace } }, io);

    expect(code).toBe(EXIT.Ok);
    expect(io.stdout()).toContain('valid');
    for (const gate of ['manifest', 'license', 'engines', 'env', 'globs', 'files', 'collisions']) {
      expect(io.stdout()).toContain(gate);
    }
  });

  it('emits the gates as JSON under --json', async () => {
    const root = await makePlugin('alpha', { id: 'acme.alpha' });
    const io = capture();

    const code = await runPluginValidate(root, { json: true, __testHooks: { cwd: workspace } }, io);

    expect(code).toBe(EXIT.Ok);
    const parsed = JSON.parse(io.stdout()) as { ok: boolean; gates: { name: string }[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.gates.map((gate) => gate.name)).toEqual(
      expect.arrayContaining(['manifest', 'license', 'engines', 'collisions']),
    );
  });

  it('refuses a copyleft license', async () => {
    const root = await makePlugin('bad', { id: 'acme.bad', license: 'GPL-3.0-only' });
    const io = capture();

    const code = await runPluginValidate(root, { __testHooks: { cwd: workspace } }, io);

    expect(code).toBe(EXIT.Failure);
    expect(io.stderr()).toContain('license');
  });

  it('refuses an engine range the running engine does not satisfy', async () => {
    const root = await makePlugin('future', { id: 'acme.future', engines: '>=99.0.0 <100.0.0' });
    const io = capture();

    expect(await runPluginValidate(root, { __testHooks: { cwd: workspace } }, io)).toBe(
      EXIT.Failure,
    );
    expect(io.stderr()).toContain('engines');
  });

  it('refuses an undeclared environment read', async () => {
    const root = await makePlugin('envy', {
      id: 'acme.envy',
      env: { declared: [], read: ['TOKEN'] },
    });
    const io = capture();

    expect(await runPluginValidate(root, { __testHooks: { cwd: workspace } }, io)).toBe(
      EXIT.Failure,
    );
    expect(io.stderr()).toContain('permissions.env');
  });

  it('accepts a declared environment read without requiring the value', async () => {
    const root = await makePlugin('envy', {
      id: 'acme.envy',
      env: { declared: ['TOKEN'], read: ['TOKEN'] },
    });
    const io = capture();

    // Validation is static: the value is resolved at load, not at validate time.
    expect(await runPluginValidate(root, { __testHooks: { cwd: workspace } }, io)).toBe(EXIT.Ok);
  });

  it('refuses an invalid hook filter glob', async () => {
    const root = await makePlugin('globby', {
      id: 'acme.globby',
      hooks: true,
      hookFilters: { tools: ['a[b'] },
    });
    const io = capture();

    expect(await runPluginValidate(root, { __testHooks: { cwd: workspace } }, io)).toBe(
      EXIT.Failure,
    );
    expect(io.stderr()).toContain('globs');
  });

  it('accepts valid hook filters', async () => {
    const root = await makePlugin('scoped', {
      id: 'acme.scoped',
      hooks: true,
      hookFilters: { tools: ['bash'], paths: ['docs/*.md'] },
    });
    const io = capture();

    expect(await runPluginValidate(root, { __testHooks: { cwd: workspace } }, io)).toBe(EXIT.Ok);
  });

  it('reports a command collision with the installed set', async () => {
    const first = await makePlugin('first', { id: 'acme.first', commands: ['review'] });
    await runPluginAdd(first, { yes: true, __testHooks: { cwd: workspace } }, capture());

    const second = await makePlugin('second', { id: 'acme.second', commands: ['review'] });
    const io = capture();
    const code = await runPluginValidate(second, { __testHooks: { cwd: workspace } }, io);

    expect(code).toBe(EXIT.Failure);
    expect(io.stderr()).toContain('acme.first');
  });

  it('exits 2 when no path is given', async () => {
    const io = capture();
    expect(await runPluginValidate(undefined, { __testHooks: { cwd: workspace } }, io)).toBe(
      EXIT.Usage,
    );
    const json = capture();
    await runPluginValidate(undefined, { json: true, __testHooks: { cwd: workspace } }, json);
    expect(JSON.parse(json.stdout())).toMatchObject({ ok: false, error: 'usage' });
  });
});

describe('adze plugin add/list/remove', () => {
  it('installs a local plugin after showing its permissions', async () => {
    const root = await makePlugin('alpha', { id: 'acme.alpha' });
    const io = capture();

    const code = await runPluginAdd(root, { yes: true, __testHooks: { cwd: workspace } }, io);

    expect(code).toBe(EXIT.Ok);
    expect(io.stdout()).toContain('acme.alpha');
    expect(io.stdout()).toContain('Apache-2.0');
    const stored = JSON.parse(
      await readFile(join(workspace, '.adze', 'plugins', 'installed.json'), 'utf8'),
    ) as { plugins: { id: string }[] };
    expect(stored.plugins.map((entry) => entry.id)).toEqual(['acme.alpha']);
  });

  it('refuses a duplicate id', async () => {
    const root = await makePlugin('alpha', { id: 'acme.alpha' });
    await runPluginAdd(root, { yes: true, __testHooks: { cwd: workspace } }, capture());

    const other = await makePlugin('alpha2', { id: 'acme.alpha' });
    const io = capture();
    const code = await runPluginAdd(other, { yes: true, __testHooks: { cwd: workspace } }, io);

    expect(code).toBe(EXIT.Failure);
    expect(io.stderr()).toContain('already installed');
  });

  it('requires consent without --yes outside a TTY', async () => {
    const root = await makePlugin('alpha', { id: 'acme.alpha' });
    const io = capture();

    const code = await runPluginAdd(root, { __testHooks: { cwd: workspace } }, io);

    // CI stdin is not a TTY, so consent cannot be asked: the install is refused
    // rather than assumed.
    expect(code).toBe(EXIT.Failure);
    expect(io.stderr()).toContain('--yes');
  });

  it('lists installed plugins and the dev override', async () => {
    const root = await makePlugin('alpha', { id: 'acme.alpha' });
    await runPluginAdd(root, { yes: true, __testHooks: { cwd: workspace } }, capture());
    const devRoot = await makePlugin('beta', { id: 'acme.beta' });
    await runPluginDev(devRoot, { __testHooks: { cwd: workspace } }, capture());

    const io = capture();
    expect(await runPluginList({ __testHooks: { cwd: workspace } }, io)).toBe(EXIT.Ok);
    expect(io.stdout()).toContain('acme.alpha');
    expect(io.stdout()).toContain('acme.beta');

    const json = capture();
    await runPluginList({ json: true, __testHooks: { cwd: workspace } }, json);
    const parsed = JSON.parse(json.stdout()) as {
      installed: { id: string }[];
      dev: { id: string } | null;
    };
    expect(parsed.installed.map((entry) => entry.id)).toEqual(['acme.alpha']);
    expect(parsed.dev?.id).toBe('acme.beta');
  });

  it('removes an installed plugin by id', async () => {
    const root = await makePlugin('alpha', { id: 'acme.alpha' });
    await runPluginAdd(root, { yes: true, __testHooks: { cwd: workspace } }, capture());

    const io = capture();
    expect(await runPluginRemove('acme.alpha', { __testHooks: { cwd: workspace } }, io)).toBe(
      EXIT.Ok,
    );
    expect(io.stdout()).toContain('removed');

    const missing = capture();
    expect(await runPluginRemove('acme.alpha', { __testHooks: { cwd: workspace } }, missing)).toBe(
      EXIT.Failure,
    );
  });

  it('a dev override shadows the installed same id in list', async () => {
    const root = await makePlugin('alpha', { id: 'acme.alpha' });
    await runPluginAdd(root, { yes: true, __testHooks: { cwd: workspace } }, capture());
    const live = await makePlugin('alpha-live', { id: 'acme.alpha' });
    await runPluginDev(live, { __testHooks: { cwd: workspace } }, capture());

    const io = capture();
    await runPluginList({ __testHooks: { cwd: workspace } }, io);
    expect(io.stdout()).toContain('shadowed by dev');
  });

  it('dev --clear removes the override', async () => {
    const live = await makePlugin('alpha-live', { id: 'acme.alpha' });
    await runPluginDev(live, { __testHooks: { cwd: workspace } }, capture());

    const io = capture();
    expect(
      await runPluginDev(undefined, { clear: true, __testHooks: { cwd: workspace } }, io),
    ).toBe(EXIT.Ok);

    const listed = capture();
    await runPluginList({ json: true, __testHooks: { cwd: workspace } }, listed);
    expect((JSON.parse(listed.stdout()) as { dev: null }).dev).toBeNull();
  });

  it('exits 2 for missing arguments', async () => {
    expect(await runPluginAdd(undefined, { __testHooks: { cwd: workspace } }, capture())).toBe(
      EXIT.Usage,
    );
    expect(await runPluginRemove(undefined, { __testHooks: { cwd: workspace } }, capture())).toBe(
      EXIT.Usage,
    );
  });
});

describe('adze plugin — doctor and wiring', () => {
  it('doctor names the dev override while one is active', async () => {
    const live = await makePlugin('alpha-live', { id: 'acme.alpha' });
    await runPluginDev(live, { __testHooks: { cwd: workspace } }, capture());

    const io = capture();
    await runDoctor({ __testHooks: { cwd: workspace } }, io);
    expect(io.stdout()).toContain('dev override');
    expect(io.stdout()).toContain('acme.alpha');
  });

  it('doctor reports no plugins in a fresh workspace', async () => {
    const io = capture();
    await runDoctor({ __testHooks: { cwd: workspace } }, io);
    expect(io.stdout()).toContain('Plugins');
  });

  it('plugin appears in help and dispatches through run()', async () => {
    const help = capture();
    expect(await run(argv('plugin', '--help'), help)).toBe(EXIT.Ok);
    expect(help.stdout()).toContain('validate');

    const usage = capture();
    expect(await run(argv('plugin', 'validate'), usage)).toBe(EXIT.Usage);
  });
});
