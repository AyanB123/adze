/**
 * Configuration and credential resolution.
 *
 * Three sources, most specific first: explicit options passed by an embedder, then a
 * config file, then the environment. Environment last is the usual precedence, and it
 * is the right one here: a checked-out repository's config file should not be able to
 * silently redirect an agent at a different endpoint than the one the operator
 * exported.
 *
 * ### The config file is credentials-optional, deliberately
 *
 * `apiKey` is accepted in the file because a user with several accounts needs
 * somewhere to put them, but every code path prefers the environment and the file's
 * own documentation says to use `apiKeyEnv` — a *name* to read rather than the value.
 * A secret in a file inside a git working tree is one `git add -A` from being public,
 * and the loader cannot prevent that; naming the variable instead of the value can.
 *
 * ### Nothing here reads the network, and nothing here logs
 *
 * Resolution is filesystem and `process.env` only. A resolved key is held in memory,
 * registered with the redactor, and never written anywhere by this package.
 *
 * The full `.adze/config.jsonc` system — schema, layering, `AGENTS.md` conventions — is
 * M2 (see docs/roadmap.md). What is here is the provider slice of it, in strict JSON so
 * it needs no parser dependency.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { ProviderConfigurationError } from './errors.js';

/** The three transports this package implements. */
export const PROVIDER_KINDS = ['anthropic', 'openai', 'openai-compatible'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

const ProviderKindSchema = z.enum(PROVIDER_KINDS);

const ProviderEntrySchema = z.strictObject({
  /** Which adapter to use. Defaults to the entry's own id when that names a kind. */
  kind: ProviderKindSchema.optional(),
  /**
   * Environment variable holding the key. **Prefer this over `apiKey`.**
   */
  apiKeyEnv: z.string().min(1).optional(),
  /** The key itself. Works, but see the file comment on why the name is better. */
  apiKey: z.string().min(1).optional(),
  /** Required for `openai-compatible`; overrides the vendor default otherwise. */
  baseURL: z.string().url().optional(),
  /** Extra request headers. Never logged. */
  headers: z.record(z.string(), z.string()).optional(),
  /** Default model when a selection names this provider without a model. */
  defaultModel: z.string().min(1).optional(),
  /**
   * Declared capability for an endpoint the catalog has never heard of.
   *
   * The only way to tell Adze that a local server's model has no native tool calling.
   * Setting it to `false` makes the model `degraded`: the engine runs it without tools
   * and every surface says so, which is ADR-0004's required behaviour and the reason
   * this is a config key rather than a guess.
   */
  nativeToolCalling: z.boolean().optional(),
  /** Retries for transient failures. 0 disables. */
  maxRetries: z.number().int().min(0).max(10).optional(),
});

const ProvidersFileSchema = z.strictObject({
  /** Provider id used in `ModelSelection.provider`, e.g. `anthropic` or `openrouter`. */
  providers: z.record(z.string().min(1), ProviderEntrySchema),
  /** `provider/model`, used when no `--model` is given. */
  defaultModel: z.string().min(1).optional(),
});

export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;
export type ProvidersFile = z.infer<typeof ProvidersFileSchema>;

/**
 * Environment variables consulted per kind, in order.
 *
 * The vendor-standard name first, so an existing environment works with no Adze
 * configuration at all, then an Adze-prefixed name for someone who wants Adze to use a
 * different key than their other tools.
 */
export const API_KEY_ENV: Readonly<Record<ProviderKind, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ADZE_ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY', 'ADZE_OPENAI_API_KEY'],
  'openai-compatible': ['ADZE_COMPATIBLE_API_KEY', 'OPENAI_COMPATIBLE_API_KEY'],
};

export const BASE_URL_ENV: Readonly<Record<ProviderKind, readonly string[]>> = {
  anthropic: ['ANTHROPIC_BASE_URL'],
  openai: ['OPENAI_BASE_URL'],
  'openai-compatible': ['ADZE_COMPATIBLE_BASE_URL', 'OPENAI_COMPATIBLE_BASE_URL'],
};

/** Where a providers file is looked for, nearest first. */
export const CONFIG_FILENAME = join('.adze', 'providers.json');

