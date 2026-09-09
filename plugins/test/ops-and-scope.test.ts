/**
 * `adze.ops-runbook` and `adze.narrow-scope`: the two new declarative workflow plugins.
 *
 * No hook to fire and no denial to prove, so what these tests pin is the front matter —
 * the tool allowlists that are each plugin's whole security surface — plus the property
 * that a command with a `!` block is refused without a gate-checked runner rather than
 * expanded to nothing.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { narrowSubagent, type ParentGrant } from '../../packages/plugin-sdk/src/agents.js';
import type { SlashCommand } from '../../packages/plugin-sdk/src/commands.js';
import { interpolate } from '../../packages/plugin-sdk/src/commands.js';
import type { LoadedPlugin } from '../../packages/plugin-sdk/src/loader.js';
import { loadFirstPartyPlugin } from './support.js';

let ops: LoadedPlugin;
let scope: LoadedPlugin;

beforeAll(async () => {
  ops = await loadFirstPartyPlugin('adze-ops-runbook');
  scope = await loadFirstPartyPlugin('adze-narrow-scope');
});

function command(plugin: LoadedPlugin, name: string): SlashCommand {
  const found = plugin.commands.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no command named '/${name}'`);
  return found;
}

describe('adze.ops-runbook loads', () => {
  it('parses two commands and one read-only subagent', () => {
    expect(ops.manifest.id).toBe('adze.ops-runbook');
    expect(ops.commands.map((entry) => entry.name).sort()).toEqual([
      'deploy-checklist',
      'rollback-plan',
    ]);
    expect(ops.agents.map((entry) => entry.name)).toEqual(['ops-reviewer']);
    expect(ops.hooks).toEqual([]);
  });

  it('gives /deploy-checklist a shell but no way to change files', () => {
    const tools = command(ops, 'deploy-checklist').tools;
    expect(tools).toEqual(['read', 'grep', 'glob', 'bash']);
    expect(tools).not.toContain('write');
    expect(tools).not.toContain('edit');
    expect(tools).not.toContain('task');
  });

  it('gives /rollback-plan no task delegation', () => {
    const tools = command(ops, 'rollback-plan').tools;
    expect(tools).toContain('bash');
    expect(tools).not.toContain('task');
    expect(tools).not.toContain('write');
    expect(tools).not.toContain('edit');
  });

  it('gives ops-reviewer no way to run or change anything', () => {
    const reviewer = ops.agents[0];
    if (reviewer === undefined) throw new Error('expected a subagent');
    expect(reviewer.tools).toEqual(['read', 'grep', 'glob', 'symbols']);
    for (const tool of ['write', 'edit', 'bash', 'task']) {
      expect(reviewer.tools).not.toContain(tool);
    }
    expect(reviewer.permissions).toEqual({ filesystem: 'read' });
    expect(reviewer.maxSteps).toBe(25);
  });

  it('says approvals are a human act', () => {
    expect(command(ops, 'deploy-checklist').template).toContain('human approves');
    expect(command(ops, 'deploy-checklist').template).toContain('Do not deploy');
    expect(command(ops, 'rollback-plan').template).toContain('Do not execute');
  });

  it('never prints a secret value', () => {
    expect(command(ops, 'deploy-checklist').template).toContain('Never print a secret value');
  });
});

describe('adze.narrow-scope loads', () => {
  it('parses two commands and one read-only subagent', () => {
    expect(scope.manifest.id).toBe('adze.narrow-scope');
    expect(scope.commands.map((entry) => entry.name).sort()).toEqual([
      'plan-small',
      'split-commit',
    ]);
    expect(scope.agents.map((entry) => entry.name)).toEqual(['scope-auditor']);
    expect(scope.hooks).toEqual([]);
  });

  it('gives /plan-small no shell and no writes', () => {
    // Planning reads. A plan that can run commands stops being a plan.
    expect(command(scope, 'plan-small').tools).toEqual(['read', 'grep', 'glob']);
  });

  it('gives /split-commit a shell but no way to stage or commit', () => {
    const tools = command(scope, 'split-commit').tools;
    expect(tools).toEqual(['read', 'grep', 'bash']);
    expect(tools).not.toContain('write');
    expect(tools).not.toContain('edit');
  });

  it('gives scope-auditor no way to edit what it audits', () => {
    const auditor = scope.agents[0];
    if (auditor === undefined) throw new Error('expected a subagent');
    expect(auditor.tools).toEqual(['read', 'grep', 'glob', 'symbols']);
    expect(auditor.permissions).toEqual({ filesystem: 'read' });
  });

  it('keeps one-concern-per-commit explicit', () => {
    expect(command(scope, 'plan-small').template).toContain('One concern per phase');
    expect(command(scope, 'split-commit').template).toContain('Do not bundle');
  });
});

describe('a generous parent does not make the new subagents more capable', () => {
  const generous: ParentGrant = {
    tools: ['read', 'write', 'edit', 'grep', 'glob', 'symbols', 'bash', 'todo', 'task'],
    permissions: {
      filesystem: 'workspace-write',
      network: ['api.example.com'],
      env: ['HOME', 'SECRET_TOKEN'],
    },
    maxSteps: 200,
  };

  it('narrows ops-reviewer to its four tools and read', async () => {
    const reviewer = ops.agents[0];
    if (reviewer === undefined) throw new Error('expected a subagent');
    const outcome = narrowSubagent(reviewer, generous);
    if (!outcome.ok) throw new Error(outcome.diagnostics.map((d) => d.message).join('\n'));
    expect(outcome.narrowed.tools).toEqual(['read', 'grep', 'glob', 'symbols']);
    expect(outcome.narrowed.permissions.filesystem).toBe('read');
  });

  it('narrows scope-auditor the same way', async () => {
    const auditor = scope.agents[0];
    if (auditor === undefined) throw new Error('expected a subagent');
    const outcome = narrowSubagent(auditor, generous);
    if (!outcome.ok) throw new Error('expected narrowing to succeed');
    expect(outcome.narrowed.tools).toEqual(['read', 'grep', 'glob', 'symbols']);
  });
});

describe('command interpolation is refused without a runner', () => {
  it('refuses /deploy-checklist with no gate-checked runner', async () => {
    const outcome = await interpolate(command(ops, 'deploy-checklist'), {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.message).toContain('gate-checked command runner');
  });

  it('refuses /split-commit with no gate-checked runner', async () => {
    const outcome = await interpolate(command(scope, 'split-commit'), {});
    expect(outcome.ok).toBe(false);
  });
});
