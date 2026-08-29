/**
 * Turning VS Code settings into protocol values.
 *
 * Two rules, both borrowed from the CLI's flag parser for the same reason: a
 * setting that silently means something other than what it says is a security
 * display that is wrong, and the user has no way to tell.
 *
 * 1. **An unrecognised value narrows, never widens.** A typo in
 *    `adze.approvals.policy` resolves to `never` — refuse — rather than to the
 *    documented default `on-request`, which can grant. Same for
 *    `adze.sandbox.mode`, which narrows to `read-only`. Falling back to the
 *    default would turn `"nevr"` into a policy that prompts and can be answered
 *    yes, which is more than the user asked for.
 * 2. **Any invalid setting blocks the run.** Narrowing alone is not enough for
 *    budgets: the fail-closed value for a ceiling is not obvious, and "unbounded"
 *    is plainly the wrong guess. So {@link resolveSettings} collects problems and
 *    the caller refuses to submit a turn while any exist, naming every bad key.
 *    Two independent mechanisms, because a permission model that quietly grants
 *    more than it advertises is not worth having.
 *
 * `null` means unbounded for every budget, matching the CLI: a budget that was not
 * given is omitted rather than defaulted to zero, because a zero ceiling stops the
 * turn immediately and absent means no ceiling. `maxSpendUsd` is the one budget
 * where `0` is legal — the protocol allows it, and it means no spend is permitted.
 */

import type { ApprovalPolicy, SandboxConfig, SandboxMode, TurnBudget } from '@adze/protocol';
import { DEFAULT_APPROVAL_POLICY, DEFAULT_SANDBOX_MODE } from '@adze/protocol';
import type { WorkspaceConfiguration } from './host/api.js';

/** The settings section every key below is read from. */
export const CONFIG_SECTION = 'adze';

const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'full-access'];
const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ['untrusted', 'on-request', 'never'];

/** Fail-closed values. See rule 1 in the file comment. */
const NARROWEST_SANDBOX: SandboxMode = 'read-only';
const NARROWEST_APPROVALS: ApprovalPolicy = 'never';

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_MAX_PREFIX_BYTES = 4096;

export interface InlineCompletionSettings {
  readonly enabled: boolean;
  readonly debounceMs: number;
  readonly maxPrefixBytes: number;
}

export interface ResolvedSettings {
  /** `provider/model`, or undefined to let provider configuration decide. */
  readonly modelRef: string | undefined;
  readonly sandbox: SandboxConfig;
  readonly approvals: ApprovalPolicy;
  readonly budget: TurnBudget;
  readonly instructions: string | undefined;
  readonly inlineCompletion: InlineCompletionSettings;
}

export interface SettingsProblem {
  /** Fully qualified, so the message can be pasted into the settings search box. */
  readonly key: string;
  readonly message: string;
}

export interface SettingsResolution {
  readonly settings: ResolvedSettings;
  readonly problems: readonly SettingsProblem[];
}

function qualify(key: string): string {
  return `${CONFIG_SECTION}.${key}`;
}

function isUnset(raw: unknown): boolean {
  return raw === undefined || raw === null || raw === '';
}

function readEnum<T extends string>(
  config: WorkspaceConfiguration,
  key: string,
  allowed: readonly T[],
  whenUnset: T,
  whenInvalid: T,
  problems: SettingsProblem[],
): T {
  const raw = config.get<unknown>(key);
  if (isUnset(raw)) return whenUnset;
  if (typeof raw === 'string') {
    const match = allowed.find((candidate) => candidate === raw);
    if (match !== undefined) return match;
  }
  problems.push({
    key: qualify(key),
    message:
      `${JSON.stringify(raw)} is not one of ${allowed.join(', ')}. ` +
      `Narrowed to '${whenInvalid}' so a typo cannot grant more than you asked for.`,
  });
  return whenInvalid;
}

function readPositiveInt(
  config: WorkspaceConfiguration,
  key: string,
  problems: SettingsProblem[],
): number | undefined {
  const raw = config.get<unknown>(key);
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  problems.push({
    key: qualify(key),
    message:
      `${JSON.stringify(raw)} is not a positive integer. Use null for no ceiling; ` +
      `0 is rejected rather than read as unbounded.`,
  });
  return undefined;
}