export interface ResolveOptions {
  /** Workspace to search for `.adze/providers.json`. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Injectable for tests, and so nothing reads the real environment by accident. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Home directory for the user-level config. Injectable for the same reason. */
  readonly home?: string;
  /** Entries an embedder supplies directly. Highest precedence. */
  readonly providers?: Readonly<Record<string, ProviderEntry>>;
  /** Skip file lookup entirely. Used by tests so a developer's own config cannot leak in. */
  readonly ignoreConfigFiles?: boolean;
}

/** One provider, fully resolved and ready to construct an adapter from. */
export interface ResolvedProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  /** `undefined` when no credential was found. Not an error until a request is made. */
  readonly apiKey: string | undefined;
  /** Which variable or config key supplied the key. For `doctor`, never the value. */
  readonly apiKeySource: string | undefined;
  /** Variables that would supply one, for the error message when none did. */
  readonly apiKeyEnvCandidates: readonly string[];
  readonly baseURL: string | undefined;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly defaultModel: string | undefined;
  readonly nativeToolCalling: boolean | undefined;
  readonly maxRetries: number;
}

export interface ResolvedConfig {
  readonly providers: readonly ResolvedProvider[];
  /** `provider/model` from config, when set. */
  readonly defaultModel: string | undefined;
  /** Files that were read, for `doctor`. */
  readonly sources: readonly string[];
}

/** Retries when nothing says otherwise. Two attempts after the first. */
const DEFAULT_MAX_RETRIES = 2;

function readProvidersFile(path: string): ProvidersFile | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Absent or unreadable. Absent is the normal case and not worth reporting.
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ProviderConfigurationError(
      `${path} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      { hints: [`Fix the syntax, or delete ${path} to fall back to environment variables.`] },
    );
  }

  const result = ProvidersFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProviderConfigurationError(
      `${path} does not match the providers schema: ${result.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
      {
        hints: [
          'The file is `{ "providers": { "<id>": { "kind": "...", "apiKeyEnv": "..." } } }`.',
          'An unknown key is rejected rather than ignored, so a typo cannot silently do nothing.',
        ],
      },
    );
  }
  return result.data;
}

function kindOf(id: string, entry: ProviderEntry): ProviderKind | undefined {
  if (entry.kind !== undefined) return entry.kind;
  const parsed = ProviderKindSchema.safeParse(id);
  return parsed.success ? parsed.data : undefined;
}

function firstDefined(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): { readonly value: string; readonly source: string } | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim().length > 0) {
      return { value: value.trim(), source: name };
    }
  }
  return undefined;
}

