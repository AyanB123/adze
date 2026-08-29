/**
 * Parsing the flags `run` and `chat` share.
 *
 * Shared so the two commands cannot drift. A `--sandbox` value one accepts and the other
 * silently ignores is a security display that is wrong in one of two places, and a user has
 * no way to tell which.
 *
 * Every parse **refuses an invalid value** rather than falling back to a default. A typo in
 * `--sandbox read-onyl` quietly becoming `workspace-write` grants more than the user asked
 * for, which is the same failure the permission model exists to prevent — and it would be
 * invisible.
 */

import type {
  ApprovalPolicy,
  CommandRule,
  ModelSelection,
  SandboxMode,
  TurnBudget,
} from '@adze/protocol';
import { ApprovalPolicySchema, SandboxModeSchema } from '@adze/protocol';

/** Raised for a bad flag. Rendered as a usage error, exit code 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
  readonly hints: readonly string[];

  constructor(message: string, hints: readonly string[] = []) {
    super(message);
    this.hints = hints;
  }
}

/** Flags common to `run` and `chat`, as commander hands them over. */
export interface AgentFlags {
  readonly model?: string;
  readonly effort?: string;
  readonly temperature?: string;
  readonly maxOutputTokens?: string;
  readonly sandbox?: string;
  readonly approval?: string;
  readonly allow?: string[];
  readonly forbid?: string[];
  readonly maxSteps?: string;
  readonly maxTokens?: string;
  readonly maxTime?: string;
  readonly maxSpend?: string;
  readonly cwd?: string;
  readonly instructions?: string;
  readonly json?: boolean;
  readonly quiet?: boolean;
}

const EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

export function parseSandboxMode(value: string | undefined): SandboxMode {
  if (value === undefined) return 'workspace-write';
  const parsed = SandboxModeSchema.safeParse(value);
  if (!parsed.success) {
    throw new UsageError(`--sandbox '${value}' is not a sandbox mode`, [
      'One of: read-only, workspace-write, full-access.',
      'read-only and workspace-write are containment modes; full-access asks for none.',
    ]);
  }
  return parsed.data;
}

export function parseApprovalPolicy(value: string | undefined): ApprovalPolicy {
  if (value === undefined) return 'on-request';
  const parsed = ApprovalPolicySchema.safeParse(value);
  if (!parsed.success) {
    throw new UsageError(`--approval '${value}' is not an approval policy`, [
      'One of: untrusted, on-request, never.',
      'untrusted asks about everything. on-request asks only about what the sandbox would block.',
      'never refuses rather than escalating: an action that needs approval is denied.',
    ]);
  }
  return parsed.data;
}

export function parseEffort(value: string | undefined): ModelSelection['effort'] | undefined {
  if (value === undefined) return undefined;
  const found = EFFORTS.find((effort) => effort === value);
  if (found === undefined) {
    throw new UsageError(`--effort '${value}' is not a reasoning effort`, [
      `One of: ${EFFORTS.join(', ')}.`,
      'Anthropic models do not accept an effort level; omit the flag for those.',
    ]);
  }
  return found;
}

function positiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} '${value}' is not a positive whole number`);
  }
  return parsed;
}

function positiveNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} '${value}' is not a positive number`);
  }
  return parsed;
}

export function parseTemperature(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
    throw new UsageError(`--temperature '${value}' is not between 0 and 2`);
  }
  return parsed;
}

/**
 * The four budgets.
 *
 * All four are enforced by the engine and reported in the summary. `--max-spend` on a model
 * with no prices is **refused at submit** by core rather than accepted and not applied,
 * which is why this function does not have to check it: an unenforced budget is a
 * suggestion, and the engine says so with a message naming the model.
 */
export function parseBudget(flags: AgentFlags): TurnBudget {
  const maxSteps = positiveInt(flags.maxSteps, '--max-steps');
  const maxTokens = positiveInt(flags.maxTokens, '--max-tokens');
  const seconds = positiveNumber(flags.maxTime, '--max-time');
  const maxSpendUsd = positiveNumber(flags.maxSpend, '--max-spend');

  return {
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(seconds === undefined ? {} : { maxWallClockMs: Math.round(seconds * 1000) }),
    ...(maxSpendUsd === undefined ? {} : { maxSpendUsd }),
  };
}

/**
 * Command rules from `--allow` and `--forbid`.
 *
 * The intended remedy for a gate-only platform: `--allow "pnpm test"` permits the command
 * the agent needs without widening the sandbox mode for everything else. `--forbid` is
 * absolute and is never offered for approval, because prompting to override an explicit
 * prohibition would make the rule advisory.
 */
export function parseCommandRules(flags: AgentFlags): readonly CommandRule[] {
  const rules: CommandRule[] = [];
  for (const prefix of flags.allow ?? []) {
    if (prefix.trim().length === 0) throw new UsageError('--allow needs a command prefix');
    rules.push({ prefix, action: 'allow' });
  }
  for (const prefix of flags.forbid ?? []) {
    if (prefix.trim().length === 0) throw new UsageError('--forbid needs a command prefix');
    rules.push({ prefix, action: 'forbid' });
  }
  return rules;
}

/** Everything the agent commands need, parsed and validated. */
export interface AgentInvocation {
  readonly workspaceRoot: string;
  readonly modelRef: string | undefined;
  readonly effort: ModelSelection['effort'] | undefined;
  readonly temperature: number | undefined;
  readonly maxOutputTokens: number | undefined;
  readonly sandboxMode: SandboxMode;
  readonly approvals: ApprovalPolicy;
  readonly commandRules: readonly CommandRule[];
  readonly budget: TurnBudget;
  readonly instructions: string | undefined;
  readonly json: boolean;
  readonly quiet: boolean;
}

export function parseAgentFlags(flags: AgentFlags, cwd: string): AgentInvocation {
  return {
    workspaceRoot: flags.cwd ?? cwd,
    modelRef: flags.model,
    effort: parseEffort(flags.effort),
    temperature: parseTemperature(flags.temperature),
    maxOutputTokens: positiveInt(flags.maxOutputTokens, '--max-output-tokens'),
    sandboxMode: parseSandboxMode(flags.sandbox),
    approvals: parseApprovalPolicy(flags.approval),
    commandRules: parseCommandRules(flags),
    budget: parseBudget(flags),
    instructions: flags.instructions,
    json: flags.json === true,
    quiet: flags.quiet === true,
  };
}