function readNonNegative(
  config: WorkspaceConfiguration,
  key: string,
  problems: SettingsProblem[],
): number | undefined {
  const raw = config.get<unknown>(key);
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  problems.push({
    key: qualify(key),
    message: `${JSON.stringify(raw)} is not a non-negative number. Use null for no ceiling.`,
  });
  return undefined;
}

function readBoolean(
  config: WorkspaceConfiguration,
  key: string,
  fallback: boolean,
  problems: SettingsProblem[],
): boolean {
  const raw = config.get<unknown>(key);
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'boolean') return raw;
  problems.push({
    key: qualify(key),
    message: `${JSON.stringify(raw)} is not a boolean. Using ${String(fallback)}.`,
  });
  return fallback;
}

function readBoundedInt(
  config: WorkspaceConfiguration,
  key: string,
  minimum: number,
  fallback: number,
  problems: SettingsProblem[],
): number {
  const raw = config.get<unknown>(key);
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= minimum) return raw;
  problems.push({
    key: qualify(key),
    message: `${JSON.stringify(raw)} is not an integer of at least ${minimum}. Using ${fallback}.`,
  });
  return fallback;
}

function readTrimmedString(config: WorkspaceConfiguration, key: string): string | undefined {
  const raw = config.get<unknown>(key);
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readBudget(config: WorkspaceConfiguration, problems: SettingsProblem[]): TurnBudget {
  const maxSteps = readPositiveInt(config, 'budget.maxSteps', problems);
  const maxTokens = readPositiveInt(config, 'budget.maxTokens', problems);
  const maxWallClockMs = readPositiveInt(config, 'budget.maxWallClockMs', problems);
  const maxSpendUsd = readNonNegative(config, 'budget.maxSpendUsd', problems);
  // Spread-on-defined rather than assigning undefined: `exactOptionalPropertyTypes`
  // distinguishes an absent ceiling from one explicitly set to undefined, and only
  // the former means unbounded.
  return {
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(maxWallClockMs === undefined ? {} : { maxWallClockMs }),
    ...(maxSpendUsd === undefined ? {} : { maxSpendUsd }),
  };
}

function readInlineCompletion(
  config: WorkspaceConfiguration,
  problems: SettingsProblem[],
): InlineCompletionSettings {
  return {
    // Default off. Each suggestion costs a full turn against the configured
    // provider, because the protocol has no cheap-completion message, and billing
    // a user for keystrokes they did not deliberately submit is not a default we
    // are willing to ship.
    enabled: readBoolean(config, 'inlineCompletion.enabled', false, problems),
    debounceMs: readBoundedInt(
      config,
      'inlineCompletion.debounceMs',
      100,
      DEFAULT_DEBOUNCE_MS,
      problems,
    ),
    maxPrefixBytes: readBoundedInt(
      config,
      'inlineCompletion.maxPrefixBytes',
      256,
      DEFAULT_MAX_PREFIX_BYTES,
      problems,
    ),
  };
}

export function resolveSettings(config: WorkspaceConfiguration): SettingsResolution {
  const problems: SettingsProblem[] = [];

  const mode = readEnum(
    config,
    'sandbox.mode',
    SANDBOX_MODES,
    DEFAULT_SANDBOX_MODE,
    NARROWEST_SANDBOX,
    problems,
  );
  const approvals = readEnum(
    config,
    'approvals.policy',
    APPROVAL_POLICIES,
    DEFAULT_APPROVAL_POLICY,
    NARROWEST_APPROVALS,
    problems,
  );

  const modelRef = readTrimmedString(config, 'model');
  const instructions = readTrimmedString(config, 'instructions');

  return {
    settings: {
      modelRef,
      sandbox: {
        mode,
        // Not configurable yet. Widening writes without widening the mode is a real
        // need, but it needs a settings UI that shows what was granted; until then
        // the workspace root is the only writable root. See docs/roadmap.md.
        writableRoots: [],
        allowedNetworkHosts: [],
        commandRules: [],
      },
      approvals,
      budget: readBudget(config, problems),
      instructions,
      inlineCompletion: readInlineCompletion(config, problems),
    },
    problems,
  };
}

/** True when nothing may be submitted until settings are fixed. See rule 2. */
export function blocksRun(resolution: SettingsResolution): boolean {
  return resolution.problems.length > 0;
}

/** One actionable line per bad key. Never a stack trace. */
export function describeProblems(problems: readonly SettingsProblem[]): string {
  return problems.map((problem) => `${problem.key}: ${problem.message}`).join('\n');
}
