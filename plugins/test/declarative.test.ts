/**
 * `adze.test-first` and `adze.docs-sync`: the two purely declarative workflow plugins.
 *
 * There is no hook to fire and no denial to prove here, so what these tests establish is the
 * thing that can actually be wrong about a declarative plugin: the front matter. A command
 * whose `tools` list quietly gained `bash`, or a subagent whose allowlist quietly gained
 * `write`, is a real change in what the plugin can do, and it is invisible in a prose diff.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SlashCommand } from '../../packages/plugin-sdk/src/commands.js';
import { interpolate } from '../../packages/plugin-sdk/src/commands.js';
import type { LoadedPlugin } from '../../packages/plugin-sdk/src/loader.js';
import { loadFirstPartyPlugin } from './support.js';

const WRITING_TOOLS = ['write', 'edit', 'bash', 'task'];

let testFirst: LoadedPlugin;
let docsSync: LoadedPlugin;

beforeAll(async () => {
  testFirst = await loadFirstPartyPlugin('adze-test-first');
  docsSync = await loadFirstPartyPlugin('adze-docs-sync');
});

function command(plugin: LoadedPlugin, name: string): SlashCommand {
  const found = plugin.commands.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no command named '/${name}'`);
  return found;
}

describe('adze.test-first', () => {
  it('loads three commands and nothing procedural', () => {
    expect(testFirst.manifest.id).toBe('adze.test-first');
    expect(testFirst.commands.map((entry) => entry.name).sort()).toEqual([
      'regression-case',
      'test-first',
      'verify',
    ]);
    expect(testFirst.hooks).toEqual([]);
    expect(testFirst.agents).toEqual([]);
  });

  it('gives /test-first the tools the workflow needs and no more', () => {
    // It writes a test and fixes code, so it genuinely needs `edit`, `write`, and `bash`. The
    // list is pinned because it is the plugin's whole security surface.
    expect(command(testFirst, 'test-first').tools).toEqual([
      'read',
      'grep',
      'glob',
      'symbols',
      'edit',
      'write',
      'bash',
    ]);
  });

  it('denies /regression-case the ability to run anything', () => {
    // It writes test files and specifies expectations. It does not need a shell, and a command
    // that can run arbitrary commands to "check" its own output is a command that will.
    const tools = command(testFirst, 'regression-case').tools;
    expect(tools).toContain('write');
    expect(tools).not.toContain('bash');
    expect(tools).not.toContain('task');
  });

  it('gives /verify a shell but no way to change anything', () => {
    const tools = command(testFirst, 'verify').tools;
    expect(tools).toEqual(['read', 'grep', 'bash']);
    expect(tools).not.toContain('write');
    expect(tools).not.toContain('edit');
  });

  it('keeps the confirm-it-fails-for-the-right-reason step explicit', () => {
    // The step that gets skipped, and the reason this is a command rather than a habit. If this
    // wording is ever removed the plugin has lost the thing it was for.
    const template = command(testFirst, 'test-first').template;
    expect(template).toContain('fails for the reason you expect');
    expect(template).toContain('A test that passes before the fix tests nothing');
  });

  it('tells the agent not to run a repository-wide target', () => {
    const template = command(testFirst, 'verify').template;
    expect(template).toContain('Do not run a repository-wide');
  });

  it('records that Vitest 4 removed the basic reporter', () => {
    // A concrete fact that belongs in a prompt rather than in tribal memory: it is a hard
    // startup error, not a warning.
    expect(command(testFirst, 'test-first').template).toContain('basic');
  });
});

describe('adze.docs-sync', () => {
  it('loads one command and one read-only subagent', () => {
    expect(docsSync.manifest.id).toBe('adze.docs-sync');
    expect(docsSync.commands.map((entry) => entry.name)).toEqual(['docs-sync']);
    expect(docsSync.agents.map((entry) => entry.name)).toEqual(['docs-auditor']);
    expect(docsSync.hooks).toEqual([]);
  });

  it('gives docs-auditor no way to edit the documents it audits', () => {
    // An auditor that can edit could report a clean result it produced itself.
    const auditor = docsSync.agents[0];
    if (auditor === undefined) throw new Error('expected a subagent');
    expect(auditor.tools).toEqual(['read', 'grep', 'glob', 'symbols']);
    for (const tool of WRITING_TOOLS) {
      expect(auditor.tools).not.toContain(tool);
    }
    expect(auditor.permissions).toEqual({ filesystem: 'read' });
  });

  it('asks for both directions of drift, not only the overstated one', () => {
    // The understated direction is the one that gets missed and the one that quietly destroys
    // the value of a status document.
    const auditor = docsSync.agents[0];
    if (auditor === undefined) throw new Error('expected a subagent');
    expect(auditor.prompt).toContain('described as absent when it exists');
    expect(auditor.prompt).toContain('both directions');
  });

  it('says plainly why the automatic version does not exist', () => {
    // The honesty rule: a limitation is documented rather than omitted. This plugin is not the
    // plugin the repository wants, and the command says so.
    const template = command(docsSync, 'docs-sync').template;
    expect(template).toContain('edit.post');
    expect(template).toContain('notify-only');
  });
});

describe('a command template is interpolated at invocation, not at load', () => {
  it('is refused when no gate-checked command runner is supplied', async () => {
    // The SDK refuses rather than expanding the `!` block to nothing, and it is right to: a
    // prompt that asks the model to review a diff followed by nothing gets an answer about
    // nothing. Asserted here because it is the failure a surface that forgot to wire
    // `runCommand` will hit, and the diagnostic code (`frontmatter-invalid`) is not where the
    // author will look.
    const outcome = await interpolate(command(docsSync, 'docs-sync'), {});

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.message).toContain('gate-checked command runner');
  });

  it('inlines command output and resolves a trigger when both are provided', async () => {
    const outcome = await interpolate(command(docsSync, 'docs-sync'), {
      runCommand: (shell) => Promise.resolve({ ok: true, text: `[output of ${shell}]` }),
      resolveTrigger: (trigger) =>
        trigger === '@invariants' ? { text: 'THE INVARIANTS' } : undefined,
    });

    if (!outcome.ok) throw new Error(outcome.diagnostics.map((d) => d.message).join('\n'));
    expect(outcome.interpolation.prompt).toContain('[output of git --no-pager diff --cached]');
    expect(outcome.interpolation.prompt).toContain('THE INVARIANTS');
    expect(outcome.interpolation.triggersResolved).toContain('@invariants');
  });

  it('marks a failed command as failed rather than inlining stderr as output', async () => {
    // A model reading command output that failed has to know it failed; silently inlining
    // stderr is how a model concludes a test suite passed.
    const outcome = await interpolate(command(docsSync, 'docs-sync'), {
      runCommand: () => Promise.resolve({ ok: false, text: 'fatal: not a git repository' }),
    });

    if (!outcome.ok) throw new Error('expected interpolation to succeed');
    expect(outcome.interpolation.prompt).toContain('[command failed:');
  });
});
