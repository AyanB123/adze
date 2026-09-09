/**
 * Cross-plugin registries for slash commands and subagents.
 *
 * `buildContextProviders` in `loader.ts` is the single funnel every context
 * provider passes through, which is why a duplicate `@trigger` is reported in
 * one place rather than differently by every surface. Commands and agents had no
 * equivalent funnel: the loader returned them per plugin and nothing merged
 * them, so two plugins could each contribute `review` and which one `/review`
 * invoked depended on load order (finding 5 in `plugins/FINDINGS.md`).
 *
 * These registries close that gap. Surfaces assemble commands and agents from
 * here rather than by concatenating `plugin.commands` themselves, so every
 * surface refuses the same later entry with the same diagnostic. The first
 * loaded entry wins; the later one is inactive. That matches the trigger rule,
 * except the severity is an error rather than a warning: a shadowed command is
 * not a degraded provider but an unreachable entry point, and silently keeping
 * both would make `/name` mean different things on different surfaces.
 */

import type { SubagentDefinition } from './agents.js';
import type { SlashCommand } from './commands.js';
import type { LoadedPlugin } from './loader.js';
import { errorDiagnostic, type PluginDiagnostic } from './manifest.js';

export interface CommandRegistry {
  readonly commands: readonly SlashCommand[];
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface AgentRegistry {
  readonly agents: readonly SubagentDefinition[];
  readonly diagnostics: readonly PluginDiagnostic[];
}

/**
 * Merge every loaded plugin's slash commands, refusing later duplicates.
 *
 * Order is plugin load order, then declaration order within a plugin. Deterministic,
 * so the same installed set always resolves `/name` to the same plugin.
 */
export function buildCommandRegistry(plugins: readonly LoadedPlugin[]): CommandRegistry {
  const commands: SlashCommand[] = [];
  const diagnostics: PluginDiagnostic[] = [];
  const owners = new Map<string, string>();

  for (const plugin of plugins) {
    for (const command of plugin.commands) {
      const owner = owners.get(command.name);
      if (owner !== undefined) {
        diagnostics.push(
          errorDiagnostic(
            'duplicate-name',
            `plugin '${command.pluginId}' contributes the slash command '/${command.name}', ` +
              `which '${owner}' already provides. The first one loaded wins; the later ` +
              `command is inactive. Rename one of them.`,
            'contributes.commands',
          ),
        );
        continue;
      }
      owners.set(command.name, command.pluginId);
      commands.push(command);
    }
  }

  return { commands, diagnostics };
}

/**
 * Merge every loaded plugin's subagents, refusing later duplicates.
 *
 * Same rule as commands: first wins, later is inactive with a diagnostic. A
 * shadowed subagent is refused rather than warned because invocation by name
 * would otherwise be ambiguous about which definition runs.
 */
export function buildAgentRegistry(plugins: readonly LoadedPlugin[]): AgentRegistry {
  const agents: SubagentDefinition[] = [];
  const diagnostics: PluginDiagnostic[] = [];
  const owners = new Map<string, string>();

  for (const plugin of plugins) {
    for (const agent of plugin.agents) {
      const owner = owners.get(agent.name);
      if (owner !== undefined) {
        diagnostics.push(
          errorDiagnostic(
            'duplicate-name',
            `plugin '${agent.pluginId}' contributes the subagent '${agent.name}', ` +
              `which '${owner}' already provides. The first one loaded wins; the later ` +
              `subagent is inactive. Rename one of them.`,
            'contributes.agents',
          ),
        );
        continue;
      }
      owners.set(agent.name, agent.pluginId);
      agents.push(agent);
    }
  }

  return { agents, diagnostics };
}
