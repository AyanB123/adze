/**
 * `adze.arch-invariants`: each dependency-graph rule, and the cases that must not deny.
 *
 * The negative cases matter as much as the denials. This plugin fires on import specifiers,
 * which appear in almost every source file in the repository, so a rule that is slightly too
 * broad would block ordinary work — and the cheapest response to a policy hook that blocks
 * ordinary work is to uninstall it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { LoadedPlugin } from '../../packages/plugin-sdk/src/loader.js';
import { dispatch, harness, loadFirstPartyPlugin } from './support.js';

let plugin: LoadedPlugin;

beforeAll(async () => {
  plugin = await loadFirstPartyPlugin('adze-arch-invariants');
});

async function adding(path: string, replace: string) {
  const h = harness(plugin);
  const outcome = await dispatch(h, 'edit', { path, edits: [{ search: 'PLACEHOLDER', replace }] });
  return { outcome, seen: h.seen() };
}

describe('the plugin loads through the real loader', () => {
  it('registers both hooks', () => {
    expect(plugin.manifest.id).toBe('adze.arch-invariants');
    expect(plugin.hooks.map((hook) => hook.event).sort()).toEqual(['edit.pre', 'tool.pre']);
  });
});

describe('the engine may not import a surface', () => {
  it.each(['cli', 'vscode', 'ide', 'hub'])('denies core importing @adze/%s', async (surface) => {
    const { outcome, seen } = await adding(
      'packages/core/src/turn.ts',
      `import { render } from '@adze/${surface}';`,
    );

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.source).toBe('hook');
    expect(outcome.reason).toContain('renders nothing');
    expect(seen).toBeUndefined();
  });

  it('points at the protocol as the correct route', async () => {
    // The most valuable part of the denial: not "you may not", but "here is what to do".
    const { outcome } = await adding(
      'packages/core/src/turn.ts',
      `import { prompt } from '@adze/cli';`,
    );
    if (outcome.kind !== 'denied') throw new Error('expected a denial');
    expect(outcome.reason).toContain('@adze/protocol');
  });

  it('denies core importing the sdk, which reverses the graph', async () => {
    const { outcome } = await adding(
      'packages/core/src/engine.ts',
      `import { createClient } from '@adze/sdk';`,
    );
    expect(outcome.kind).toBe('denied');
  });

  it('allows core importing the protocol', async () => {
    const { outcome } = await adding(
      'packages/core/src/turn.ts',
      `import type { ToolResult } from '@adze/protocol';`,
    );
    expect(outcome.kind).toBe('executed');
  });

  it('allows a surface importing core', async () => {
    // The dependency runs this way round.
    const { outcome } = await adding(
      'packages/cli/src/run.ts',
      `import { Engine } from '@adze/core';`,
    );
    expect(outcome.kind).toBe('executed');
  });
});

describe('the protocol depends on nothing but zod', () => {
  it('denies an outside dependency', async () => {
    const { outcome, seen } = await adding(
      'packages/protocol/src/events.ts',
      `import { parse } from 'yaml';`,
    );

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.reason).toContain('not a contract');
    expect(seen).toBeUndefined();
  });

  it('allows zod', async () => {
    const { outcome } = await adding('packages/protocol/src/events.ts', `import { z } from 'zod';`);
    expect(outcome.kind).toBe('executed');
  });

  it('allows a relative import', async () => {
    const { outcome } = await adding(
      'packages/protocol/src/index.ts',
      `export { EventSchema } from './events.js';`,
    );
    expect(outcome.kind).toBe('executed');
  });

  it('allows a node builtin', async () => {
    const { outcome } = await adding(
      'packages/protocol/src/paths.ts',
      `import { join } from 'node:path';`,
    );
    expect(outcome.kind).toBe('executed');
  });
});

describe('service packages may not import each other', () => {
  it.each([
    ['apply', 'retrieval'],
    ['providers', 'sandbox'],
    ['mcp', 'apply'],
    ['retrieval', 'mcp'],
  ])('denies %s importing @adze/%s', async (owner, imported) => {
    const { outcome, seen } = await adding(
      `packages/${owner}/src/index.ts`,
      `import { thing } from '@adze/${imported}';`,
    );

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.reason).toContain('individually swappable');
    expect(seen).toBeUndefined();
  });

  it('allows a service importing core', async () => {
    const { outcome } = await adding(
      'packages/apply/src/apply.ts',
      `import type { Effect } from '@adze/core';`,
    );
    expect(outcome.kind).toBe('executed');
  });

  it('allows a service importing itself by relative path', async () => {
    const { outcome } = await adding(
      'packages/apply/src/apply.ts',
      `import { match } from './match.js';`,
    );
    expect(outcome.kind).toBe('executed');
  });
});

describe('nothing in product code imports from bench/', () => {
  it('denies a relative reach into bench', async () => {
    const { outcome, seen } = await adding(
      'packages/core/src/telemetry.ts',
      `import { suite } from '../../../bench/harness/src/index.js';`,
    );

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.reason).toContain('stopped measuring the product');
    expect(seen).toBeUndefined();
  });

  it('allows bench importing bench', async () => {
    const { outcome } = await adding(
      'bench/harness/src/run.ts',
      `import { cases } from '../../suites/apply-bench/index.js';`,
    );
    expect(outcome.kind).toBe('executed');
  });
});

describe('@adze/sdk is for surfaces', () => {
  it('denies a package inside the engine importing it', async () => {
    const { outcome } = await adding(
      'packages/retrieval/src/index.ts',
      `import { createClient } from '@adze/sdk';`,
    );
    expect(outcome.kind).toBe('denied');
  });

  it.each(['packages/cli/src/main.ts', 'apps/vscode/src/extension.ts', 'examples/demo/src/run.ts'])(
    'allows %s',
    async (path) => {
      const { outcome } = await adding(path, `import { createClient } from '@adze/sdk';`);
      expect(outcome.kind).toBe('executed');
    },
  );

  it('allows the sdk importing itself', async () => {
    const { outcome } = await adding(
      'packages/sdk/src/index.ts',
      `export { createClient } from '@adze/sdk';`,
    );
    expect(outcome.kind).toBe('executed');
  });
});

describe('the engine emits no display output', () => {
  it.each(['chalk', 'picocolors', 'kleur', 'ansi-colors'])(
    'denies core importing %s',
    async (library) => {
      const { outcome, seen } = await adding(
        'packages/core/src/report.ts',
        `import colors from '${library}';`,
      );

      expect(outcome.kind).toBe('denied');
      if (outcome.kind !== 'denied') return;
      expect(outcome.reason).toContain('surfaces render them');
      expect(seen).toBeUndefined();
    },
  );

  it('denies a terminal escape sequence written as source text', async () => {
    const { outcome } = await adding(
      'packages/core/src/report.ts',
      String.raw`const bold = '\u001b[1m';`,
    );
    expect(outcome.kind).toBe('denied');
  });

  it('denies the hex form too', async () => {
    const { outcome } = await adding(
      'packages/core/src/report.ts',
      String.raw`const reset = '\x1b[0m';`,
    );
    expect(outcome.kind).toBe('denied');
  });

  it('allows a surface using colour, which is its job', async () => {
    const { outcome } = await adding('packages/cli/src/print.ts', `import pc from 'picocolors';`);
    expect(outcome.kind).toBe('executed');
  });
});

describe('the hook stays out of the way otherwise', () => {
  it('ignores a markdown file quoting a forbidden import', async () => {
    // This repository's documentation quotes forbidden imports in order to explain why
    // they are forbidden. Denying that would make the architecture docs unwritable.
    const { outcome } = await adding(
      'docs/architecture/README.md',
      "Never write `import { render } from '@adze/cli';` inside the engine.",
    );
    expect(outcome.kind).toBe('executed');
  });

  it('ignores a file outside packages/, apps/, and bench/', async () => {
    const { outcome } = await adding('scripts/tool.mjs', `import { x } from 'anything';`);
    expect(outcome.kind).toBe('executed');
  });

  it('checks a whole-file write as well', async () => {
    // `edit.pre` reports a whole-file write as `edits: []`, so a `write` would otherwise
    // be an unchecked route past every rule above. See plugins/FINDINGS.md finding 1.
    const h = harness(plugin);
    const outcome = await dispatch(h, 'write', {
      path: 'packages/core/src/new.ts',
      content: "import { render } from '@adze/vscode';\nexport const x = 1;\n",
    });

    expect(outcome.kind).toBe('denied');
    expect(h.seen()).toBeUndefined();
  });

  it('allows an edit with no imports at all', async () => {
    const { outcome } = await adding('packages/core/src/turn.ts', 'const steps = 12;');
    expect(outcome.kind).toBe('executed');
  });
});