function resolveOne(
  id: string,
  entry: ProviderEntry,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedProvider {
  const kind = kindOf(id, entry);
  if (kind === undefined) {
    throw new ProviderConfigurationError(
      `provider '${id}' does not name a known transport and has no 'kind'`,
      {
        hints: [
          `Add "kind": one of ${PROVIDER_KINDS.join(', ')}.`,
          `Any OpenAI-compatible endpoint — OpenRouter, llama.cpp, Ollama, a gateway — uses "kind": "openai-compatible" with a baseURL.`,
        ],
      },
    );
  }

  // Explicit `apiKeyEnv` first, then the entry's literal key, then the standard
  // variables. The literal sits in the middle so a user who names a variable gets the
  // variable, and someone who pasted a key still works.
  const named = entry.apiKeyEnv === undefined ? undefined : firstDefined(env, [entry.apiKeyEnv]);
  const standardNames = [...API_KEY_ENV[kind]];
  const candidates =
    entry.apiKeyEnv === undefined ? standardNames : [entry.apiKeyEnv, ...standardNames];
  const fallback = firstDefined(env, standardNames);

  const resolvedKey =
    named ??
    (entry.apiKey === undefined
      ? undefined
      : { value: entry.apiKey, source: `${CONFIG_FILENAME} providers.${id}.apiKey` }) ??
    fallback;

  const baseFromEnv = firstDefined(env, BASE_URL_ENV[kind]);

  return {
    id,
    kind,
    apiKey: resolvedKey?.value,
    apiKeySource: resolvedKey?.source,
    apiKeyEnvCandidates: candidates,
    baseURL: entry.baseURL ?? baseFromEnv?.value,
    headers: entry.headers,
    defaultModel: entry.defaultModel,
    nativeToolCalling: entry.nativeToolCalling,
    maxRetries: entry.maxRetries ?? DEFAULT_MAX_RETRIES,
  };
}

/**
 * Providers that exist with no configuration at all.
 *
 * Both first-party transports are always present so that `adze doctor` can report
 * `anthropic: no key` rather than omitting it — a provider absent from the list is
 * indistinguishable from one Adze does not support, and that ambiguity is the whole
 * reason a user cannot tell which variable to set.
 *
 * `openai-compatible` is conditional: it has no default endpoint, so an entry for it
 * without one would be a provider that cannot work and says nothing about why. A base
 * URL in the environment is exactly the condition that removes that objection, so the
 * entry is materialised then and only then.
 *
 * Without that condition the two variables in `BASE_URL_ENV['openai-compatible']` were
 * unreachable: they were consulted by `resolveOne`, but only for an entry a config file
 * had already declared, so a user who exported `ADZE_COMPATIBLE_BASE_URL` and
 * `ADZE_COMPATIBLE_API_KEY` and nothing else got a silent no-op — `doctor` listed
 * `anthropic` and `openai`, neither of which was what they configured, and no message
 * anywhere said a file was also required.
 */
function builtinEntries(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, ProviderEntry> {
  const entries: Record<string, ProviderEntry> = {
    anthropic: { kind: 'anthropic' },
    openai: { kind: 'openai' },
  };
  // The value is read by `resolveOne` through `BASE_URL_ENV`; this only decides whether
  // there is an entry for it to populate. Kept as a presence check so the URL has one
  // resolution path rather than two that can disagree.
  if (firstDefined(env, BASE_URL_ENV['openai-compatible']) !== undefined) {
    entries['openai-compatible'] = { kind: 'openai-compatible' };
  }
  return entries;
}

/**
 * Resolve every configured provider.
 *
 * Never throws for a missing credential. A key is needed to make a *request*, not to
 * list what is configured, and `adze doctor` and `adze models` both have to work on a
 * machine with no keys at all.
 */
export function resolveConfig(options: ResolveOptions = {}): ResolvedConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();

  const sources: string[] = [];
  let fileDefaultModel: string | undefined;
  const entries: Record<string, ProviderEntry> = builtinEntries(env);

  if (options.ignoreConfigFiles !== true) {
    // User-level first, then workspace, so the nearer file wins on a per-key basis.
    for (const path of [join(home, CONFIG_FILENAME), join(resolve(cwd), CONFIG_FILENAME)]) {
      const file = readProvidersFile(path);
      if (file === undefined) continue;
      sources.push(path);
      for (const [id, entry] of Object.entries(file.providers)) {
        entries[id] = { ...entries[id], ...entry };
      }
      if (file.defaultModel !== undefined) fileDefaultModel = file.defaultModel;
    }
  }

  for (const [id, entry] of Object.entries(options.providers ?? {})) {
    entries[id] = { ...entries[id], ...entry };
  }

  return {
    providers: Object.entries(entries).map(([id, entry]) => resolveOne(id, entry, env)),
    defaultModel: fileDefaultModel,
    sources,
  };
}

/**
 * Split a `provider/model` reference.
 *
 * A reference with no slash is a model id with no provider, which is ambiguous rather
 * than defaultable: `gpt-5.4` through an OpenAI-compatible proxy and through OpenAI
 * are different endpoints, different keys, and different prices. Guessing would
 * eventually charge someone on the wrong account.
 */
export function parseModelRef(ref: string): { readonly provider: string; readonly model: string } {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) {
    throw new ProviderConfigurationError(`'${ref}' is not a 'provider/model' reference`, {
      hints: [
        'Write it as provider/model, e.g. anthropic/claude-sonnet-4-5 or openai/gpt-5.4.',
        'Run `adze models` for the configured providers and the models the price table knows.',
      ],
    });
  }
  // `indexOf`, not `split`: an OpenAI-compatible model id can itself contain a slash
  // (`meta-llama/llama-3.1-70b-instruct` on OpenRouter), and splitting on every slash
  // would truncate it to the vendor prefix.
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}
