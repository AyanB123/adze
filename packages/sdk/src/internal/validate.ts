/**
 * Configuration validation, and the one place core is spoken to.
 *
 * Two jobs, and they are the same job seen from two sides.
 *
 * **Refuse early, with a message that says what to change.** Every check here
 * exists because the alternative failure is worse: a relative `workspaceRoot`
 * resolves against the engine's cwd rather than the embedder's, a `maxSpendUsd`
 * against an unpriced model is a budget that silently does not apply, and a
 * provider missing `stream` fails several layers later inside the turn machine
 * with a message about the loop rather than about the configuration.
 *
 * **Narrow the seam handles.** {@link ModelProviderLike} and its siblings declare
 * only the fields the SDK reads, because the full interfaces are written in
 * core-internal vocabulary that `@adze/protocol` has no equivalent for (see
 * `src/types.ts` header). So the compiler cannot check that a passed value is a
 * real provider, and this file does it at runtime instead. The `as unknown as`
 * casts below are the cost of that, and they are confined to this file on purpose:
 * each one is preceded by a structural check that makes it true.
 */

import { isAbsolute } from 'node:path';
import type { ModelProvider, RegisteredHook, RegisteredTool, SearchBackend } from '@adze/core';
import {
  computeCost,
  NodeSubprocessBroker,
  NullBroker,
  type SandboxBroker,
  scrubEnvironment,
} from '@adze/core';
import type {
  ApprovalPolicy,
  Cost,
  ModelSelection,
  PeerInfo,
  SandboxConfig,
  TurnBudget,
  Usage,
} from '@adze/protocol';
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_SANDBOX_MODE,
  formatIssues,
  ModelSelectionSchema,
  TurnBudgetSchema,
} from '@adze/protocol';
import { AdzeConfigError } from '../errors.js';
import type { AdzeClientOptions, SandboxOptions, ToolLimits } from '../types.js';

/** Engine-facing configuration, fully resolved. Never reaches a consumer. */
export interface ValidatedConfig {
  readonly workspaceRoot: string;
  readonly provider: ModelProvider;
  readonly model: ModelSelection;
  readonly client: PeerInfo;
  readonly sandbox: SandboxConfig;
  readonly approvals: ApprovalPolicy;
  readonly budget: TurnBudget | undefined;
  readonly instructions: string | undefined;
  readonly tools: readonly RegisteredTool[];
  readonly hooks: readonly RegisteredHook[];
  readonly search: SearchBackend | undefined;
  readonly limits: { readonly maxResultBytes: number; readonly timeoutMs: number } | undefined;
  readonly broker: SandboxBroker;
}

const DEFAULT_CLIENT: PeerInfo = { name: '@adze/sdk', version: '0.0.1' };

export function validateClientOptions(options: AdzeClientOptions): ValidatedConfig {
  const workspaceRoot = requireAbsolute(options.workspaceRoot, 'workspaceRoot');
  const provider = requireProvider(options.provider);
  const model = requireModel(options.model);
  const sandbox = buildSandbox(options.sandbox);
  const approvals = options.approvals ?? DEFAULT_APPROVAL_POLICY;
  const budget = options.budget === undefined ? undefined : requireBudget(options.budget);

  // A spend ceiling that cannot be priced is refused here rather than at the first
  // model call. Core refuses it too, but from inside the turn, where it arrives as a
  // rejected turn rather than as a configuration error the embedder can act on.
  if (budget?.maxSpendUsd !== undefined) requirePrices(provider, model, 'budget.maxSpendUsd');

  return {
    workspaceRoot,
    provider,
    model,
    client: options.client ?? DEFAULT_CLIENT,
    sandbox,
    approvals,
    budget,
    instructions: options.instructions,
    tools: (options.tools ?? []).map((tool, index) => requireTool(tool, index)),
    hooks: (options.plugins ?? []).map((plugin, index) => requireHook(plugin, index)),
    search: options.retrieval === undefined ? undefined : requireSearch(options.retrieval),
    limits: buildLimits(options.limits),
    broker: buildBroker(options.commandExecution ?? 'subprocess'),
  };
}

/**
 * Prices for a model, or a refusal naming the field that needed them.
 *
 * Shared by the client and by the per-turn budget check so the two cannot drift:
 * a turn-level `maxSpendUsd` has to be refused on exactly the same grounds as a
 * client-level one.
 */
export function requirePrices(provider: ModelProvider, model: ModelSelection, field: string): void {
  if (provider.priceFor(model) !== undefined) return;
  throw new AdzeConfigError(
    `${field} was set but provider '${provider.name}' has no prices for model ` +
      `'${model.model}', so the ceiling could not be enforced. Configure prices for the ` +
      `model or remove the spend budget — an unenforced budget is a suggestion.`,
  );
}

/**
 * Cost for a usage record, or `undefined` when the provider has no prices.
 *
 * Lives here rather than in the client because `PriceSheet` is a `@adze/core` type
 * and this is the only file allowed to hold one. `undefined` is a real answer and is
 * reported as one: a wrong cost figure is worse than no cost figure, because it gets
 * quoted.
 */
export function costFor(
  provider: ModelProvider,
  model: ModelSelection,
  usage: Usage,
): Cost | undefined {
  const prices = provider.priceFor(model);
  return prices === undefined ? undefined : computeCost(usage, prices);
}

export function requireBudget(budget: TurnBudget): TurnBudget {
  const parsed = TurnBudgetSchema.safeParse(budget);
  if (parsed.success) return parsed.data;
  throw new AdzeConfigError(`invalid budget: ${formatIssues(parsed.error.issues).join('; ')}`);
}

