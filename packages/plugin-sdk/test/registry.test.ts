/**
 * Cross-plugin command and agent registries.
 *
 * Finding 5 in `plugins/FINDINGS.md`: only context-provider triggers were
 * checked for collisions, because `buildContextProviders` was the single funnel
 * every provider passed through and commands and agents had no equivalent. Two
 * plugins could each contribute `review` and which one `/review` invoked
 * depended on load order. These registries are that funnel: the first loaded
 * entry wins and the later one is refused with a diagnostic, so every surface
 * assembles the same set.
 */

import { describe, expect, it } from 'vitest';
import type { SubagentDefinition } from '../src/agents.js';
import { parseSubagent } from '../src/agents.js';
import { parseSlashCommand, type SlashCommand } from '../src/commands.js';
import type { LoadedPlugin } from '../src/loader.js';
import { NO_PERMISSIONS, parseManifest } from '../src/manifest.js';
import { buildAgentRegistry, buildCommandRegistry } from '../src/registry.js';
import { manifestText } from './support.js';

function command(pluginId: string, name: string): SlashCommand {
  const parsed = parseSlashCommand(
    pluginId,
    `commands/${name}.md`,
    `---\nname: ${name}\ndescription: The ${name} command.\n---\n\nDo ${name}.\n`,
  );
  if (!parsed.ok) throw new Error(`test command '${name}' did not parse`);
  return parsed.command;
}

function agent(pluginId: string, name: string): SubagentDefinition {
  const parsed = parseSubagent(
    pluginId,
    `agents/${name}.md`,
    `---\nname: ${name}\ndescription: The ${name} subagent.\ntools: [read]\n---\n\nYou are ${name}.\n`,
  );
  if (!parsed.ok) throw new Error(`test subagent '${name}' did not parse`);
  return parsed.definition;
}

function stubPlugin(
  id: string,
  commands: readonly SlashCommand[],
  agents: readonly SubagentDefinition[],
): LoadedPlugin {
  const parsed = parseManifest(manifestText({ id }));
  if (!parsed.ok) throw new Error(`test manifest '${id}' did not parse`);
  return {
    manifest: parsed.manifest,
    permissions: NO_PERMISSIONS,
    root: `/plugins/${id}`,
    tools: [],
    contextProviders: [],
    commands,
    hooks: [],
    agents,
    ui: [],
    notices: [],
  };
}

describe('buildCommandRegistry', () => {
  it('merges commands from several plugins when names are unique', () => {
    const first = stubPlugin('acme.first', [command('acme.first', 'review')], []);
    const second = stubPlugin('acme.second', [command('acme.second', 'summarise')], []);

    const registry = buildCommandRegistry([first, second]);

    expect(registry.commands.map((entry) => entry.name)).toEqual(['review', 'summarise']);
    expect(registry.diagnostics).toHaveLength(0);
  });

  it('refuses the later command when two plugins claim one name', () => {
    const first = stubPlugin('acme.first', [command('acme.first', 'review')], []);
    const second = stubPlugin('acme.second', [command('acme.second', 'review')], []);

    const registry = buildCommandRegistry([first, second]);

    // First wins, deterministically: the same installed set always resolves
    // `/review` to the same plugin.
    expect(registry.commands).toHaveLength(1);
    expect(registry.commands[0]?.pluginId).toBe('acme.first');
    expect(registry.diagnostics).toHaveLength(1);
    expect(registry.diagnostics[0]?.code).toBe('duplicate-name');
    expect(registry.diagnostics[0]?.message).toContain('acme.second');
    expect(registry.diagnostics[0]?.message).toContain('acme.first');
    expect(registry.diagnostics[0]?.message).toContain('inactive');
  });

  it('refuses a duplicate inside one plugin rather than keeping both', () => {
    const only = stubPlugin(
      'acme.first',
      [command('acme.first', 'review'), command('acme.first', 'review')],
      [],
    );

    const registry = buildCommandRegistry([only]);

    expect(registry.commands).toHaveLength(1);
    expect(registry.diagnostics).toHaveLength(1);
  });
});

describe('buildAgentRegistry', () => {
  it('merges subagents from several plugins when names are unique', () => {
    const first = stubPlugin('acme.first', [], [agent('acme.first', 'security')]);
    const second = stubPlugin('acme.second', [], [agent('acme.second', 'perf')]);

    const registry = buildAgentRegistry([first, second]);

    expect(registry.agents.map((entry) => entry.name)).toEqual(['security', 'perf']);
    expect(registry.diagnostics).toHaveLength(0);
  });

  it('refuses the later subagent when two plugins claim one name', () => {
    const first = stubPlugin('acme.first', [], [agent('acme.first', 'security')]);
    const second = stubPlugin('acme.second', [], [agent('acme.second', 'security')]);

    const registry = buildAgentRegistry([first, second]);

    expect(registry.agents).toHaveLength(1);
    expect(registry.agents[0]?.pluginId).toBe('acme.first');
    expect(registry.diagnostics).toHaveLength(1);
    expect(registry.diagnostics[0]?.code).toBe('duplicate-name');
    expect(registry.diagnostics[0]?.message).toContain('inactive');
  });
});
