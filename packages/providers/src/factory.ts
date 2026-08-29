/**
 * The one-call entry point.
 *
 * Resolves configuration, picks a model, and builds a gateway. Separated from
 * {@link AiSdkGateway} so the gateway itself takes explicit, already-resolved inputs and
 * has no opinion about the filesystem or the environment — which is what lets its tests
 * construct it from literals and run with no network, no keys, and no ambient state.
 *
 * Model selection order: what the caller asked for, then the config file's
 * `defaultModel`, then a documented fallback for whichever provider has a credential.
 * The fallback exists so that a user with `ANTHROPIC_API_KEY` exported can run `adze run
 * "..."` with no flags and no config file, which is the shortest path from clone to a
 * working agent. It is a **named constant in this file**, not a hidden default: a run
 * has to be able to report which model it used, and `adze run` prints it.
 */

import type { ModelSelection } from '@adze/protocol';
import { capabilitiesFor } from './catalog.js';
import {
  parseModelRef,
  type ResolvedConfig,
  type ResolveOptions,
  resolveConfig,
} from './config.js';
import { ProviderConfigurationError } from './errors.js';
import { AiSdkGateway, type LanguageModelFactory } from './gateway.js';

/**
 * The model used when nothing states one, per provider.
 *
 * Deliberately a mid-tier model rather than the largest: an unconfigured first run
 * should not spend flagship money to find out whether the tool works. Both entries are
 * in `catalog.json`, so cost is reported rather than unknown.
 */
export const FALLBACK_MODEL: Readonly<Record<string, string>> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-5.4',
};

/** Which provider's fallback to reach for first, when several have credentials. */
const FALLBACK_ORDER = ['anthropic', 'openai'] as const;

export interface CreateGatewayOptions extends ResolveOptions {
  /** `provider/model`, from `--model` or an embedder. Highest precedence. */
  readonly modelRef?: string;
  /** A fully-specified selection, when the caller already has one. Wins over `modelRef`. */
  readonly model?: ModelSelection;
  /** Reasoning effort, when the surface exposes it. */
  readonly effort?: ModelSelection['effort'];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** Test seam. See {@link LanguageModelFactory}. */
  readonly languageModel?: LanguageModelFactory;
}

export interface GatewayBundle {
  readonly gateway: AiSdkGateway;
  /** The selection actually in force, for a surface to display and a report to pin. */
  readonly model: ModelSelection;
  readonly config: ResolvedConfig;
}

/**
 * Choose a model.
 *
 * Throws with an actionable message rather than picking something when there is nothing
 * to pick. "No API key configured" naming the variable is the single highest-value error
 * message in the whole CLI, because it is the one a new user hits first.
 */
function selectModel(config: ResolvedConfig, options: CreateGatewayOptions): ModelSelection {
  const base =
    options.model ??
    (options.modelRef !== undefined
      ? parseModelRef(options.modelRef)
      : config.defaultModel !== undefined
        ? parseModelRef(config.defaultModel)
        : fallbackSelection(config));

  return {
    provider: base.provider,
    model: base.model,
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
  };
}

function fallbackSelection(config: ResolvedConfig): { provider: string; model: string } {
  for (const id of FALLBACK_ORDER) {
    const provider = config.providers.find((candidate) => candidate.id === id);
    if (provider?.apiKey === undefined) continue;
    const model = provider.defaultModel ?? FALLBACK_MODEL[id];
    if (model !== undefined) return { provider: id, model };
  }

  // Any configured provider with a declared default, including a compatible endpoint
  // that needs no key. Checked after the first-party ones so an exported vendor key
  // takes precedence over a leftover local server entry.
  const declared = config.providers.find((provider) => provider.defaultModel !== undefined);
  if (declared?.defaultModel !== undefined) {
    return { provider: declared.id, model: declared.defaultModel };
  }

  const names = FALLBACK_ORDER.flatMap(
    (id) => config.providers.find((provider) => provider.id === id)?.apiKeyEnvCandidates ?? [],
  );
  throw new ProviderConfigurationError('no model provider is configured', {
    envVars: names,
    hints: [
      `Set one of: ${names.join(', ')}.`,
      'PowerShell:  $env:ANTHROPIC_API_KEY = "sk-ant-..."',
      'bash/zsh:    export ANTHROPIC_API_KEY="sk-ant-..."',
      'Or point Adze at a local or third-party endpoint in .adze/providers.json:',
      '  { "providers": { "local": { "kind": "openai-compatible", "baseURL": "http://localhost:11434/v1", "defaultModel": "qwen2.5-coder" } } }',
      'Run `adze models` to see what is configured, and `adze doctor` for the whole environment.',
    ],
  });
}

/**
 * Resolve configuration and build a gateway.
 *
 * The credential is *not* required here. A gateway can be constructed without one so
 * that `adze models` can report capabilities on a machine with no keys; the refusal
 * happens at the first request, where it can name the model that could not be reached.
 * The exception is having no model to select at all, which is a question this function
 * cannot defer.
 */
export function createGateway(options: CreateGatewayOptions = {}): GatewayBundle {
  const config = resolveConfig(options);
  const model = selectModel(config, options);

  // Checked here rather than left to the gateway constructor, because a typo in
  // `--model openai/gpt-5.4` should not produce "no provider configured" three frames
  // deep with no mention of the flag that caused it.
  if (!config.providers.some((provider) => provider.id === model.provider)) {
    throw new ProviderConfigurationError(
      `model '${model.provider}/${model.model}' names provider '${model.provider}', which is not configured`,
      {
        hints: [
          `Configured: ${config.providers.map((provider) => provider.id).join(', ')}.`,
          `Add it to .adze/providers.json, or use one of the above.`,
          'Run `adze models` for the full list with capabilities.',
        ],
      },
    );
  }

  const gateway = new AiSdkGateway({
    providers: config.providers,
    model,
    ...(options.languageModel === undefined ? {} : { languageModel: options.languageModel }),
  });

  return { gateway, model, config };
}

/** True when the price table has rates for a selection. For a surface to render. */
export function isPriced(model: ModelSelection): boolean {
  return !capabilitiesFor(model.provider, model.model).costUnknown;
}