export function buildSandbox(options: SandboxOptions | undefined): SandboxConfig {
  const writableRoots = (options?.writableRoots ?? []).map((root, index) =>
    requireAbsolute(root, `sandbox.writableRoots[${index}]`),
  );
  return {
    mode: options?.mode ?? DEFAULT_SANDBOX_MODE,
    writableRoots,
    allowedNetworkHosts: [...(options?.allowedNetworkHosts ?? [])],
    commandRules: [...(options?.commandRules ?? [])],
  };
}

function buildLimits(
  limits: ToolLimits | undefined,
): { readonly maxResultBytes: number; readonly timeoutMs: number } | undefined {
  if (limits === undefined) return undefined;
  // Both or neither: core's `ToolLimits` has no optional members, so supplying one
  // would mean inventing the other here and shadowing whatever core's default is.
  if (limits.maxResultBytes === undefined || limits.timeoutMs === undefined) {
    throw new AdzeConfigError(
      'limits requires both maxResultBytes and timeoutMs. Supplying one would silently ' +
        "replace the engine's default for the other. Omit `limits` to keep both defaults.",
    );
  }
  requirePositive(limits.maxResultBytes, 'limits.maxResultBytes');
  requirePositive(limits.timeoutMs, 'limits.timeoutMs');
  return { maxResultBytes: limits.maxResultBytes, timeoutMs: limits.timeoutMs };
}

/**
 * `disabled` yields a broker that refuses every command.
 *
 * It still reports `gate-only` enforcement rather than `not-applicable`, so the
 * `no-os-sandbox` warning is not suppressed for a configuration that genuinely has
 * no containment. Nothing can run through it, which is what makes it right for an
 * example or a test.
 */
function buildBroker(execution: 'subprocess' | 'disabled'): SandboxBroker {
  if (execution === 'disabled') return new NullBroker();
  // Credential-shaped names are removed from the subprocess environment. The model
  // chooses the commands, so a key in the environment is one `env` away from the
  // transcript. A mitigation, not a boundary (ADR-0007).
  return new NodeSubprocessBroker({ env: scrubEnvironment(process.env) });
}

function requireAbsolute(value: string, field: string): string {
  if (value.length === 0) throw new AdzeConfigError(`${field} must not be empty`);
  if (!isAbsolute(value)) {
    throw new AdzeConfigError(
      `${field} must be an absolute path, got '${value}'. The engine may be a sidecar ` +
        `started from an unrelated directory, so a relative path would resolve against ` +
        `its cwd rather than yours.`,
    );
  }
  return value;
}

function requirePositive(value: number, field: string): void {
  if (Number.isInteger(value) && value > 0) return;
  throw new AdzeConfigError(`${field} must be a positive integer, got ${String(value)}`);
}

function requireModel(model: ModelSelection): ModelSelection {
  const parsed = ModelSelectionSchema.safeParse(model);
  if (parsed.success) return parsed.data;
  throw new AdzeConfigError(`invalid model: ${formatIssues(parsed.error.issues).join('; ')}`);
}

function requireProvider(candidate: unknown): ModelProvider {
  const missing = missingMembers(candidate, {
    name: 'string',
    nativeToolCalling: 'boolean',
    stream: 'function',
    priceFor: 'function',
  });
  if (missing.length > 0) {
    throw new AdzeConfigError(
      `provider is not a model provider: missing or wrong-typed ${missing.join(', ')}. ` +
        `Obtain one from '@adze/providers', or use scriptedProvider() for an offline run.`,
    );
  }
  return candidate as ModelProvider;
}

function requireTool(candidate: unknown, index: number): RegisteredTool {
  const missing = missingMembers(candidate, {
    name: 'string',
    description: 'string',
    parameters: 'object',
    prepare: 'function',
  });
  if (missing.length > 0) {
    throw new AdzeConfigError(
      `tools[${index}] is not a tool: missing or wrong-typed ${missing.join(', ')}. ` +
        `A tool's arguments must arrive through a schema, so 'prepare' is required.`,
    );
  }
  return candidate as RegisteredTool;
}

function requireHook(candidate: unknown, index: number): RegisteredHook {
  const missing = missingMembers(candidate, { id: 'string' });
  if (missing.length > 0) {
    throw new AdzeConfigError(
      `plugins[${index}] is not a hook: missing or wrong-typed ${missing.join(', ')}. ` +
        `Build one with '@adze/plugin-sdk'.`,
    );
  }
  return candidate as RegisteredHook;
}

function requireSearch(candidate: unknown): SearchBackend {
  const missing = missingMembers(candidate, {
    name: 'string',
    search: 'function',
    glob: 'function',
    symbols: 'function',
  });
  if (missing.length > 0) {
    throw new AdzeConfigError(
      `retrieval is not a search backend: missing or wrong-typed ${missing.join(', ')}. ` +
        `Obtain one from '@adze/retrieval'. Omit it and glob/grep/symbols report ` +
        `themselves unavailable rather than returning nothing.`,
    );
  }
  return candidate as SearchBackend;
}

/**
 * Which required members a candidate does not have.
 *
 * Returns the full list rather than the first miss, because a consumer who passed
 * the wrong object entirely should learn that in one round rather than four.
 */
function missingMembers(
  candidate: unknown,
  shape: Readonly<Record<string, 'string' | 'boolean' | 'function' | 'object'>>,
): readonly string[] {
  if (typeof candidate !== 'object' || candidate === null) return Object.keys(shape);
  const record: Record<string, unknown> = candidate as Record<string, unknown>;
  const missing: string[] = [];
  for (const [member, kind] of Object.entries(shape)) {
    const value = record[member];
    const ok =
      kind === 'object' ? typeof value === 'object' && value !== null : typeof value === kind;
    if (!ok) missing.push(`${member} (expected ${kind})`);
  }
  return missing;
}
