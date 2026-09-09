/**
 * Overlaying CLI flags on the loaded config — the top of the precedence chain.
 *
 * Precedence, lowest to highest: defaults < user file < workspace file < env <
 * flags. `loader.ts` resolves up to env; this module applies the flags a user
 * typed and returns the effective invocation `run` and `chat` build the agent
 * from. A flag that was given always wins over every lower layer, so a file
 * can never weaken what the command line refused.
 *
 * Flag parsing itself is unchanged (`src/agent/flags.ts` still refuses an
 * invalid value rather than defaulting permissively). What changes is where the
 * *absence* of a flag resolves to: previously the documented default, now the
 * config chain.
 */

import type { ApprovalPolicy, CommandRule, SandboxMode } from '@adze/protocol';
import {
  type AgentFlags,
  type AgentInvocation,
  parseApprovalPolicy,
  parseBudget,
  parseEffort,
  parseSandboxMode,
  parseTemperature,
  UsageError,
} from '../agent/flags.js';
import { applyForbidWins, type CommandRuleWithSource, type LoadedConfig } from './loader.js';

function positiveFlagInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} '${value}' is not a positive whole number`);
  }
  return parsed;
}

export interface EffectiveResolution {
  readonly invocation: AgentInvocation;
  /** Effective command rules after the forbid-wins filter, flag rules included. */
  readonly commandRules: readonly CommandRule[];
  /** Warnings from loading plus flag-merge filtering. */
  readonly warnings: readonly string[];
  /** The loaded config, for `doctor` source reporting. */
  readonly loaded: LoadedConfig;
}

/**
 * Resolve flags over a loaded config.
 *
 * Throws `UsageError` for a bad flag, exactly as before — a config file never
 * rescues a mistyped flag, because that would turn an explicit refusal
 * (`--sandbox read-onyl` refused) into a guess.
 */
export function resolveWithFlags(
  flags: AgentFlags,
  loaded: LoadedConfig,
  cwd: string,
  extraWarnings: readonly string[] = [],
): EffectiveResolution {
  const warnings = [...extraWarnings];

  const sandboxMode: SandboxMode =
    flags.sandbox !== undefined ? parseSandboxMode(flags.sandbox) : loaded.sandboxMode;

  const approvals: ApprovalPolicy =
    flags.approval !== undefined ? parseApprovalPolicy(flags.approval) : loaded.approvalPolicy;

  const modelRef = flags.model !== undefined ? flags.model : loaded.engineModel;

  const effort = flags.effort !== undefined ? parseEffort(flags.effort) : loaded.effort;
  const temperature =
    flags.temperature !== undefined ? parseTemperature(flags.temperature) : loaded.temperature;
  const maxOutputTokens =
    flags.maxOutputTokens !== undefined
      ? positiveFlagInt(flags.maxOutputTokens, '--max-output-tokens')
      : (loaded.maxOutputTokens ?? undefined);

  // Command rules accumulate from every layer: file unions plus env plus flags.
  // A `forbid` from any layer drops an overlapping `allow` with a warning —
  // the prohibition wins regardless of layer, so neither a file nor a flag
  // can quietly re-allow what another layer forbade.
  for (const prefix of flags.allow ?? []) {
    if (prefix.trim().length === 0) throw new UsageError('--allow needs a command prefix');
  }
  for (const prefix of flags.forbid ?? []) {
    if (prefix.trim().length === 0) throw new UsageError('--forbid needs a command prefix');
  }
  const flagAllow: CommandRuleWithSource[] = (flags.allow ?? []).map((prefix) => ({
    prefix,
    source: 'flag' as const,
  }));
  const flagForbid: CommandRuleWithSource[] = (flags.forbid ?? []).map((prefix) => ({
    prefix,
    source: 'flag' as const,
  }));

  const allow = applyForbidWins(
    [...loaded.allowRules, ...flagAllow],
    [...loaded.forbidRules, ...flagForbid],
    warnings,
  );
  const commandRules: CommandRule[] = [
    ...allow.map((rule) => ({ prefix: rule.prefix, action: 'allow' as const })),
    ...[...loaded.forbidRules, ...flagForbid].map((rule) => ({
      prefix: rule.prefix,
      action: 'forbid' as const,
    })),
    ...loaded.promptRules.map((rule) => ({ prefix: rule.prefix, action: 'prompt' as const })),
  ];

  const budget = parseBudget({
    ...flags,
    ...(flags.maxTokens === undefined && loaded.maxTokens !== undefined
      ? { maxTokens: String(loaded.maxTokens) }
      : {}),
  });

  const invocation: AgentInvocation = {
    workspaceRoot: flags.cwd ?? cwd,
    modelRef,
    effort,
    temperature,
    maxOutputTokens,
    sandboxMode,
    approvals,
    commandRules,
    budget,
    instructions: flags.instructions,
    json: flags.json === true,
    quiet: flags.quiet === true,
  };

  return { invocation, commandRules, warnings, loaded };
}
