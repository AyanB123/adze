/**
 * Loading and merging `.adze/config.jsonc` — user level, workspace level, env.
 *
 * Precedence, lowest to highest: defaults < user `~/.adze/config.jsonc` <
 * workspace `.adze/config.jsonc` < environment < CLI flags. Flags are applied
 * in `resolve.ts`; this module resolves everything up to the environment and
 * records the winning source per value so `doctor` can report it.
 *
 * Two rules keep a file from silently changing what a user asked for:
 *
 * 1. **Unknown keys warn.** {@link collectUnknownKeys} names every key the
 *    schema does not recognise, per file, with its dotted path. The values are
 *    stripped and parsing continues, so `doctor` shows what was ignored.
 * 2. **A refusal is never weakened into a grant.** Scalars resolve by rank
 *    (higher wins outright). Command rules merge by union, then any `allow`
 *    overlapped by a `forbid` from any layer — same prefix, or a longer allow
 *    extending a forbidden prefix — is dropped with a warning. The prohibition
 *    wins regardless of layer because it is the strongest statement of intent;
 *    to allow something forbidden, remove or narrow the `forbid`.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { parseJsonc } from './jsonc.js';
import {
  type AdzeConfig,
  AdzeConfigSchema,
  APPROVAL_POLICIES,
  type ConfigApprovalPolicy,
  type ConfigEffort,
  type ConfigHookFailure,
  type ConfigSandboxBroker,
  type ConfigSandboxMode,
  collectUnknownKeys,
  DEFAULT_APPROVAL_POLICY_CONFIG,
  DEFAULT_SANDBOX_MODE_CONFIG,
  EFFORTS,
  HOOK_FAILURE_MODES,
  isMarketplaceUrl,
  NARROWEST_APPROVAL_POLICY,
  NARROWEST_SANDBOX_MODE,
  SANDBOX_BROKERS,
  SANDBOX_MODES,
} from './schema.js';

/** Where a resolved value came from. `flag` is applied in `resolve.ts`. */
export type ConfigSource = 'flag' | 'env' | 'workspace' | 'user' | 'default';

export const CONFIG_FILENAME = join('.adze', 'config.jsonc');

/** Raised for an unreadable-in-principle file: bad JSONC syntax. Rendered as exit 2. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly hints: readonly string[];

  constructor(message: string, hints: readonly string[] = []) {
    super(message);
    this.hints = hints;
  }
}

export interface LoadOptions {
  /** Workspace to search for `.adze/config.jsonc`. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Home directory for the user-level config. Injectable for tests. */
  readonly home?: string;
  /** Injectable for tests, so nothing reads the real environment by accident. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Skip file lookup entirely. */
  readonly ignoreConfigFiles?: boolean;
}

export interface CommandRuleWithSource {
  readonly prefix: string;
  readonly source: ConfigSource;
}

export interface LoadedConfig {
  readonly engineModel: string | undefined;
  readonly engineModelSource: ConfigSource;
  readonly effort: ConfigEffort | undefined;
  readonly effortSource: ConfigSource;
  readonly temperature: number | undefined;
  readonly temperatureSource: ConfigSource;
  readonly maxTokens: number | undefined;
  readonly maxTokensSource: ConfigSource;
  readonly maxOutputTokens: number | undefined;
  readonly maxOutputTokensSource: ConfigSource;
  readonly sandboxBroker: ConfigSandboxBroker;
  readonly sandboxBrokerSource: ConfigSource;
  readonly sandboxMode: ConfigSandboxMode;
  readonly sandboxModeSource: ConfigSource;
  readonly writableRoots: readonly string[];
  readonly writableRootsSource: ConfigSource;
  readonly allowedNetworkHosts: readonly string[];
  readonly allowedNetworkHostsSource: ConfigSource;
  readonly approvalPolicy: ConfigApprovalPolicy;
  readonly approvalPolicySource: ConfigSource;
  readonly allowRules: readonly CommandRuleWithSource[];
  readonly forbidRules: readonly CommandRuleWithSource[];
  readonly promptRules: readonly CommandRuleWithSource[];
  readonly pluginsAllowUnsandboxedJs: boolean;
  readonly pluginsAllowUnsandboxedJsSource: ConfigSource;
  readonly pluginsAllowNative: boolean;
  readonly pluginsAllowNativeSource: ConfigSource;
  readonly pluginsOnHookFailure: ConfigHookFailure;
  readonly pluginsOnHookFailureSource: ConfigSource;
  readonly pluginsDirs: readonly string[];
  readonly pluginsDirsSource: ConfigSource;
  readonly pluginsEnable: readonly string[];
  readonly pluginsEnableSource: ConfigSource;
  readonly pluginsDisable: readonly string[];
  readonly pluginsDisableSource: ConfigSource;
  readonly workflowsTodo: boolean;
  readonly workflowsTodoSource: ConfigSource;
  readonly workflowsDefaultPack: string | undefined;
  readonly workflowsDefaultPackSource: ConfigSource;
  readonly galleryOpenVsxUrl: string | undefined;
  readonly galleryOpenVsxUrlSource: ConfigSource;
  readonly enginesAdze: string | undefined;
  readonly enginesAdzeSource: ConfigSource;
  /** Files that were read, for `doctor`. */
  readonly filesRead: readonly string[];
  /** Loud warnings: unknown keys, narrowed values, dropped rules, rejected URLs. */
  readonly warnings: readonly string[];
}

interface Layer {
  readonly source: Extract<ConfigSource, 'user' | 'workspace'>;
  readonly path: string;
  readonly config: AdzeConfig;
}

type SourcedValue<T> = { readonly value: T | undefined; readonly source: ConfigSource };

function readOneFile(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch(() => undefined);
}

function parseOneFile(path: string, raw: string, warnings: string[]): AdzeConfig | undefined {
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (cause) {
    throw new ConfigError(
      `${path} is not valid JSONC: ${cause instanceof Error ? cause.message : String(cause)}`,
      [
        'JSONC allows // and /* */ comments; everything else is strict JSON.',
        `Fix the syntax, or delete ${path} to fall back to defaults.`,
      ],
    );
  }
  if (parsed === undefined || parsed === null) return undefined;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${path} must hold a JSON object at the top level`, [
      'The file is `{ "engine": { "model": "provider/model" }, ... }`.',
      'See docs/guides/configuration.md for the full shape.',
    ]);
  }
  for (const key of collectUnknownKeys(parsed)) {
    warnings.push(
      `${path}: unknown key '${key}' is ignored. A typo'd policy key that does nothing is a refusal that never happens — fix the spelling or remove it.`,
    );
  }
  const result = AdzeConfigSchema.safeParse(parsed);
  if (result.success) return result.data;
  // Recovery, not refusal: keep every section that is an object wholesale and
  // let the per-field validators below decide each leaf — invalid narrows
  // fail-closed (read-only / never) with its own warning. Refusing the whole
  // file for one bad leaf would discard every other setting; dropping the bad
  // leaf silently would be worse. The one thing recovery must not do is lose
  // the knowledge that a key was *present but invalid*, which is why sections
  // are kept verbatim rather than re-validated here.
  return lenientParse(parsed, path, warnings);
}

/**
 * Best-effort recovery when strict parsing fails: keep the sections that are
 * objects verbatim, so one bad leaf does not discard every other setting in
 * the file. Leaves are validated downstream, where invalid narrows fail-closed
 * with a warning naming the file. Non-object sections cannot hold valid leaves
 * and are dropped with a warning of their own.
 */
function lenientParse(value: unknown, path: string, warnings: string[]): AdzeConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const section of [
    'engines',
    'engine',
    'sandbox',
    'approvals',
    'commandRules',
    'plugins',
    'workflows',
    'gallery',
  ]) {
    const child = record[section];
    if (child === undefined) continue;
    if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
      out[section] = child;
    } else {
      warnings.push(`${path}: '${section}' must be an object — ignored.`);
    }
  }
  if (typeof record.defaultModel === 'string') {
    out.defaultModel = record.defaultModel;
  } else if (record.defaultModel !== undefined && record.defaultModel !== null) {
    warnings.push(`${path}: 'defaultModel' must be a 'provider/model' string — ignored.`);
  }
  // Verbatim sections may hold invalid leaves; the per-field validators own
  // those warnings. The cast is contained: every reader below validates.
  return out as unknown as AdzeConfig;
}

// ---------------------------------------------------------------------------
// Per-field validators. Invalid narrows fail-closed with a warning; only
// `undefined` means "not set, let a lower layer decide".
// ---------------------------------------------------------------------------

function validModel(value: unknown, where: string, warnings: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  warnings.push(`${where}: engine.model must be a 'provider/model' reference — ignored.`);
  return undefined;
}

function validNonEmptyString(
  value: unknown,
  field: string,
  where: string,
  warnings: string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  warnings.push(`${where}: ${field} must be a non-empty string — ignored.`);
  return undefined;
}

function validEffort(value: unknown, where: string, warnings: string[]): ConfigEffort | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)) {
    return value as ConfigEffort;
  }
  warnings.push(
    `${where}: engine.effort '${String(value)}' is not one of ${EFFORTS.join(', ')} — ignored.`,
  );
  return undefined;
}

function validTemperature(value: unknown, where: string, warnings: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2) return value;
  warnings.push(
    `${where}: engine.temperature '${String(value)}' is not between 0 and 2 — ignored.`,
  );
  return undefined;
}

function validPositiveInt(
  value: unknown,
  field: string,
  where: string,
  warnings: string[],
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  warnings.push(`${where}: ${field} '${String(value)}' is not a positive whole number — ignored.`);
  return undefined;
}

function validSandboxMode(
  value: unknown,
  where: string,
  warnings: string[],
): ConfigSandboxMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (SANDBOX_MODES as readonly string[]).includes(value)) {
    return value as ConfigSandboxMode;
  }
  warnings.push(
    `${where}: sandbox.mode '${String(value)}' is not one of ${SANDBOX_MODES.join(', ')} — narrowed to '${NARROWEST_SANDBOX_MODE}' so a typo cannot grant more than was asked for.`,
  );
  return NARROWEST_SANDBOX_MODE;
}

function validApprovalPolicy(
  value: unknown,
  where: string,
  warnings: string[],
): ConfigApprovalPolicy | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (APPROVAL_POLICIES as readonly string[]).includes(value)) {
    return value as ConfigApprovalPolicy;
  }
  warnings.push(
    `${where}: approvals.policy '${String(value)}' is not one of ${APPROVAL_POLICIES.join(', ')} — narrowed to '${NARROWEST_APPROVAL_POLICY}' so a typo cannot grant more than was asked for.`,
  );
  return NARROWEST_APPROVAL_POLICY;
}

function validBroker(
  value: unknown,
  where: string,
  warnings: string[],
): ConfigSandboxBroker | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (SANDBOX_BROKERS as readonly string[]).includes(value)) {
    return value as ConfigSandboxBroker;
  }
  warnings.push(
    `${where}: sandbox.broker '${String(value)}' is not one of ${SANDBOX_BROKERS.join(', ')} — ignored, selection stays automatic.`,
  );
  return undefined;
}

function validStringList(
  value: unknown,
  field: string,
  where: string,
  warnings: string[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0)
  ) {
    return [...value] as string[];
  }
  warnings.push(`${where}: ${field} must be an array of non-empty strings — ignored.`);
  return undefined;
}

/**
 * Writable roots must be absolute. A relative root would resolve against
 * whatever the working directory happened to be, making the write boundary
 * ambient — so relatives are dropped with a warning rather than resolved.
 * `undefined` when nothing absolute remains, letting a lower layer decide.
 */
function validAbsoluteRoots(
  value: unknown,
  field: string,
  where: string,
  warnings: string[],
): string[] | undefined {
  const list = validStringList(value, field, where, warnings);
  if (list === undefined) return undefined;
  const absolute = list.filter((entry) => isAbsolute(entry));
  for (const entry of list) {
    if (!isAbsolute(entry)) {
      warnings.push(`${where}: ${field} '${entry}' is not an absolute path and is ignored.`);
    }
  }
  return absolute.length > 0 ? absolute : undefined;
}

function validBoolean(
  value: unknown,
  field: string,
  where: string,
  warnings: string[],
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  warnings.push(
    `${where}: ${field} '${String(value)}' is not a boolean — ignored (stays refused).`,
  );
  return undefined;
}

// ---------------------------------------------------------------------------
// Environment readers. Invalid warns and is ignored; blank is unset.
// ---------------------------------------------------------------------------

/** Split a comma-separated env list. A prefix containing a comma belongs in the file. */
function splitEnvList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Split an OS path list on `path.delimiter`. */
function splitEnvPaths(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed
    .split(delimiter)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const TRUE_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'y', 'on']);
const FALSE_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'no', 'n', 'off']);

function parseEnvBool(
  raw: string | undefined,
  name: string,
  warnings: string[],
): boolean | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const lower = trimmed.toLowerCase();
  if (TRUE_VALUES.has(lower)) return true;
  if (FALSE_VALUES.has(lower)) return false;
  warnings.push(`environment: ${name} '${trimmed}' is not a boolean — ignored (stays refused).`);
  return undefined;
}

/** Trimmed env value, or `undefined` when unset or blank. */
function envString(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** An env var constrained to an enum. Invalid warns and is ignored. */
function envEnum<T extends string>(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  allowed: readonly T[],
  warnings: string[],
  note: string,
  alias?: string,
): T | undefined {
  const raw = envString(env, name) ?? (alias === undefined ? undefined : envString(env, alias));
  if (raw === undefined) return undefined;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  warnings.push(`environment: ${name} '${raw}' is not one of ${allowed.join(', ')} — ${note}.`);
  return undefined;
}

/** An env var constrained to a positive whole number. Invalid warns and is ignored. */
function envPositiveInt(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  warnings: string[],
): number | undefined {
  const raw = envString(env, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  warnings.push(`environment: ${name} '${raw}' is not a positive whole number — ignored.`);
  return undefined;
}

/** An env var constrained to a closed range. Invalid warns and is ignored. */
function envRangedNumber(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  minimum: number,
  maximum: number,
  warnings: string[],
): number | undefined {
  const raw = envString(env, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum) return parsed;
  warnings.push(
    `environment: ${name} '${raw}' is not between ${minimum} and ${maximum} — ignored.`,
  );
  return undefined;
}

/** Absolute-path filtering for `ADZE_WRITABLE_ROOTS`, with warnings. */
function envWritableRoots(
  env: Readonly<Record<string, string | undefined>>,
  warnings: string[],
): string[] | undefined {
  const parsed = splitEnvPaths(env.ADZE_WRITABLE_ROOTS);
  if (parsed === undefined || parsed.length === 0) return undefined;
  const absolute = parsed.filter((entry) => isAbsolute(entry));
  for (const entry of parsed) {
    if (!isAbsolute(entry)) {
      warnings.push(`environment: ADZE_WRITABLE_ROOTS '${entry}' is not absolute and is ignored.`);
    }
  }
  return absolute.length > 0 ? absolute : undefined;
}

/** Overlay one env var over a file-derived value. Invalid env warns; files stand. */
function envOrFiles<T>(
  rawEnv: string | undefined,
  parse: () => T | undefined,
  fromFiles: SourcedValue<T>,
): SourcedValue<T> {
  if (rawEnv === undefined || rawEnv.trim().length === 0) return fromFiles;
  const parsed = parse();
  if (parsed === undefined) return { value: fromFiles.value, source: fromFiles.source };
  return { value: parsed, source: 'env' };
}

/**
 * Drop every `allow` overlapped by a `forbid` from any layer.
 *
 * Overlap means the same prefix, or an allow that extends a forbidden prefix
 * (`forbid "rm"`, `allow "rm -rf /tmp"`): at runtime the longest prefix would
 * otherwise win and the narrower grant would defeat the broader prohibition.
 * The prohibition wins regardless of which layer each came from — an explicit
 * refusal is the strongest statement of intent available, and letting a file
 * (or even a flag) quietly re-allow what another layer forbade is exactly the
 * refusal-into-grant weakening this module refuses. To allow something
 * forbidden, remove or narrow the `forbid`; the warning names it.
 */
export function applyForbidWins(
  allow: readonly CommandRuleWithSource[],
  forbid: readonly CommandRuleWithSource[],
  warnings: string[],
): readonly CommandRuleWithSource[] {
  return allow.filter((rule) => {
    const blocker = forbid.find(
      (ban) => rule.prefix === ban.prefix || rule.prefix.startsWith(ban.prefix),
    );
    if (blocker !== undefined) {
      warnings.push(
        `command rule allow '${rule.prefix}' (from ${rule.source}) overlaps forbid '${blocker.prefix}' (from ${blocker.source}) and is dropped: a refusal is never weakened into a grant. Remove or narrow the forbid to allow it.`,
      );
      return false;
    }
    return true;
  });
}

/** Dedupe exact-prefix collisions: forbidden always wins. */
function dedupeExact(
  allow: readonly CommandRuleWithSource[],
  forbid: readonly CommandRuleWithSource[],
  warnings: string[],
): readonly CommandRuleWithSource[] {
  return allow.filter((rule) => {
    const clash = forbid.find((ban) => ban.prefix === rule.prefix);
    if (clash !== undefined) {
      warnings.push(
        `command rule '${rule.prefix}' is both allowed (from ${rule.source}) and forbidden (from ${clash.source}): forbidden wins and the allow is dropped.`,
      );
      return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Layered resolution: files, then env, then (in resolve.ts) flags.
// ---------------------------------------------------------------------------

export async function loadCliConfig(options: LoadOptions = {}): Promise<LoadedConfig> {
  const warnings: string[] = [];
  const { layers, filesRead } = await readConfigLayers(options, warnings);
  const files = resolveFileValues(layers, warnings);
  return applyEnvironment(options.env ?? process.env, files, filesRead, warnings);
}

interface ConfigLayers {
  readonly layers: readonly Layer[];
  readonly filesRead: readonly string[];
}

/** Read the user and workspace files, nearest last so it wins. Absent is normal. */
async function readConfigLayers(options: LoadOptions, warnings: string[]): Promise<ConfigLayers> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const layers: Layer[] = [];
  const filesRead: string[] = [];

  if (options.ignoreConfigFiles === true) return { layers, filesRead };
  for (const [source, path] of [
    ['user', join(home, CONFIG_FILENAME)],
    ['workspace', join(resolve(cwd), CONFIG_FILENAME)],
  ] as const) {
    const raw = await readOneFile(path);
    if (raw === undefined) continue;
    const config = parseOneFile(path, raw, warnings);
    if (config === undefined) continue;
    filesRead.push(path);
    layers.push({ source, path, config });
  }
  return { layers, filesRead };
}

interface FileValues {
  readonly model: SourcedValue<string>;
  readonly defaultModelAlias: SourcedValue<string>;
  readonly effort: SourcedValue<ConfigEffort>;
  readonly temperature: SourcedValue<number>;
  readonly maxTokens: SourcedValue<number>;
  readonly maxOutputTokens: SourcedValue<number>;
  readonly broker: SourcedValue<ConfigSandboxBroker>;
  readonly mode: SourcedValue<ConfigSandboxMode>;
  readonly roots: SourcedValue<string[]>;
  readonly hosts: SourcedValue<string[]>;
  readonly policy: SourcedValue<ConfigApprovalPolicy>;
  readonly hookFailure: SourcedValue<ConfigHookFailure>;
  readonly js: SourcedValue<boolean>;
  readonly native: SourcedValue<boolean>;
  readonly todo: SourcedValue<boolean>;
  readonly pack: SourcedValue<string>;
  readonly gallery: SourcedValue<string>;
  readonly engines: SourcedValue<string>;
  readonly dirs: SourcedValue<string[]>;
  readonly enable: SourcedValue<string[]>;
  readonly disable: SourcedValue<string[]>;
  readonly allowRules: readonly CommandRuleWithSource[];
  readonly forbidRules: readonly CommandRuleWithSource[];
  readonly promptRules: readonly CommandRuleWithSource[];
}

/** Deprecation and invalid-enum warnings that need more than one leaf to decide. */
function warnFileAnomalies(
  layers: readonly Layer[],
  hasModel: boolean,
  hasAlias: boolean,
  warnings: string[],
): void {
  if (hasAlias && !hasModel) {
    warnings.push(
      `${layers[layers.length - 1]?.path ?? 'config'}: top-level 'defaultModel' is deprecated; use 'engine.model'.`,
    );
  }
  for (const layer of layers) {
    const value = layer.config.plugins?.onHookFailure;
    if (value !== undefined && !(HOOK_FAILURE_MODES as readonly string[]).includes(value)) {
      warnings.push(
        `${layer.path}: plugins.onHookFailure '${String(value)}' is not one of ${HOOK_FAILURE_MODES.join(', ')} — ignored (stays 'refuse').`,
      );
    }
    const todo = layer.config.workflows?.todo;
    if (todo !== undefined && typeof todo !== 'boolean') {
      warnings.push(`${layer.path}: workflows.todo '${String(todo)}' is not a boolean — ignored.`);
    }
  }
}

/** Everything the two files say, before the environment overlays it. */
function resolveFileValues(layers: readonly Layer[], warnings: string[]): FileValues {
  const layerValue = <T>(
    pick: (config: AdzeConfig) => T | undefined,
    validate: (value: T, where: string) => T | undefined = (value) => value,
  ): SourcedValue<T> => {
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const layer = layers[index];
      if (layer === undefined) continue;
      const raw = pick(layer.config);
      if (raw === undefined) continue;
      const valid = validate(raw, `${layer.path}`);
      // A present-but-invalid leaf narrows (fail-closed helpers return the
      // narrowed value); only `undefined` means "not set, keep looking".
      if (valid !== undefined) return { value: valid, source: layer.source };
      // Narrowed-to-undefined (ignored): a lower layer must not fill in for an
      // explicit-but-invalid higher value — that would let a permissive lower
      // file decide after a restrictive file typo'd. Stop here.
      return { value: undefined, source: layer.source };
    }
    return { value: undefined, source: 'default' };
  };

  // Boolean leaves that need type warnings when non-boolean. Function
  // declaration so uses below resolve regardless of order.
  function checkBool(pick: (config: AdzeConfig) => unknown, field: string): SourcedValue<boolean> {
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const layer = layers[index];
      if (layer === undefined) continue;
      const raw = pick(layer.config);
      if (raw === undefined) continue;
      const valid = validBoolean(raw, field, layer.path, warnings);
      if (valid !== undefined) return { value: valid, source: layer.source };
      return { value: undefined, source: layer.source };
    }
    return { value: undefined, source: 'default' };
  }

  const model = layerValue(
    (config) => config.engine?.model,
    (value, where) => validModel(value, where, warnings),
  );
  const defaultModelAlias = layerValue((config) =>
    typeof config.defaultModel === 'string' ? config.defaultModel : undefined,
  );
  warnFileAnomalies(
    layers,
    model.value !== undefined,
    defaultModelAlias.value !== undefined,
    warnings,
  );

  const allowRules: CommandRuleWithSource[] = [];
  const forbidRules: CommandRuleWithSource[] = [];
  const promptRules: CommandRuleWithSource[] = [];
  for (const layer of layers) {
    for (const prefix of layer.config.commandRules?.allow ?? []) {
      allowRules.push({ prefix, source: layer.source });
    }
    for (const prefix of layer.config.commandRules?.forbid ?? []) {
      forbidRules.push({ prefix, source: layer.source });
    }
    for (const prefix of layer.config.commandRules?.prompt ?? []) {
      promptRules.push({ prefix, source: layer.source });
    }
  }

  return {
    model,
    defaultModelAlias,
    effort: layerValue(
      (config) => config.engine?.effort,
      (value, where) => validEffort(value, where, warnings),
    ),
    temperature: layerValue(
      (config) => config.engine?.temperature,
      (value, where) => validTemperature(value, where, warnings),
    ),
    maxTokens: layerValue(
      (config) => config.engine?.maxTokens,
      (value, where) => validPositiveInt(value, 'engine.maxTokens', where, warnings),
    ),
    maxOutputTokens: layerValue(
      (config) => config.engine?.maxOutputTokens,
      (value, where) => validPositiveInt(value, 'engine.maxOutputTokens', where, warnings),
    ),
    broker: layerValue(
      (config) => config.sandbox?.broker,
      (value, where) => validBroker(value, where, warnings),
    ),
    mode: layerValue(
      (config) => config.sandbox?.mode,
      (value, where) => validSandboxMode(value, where, warnings),
    ),
    roots: layerValue(
      (config) => config.sandbox?.writableRoots,
      (value, where) => validAbsoluteRoots(value, 'sandbox.writableRoots', where, warnings),
    ),
    hosts: layerValue(
      (config) => config.sandbox?.allowedNetworkHosts,
      (value, where) => validStringList(value, 'sandbox.allowedNetworkHosts', where, warnings),
    ),
    policy: layerValue(
      (config) => config.approvals?.policy,
      (value, where) => validApprovalPolicy(value, where, warnings),
    ),
    hookFailure: layerValue((config) => {
      const value = config.plugins?.onHookFailure;
      if (value === undefined) return undefined;
      if ((HOOK_FAILURE_MODES as readonly string[]).includes(value)) return value;
      return undefined;
    }),
    js: checkBool((config) => config.plugins?.allowUnsandboxedJs, 'plugins.allowUnsandboxedJs'),
    native: checkBool((config) => config.plugins?.allowNative, 'plugins.allowNative'),
    todo: checkBool((config) => config.workflows?.todo, 'workflows.todo'),
    pack: layerValue(
      (config) => config.workflows?.defaultPack,
      (value, where) => validNonEmptyString(value, 'workflows.defaultPack', where, warnings),
    ),
    gallery: layerValue(
      (config) => config.gallery?.openVsxUrl,
      (value, where) => validNonEmptyString(value, 'gallery.openVsxUrl', where, warnings),
    ),
    engines: layerValue(
      (config) => config.engines?.adze,
      (value, where) => validNonEmptyString(value, 'engines.adze', where, warnings),
    ),
    dirs: layerValue(
      (config) => config.plugins?.dirs,
      (value, where) => validStringList(value, 'plugins.dirs', where, warnings),
    ),
    enable: layerValue(
      (config) => config.plugins?.enable,
      (value, where) => validStringList(value, 'plugins.enable', where, warnings),
    ),
    disable: layerValue(
      (config) => config.plugins?.disable,
      (value, where) => validStringList(value, 'plugins.disable', where, warnings),
    ),
    allowRules,
    forbidRules,
    promptRules,
  };
}

interface ScalarOverlays {
  readonly engineModel: SourcedValue<string>;
  readonly effort: SourcedValue<ConfigEffort>;
  readonly temperature: SourcedValue<number>;
  readonly maxTokens: SourcedValue<number>;
  readonly maxOutputTokens: SourcedValue<number>;
  readonly sandboxBroker: SourcedValue<ConfigSandboxBroker>;
  readonly sandboxMode: SourcedValue<ConfigSandboxMode>;
  readonly writableRoots: SourcedValue<string[]>;
  readonly allowedNetworkHosts: SourcedValue<string[]>;
  readonly approvalPolicy: SourcedValue<ConfigApprovalPolicy>;
}

/** Engine, sandbox, and approval scalars: env over files. */
function overlayScalars(
  env: Readonly<Record<string, string | undefined>>,
  files: FileValues,
  warnings: string[],
): ScalarOverlays {
  return {
    engineModel: envOrFiles(envString(env, 'ADZE_MODEL'), () => envString(env, 'ADZE_MODEL'), {
      value: files.model.value ?? files.defaultModelAlias.value,
      source: files.model.value !== undefined ? files.model.source : files.defaultModelAlias.source,
    }),
    effort: envOrFiles(
      envString(env, 'ADZE_EFFORT'),
      () => envEnum(env, 'ADZE_EFFORT', EFFORTS, warnings, 'ignored'),
      files.effort,
    ),
    temperature: envOrFiles(
      envString(env, 'ADZE_TEMPERATURE'),
      () => envRangedNumber(env, 'ADZE_TEMPERATURE', 0, 2, warnings),
      files.temperature,
    ),
    maxTokens: envOrFiles(
      envString(env, 'ADZE_MAX_TOKENS'),
      () => envPositiveInt(env, 'ADZE_MAX_TOKENS', warnings),
      files.maxTokens,
    ),
    maxOutputTokens: envOrFiles(
      envString(env, 'ADZE_MAX_OUTPUT_TOKENS'),
      () => envPositiveInt(env, 'ADZE_MAX_OUTPUT_TOKENS', warnings),
      files.maxOutputTokens,
    ),
    sandboxBroker: envOrFiles(
      envString(env, 'ADZE_SANDBOX_BROKER'),
      () =>
        envEnum(
          env,
          'ADZE_SANDBOX_BROKER',
          SANDBOX_BROKERS,
          warnings,
          'ignored, selection stays automatic',
        ),
      files.broker,
    ),
    sandboxMode: envOrFiles(
      envString(env, 'ADZE_SANDBOX_MODE') ?? envString(env, 'ADZE_SANDBOX'),
      () => envEnum(env, 'ADZE_SANDBOX_MODE', SANDBOX_MODES, warnings, 'ignored', 'ADZE_SANDBOX'),
      files.mode,
    ),
    writableRoots: envOrFiles(
      envString(env, 'ADZE_WRITABLE_ROOTS'),
      () => envWritableRoots(env, warnings),
      files.roots,
    ),
    allowedNetworkHosts: envOrFiles(
      envString(env, 'ADZE_ALLOWED_HOSTS'),
      () => {
        const parsed = splitEnvList(env.ADZE_ALLOWED_HOSTS);
        return parsed === undefined || parsed.length === 0 ? undefined : parsed;
      },
      files.hosts,
    ),
    approvalPolicy: envOrFiles(
      envString(env, 'ADZE_APPROVAL_POLICY') ?? envString(env, 'ADZE_APPROVAL'),
      () =>
        envEnum(
          env,
          'ADZE_APPROVAL_POLICY',
          APPROVAL_POLICIES,
          warnings,
          'ignored',
          'ADZE_APPROVAL',
        ),
      files.policy,
    ),
  };
}

interface RuleOverlays {
  readonly allow: readonly CommandRuleWithSource[];
  readonly forbid: readonly CommandRuleWithSource[];
  readonly prompt: readonly CommandRuleWithSource[];
}

/** File union plus env, then the forbid-wins filter over the combined set. */
function overlayRules(
  env: Readonly<Record<string, string | undefined>>,
  files: FileValues,
  warnings: string[],
): RuleOverlays {
  const allow: CommandRuleWithSource[] = [...files.allowRules];
  const forbid: CommandRuleWithSource[] = [...files.forbidRules];
  const prompt: CommandRuleWithSource[] = [...files.promptRules];
  // Env rules are comma-separated; a prefix containing a comma belongs in the file.
  for (const prefix of splitEnvList(env.ADZE_ALLOW) ?? []) {
    allow.push({ prefix, source: 'env' });
  }
  for (const prefix of splitEnvList(env.ADZE_FORBID) ?? []) {
    forbid.push({ prefix, source: 'env' });
  }
  for (const prefix of splitEnvList(env.ADZE_PROMPT) ?? []) {
    prompt.push({ prefix, source: 'env' });
  }
  return {
    allow: applyForbidWins(dedupeExact(allow, forbid, warnings), forbid, warnings),
    forbid,
    prompt,
  };
}

interface TailOverlays {
  readonly pluginsAllowUnsandboxedJs: SourcedValue<boolean>;
  readonly pluginsAllowNative: SourcedValue<boolean>;
  readonly pluginsOnHookFailure: SourcedValue<ConfigHookFailure>;
  readonly workflowsTodo: SourcedValue<boolean>;
  readonly workflowsDefaultPack: SourcedValue<string>;
  readonly galleryOpenVsxUrl: string | undefined;
  readonly galleryOpenVsxUrlSource: ConfigSource;
  readonly enginesAdze: SourcedValue<string>;
}

/** Plugins, workflows, gallery, engines: env over files. */
function overlayTail(
  env: Readonly<Record<string, string | undefined>>,
  files: FileValues,
  warnings: string[],
): TailOverlays {
  const galleryCandidate = envOrFiles(
    envString(env, 'ADZE_OPENVSX_URL'),
    () => envString(env, 'ADZE_OPENVSX_URL'),
    files.gallery,
  );
  let galleryOpenVsxUrl = galleryCandidate.value;
  let galleryOpenVsxUrlSource = galleryCandidate.source;
  if (galleryOpenVsxUrl !== undefined && isMarketplaceUrl(galleryOpenVsxUrl)) {
    warnings.push(
      `${galleryOpenVsxUrlSource === 'env' ? 'environment: ADZE_OPENVSX_URL' : 'config: gallery.openVsxUrl'} names Microsoft's Marketplace, which forks may not use (docs/architecture/adr/0009-extension-gallery.md) — ignored.`,
    );
    galleryOpenVsxUrl = undefined;
    galleryOpenVsxUrlSource = 'default';
  }
  return {
    pluginsAllowUnsandboxedJs: envOrFiles(
      envString(env, 'ADZE_ALLOW_UNSANDBOXED_JS'),
      () => parseEnvBool(env.ADZE_ALLOW_UNSANDBOXED_JS, 'ADZE_ALLOW_UNSANDBOXED_JS', warnings),
      files.js,
    ),
    pluginsAllowNative: envOrFiles(
      envString(env, 'ADZE_ALLOW_NATIVE'),
      () => parseEnvBool(env.ADZE_ALLOW_NATIVE, 'ADZE_ALLOW_NATIVE', warnings),
      files.native,
    ),
    pluginsOnHookFailure: envOrFiles(
      envString(env, 'ADZE_ON_HOOK_FAILURE'),
      () =>
        envEnum(
          env,
          'ADZE_ON_HOOK_FAILURE',
          HOOK_FAILURE_MODES,
          warnings,
          "ignored (stays 'refuse')",
        ),
      files.hookFailure,
    ),
    workflowsTodo: {
      value: files.todo.value ?? true,
      source: files.todo.value !== undefined ? files.todo.source : 'default',
    },
    workflowsDefaultPack: envOrFiles(
      envString(env, 'ADZE_DEFAULT_PACK'),
      () => envString(env, 'ADZE_DEFAULT_PACK'),
      files.pack,
    ),
    galleryOpenVsxUrl,
    galleryOpenVsxUrlSource,
    enginesAdze: files.engines,
  };
}

function applyEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  files: FileValues,
  filesRead: readonly string[],
  warnings: string[],
): LoadedConfig {
  const scalars = overlayScalars(env, files, warnings);
  const rules = overlayRules(env, files, warnings);
  const tail = overlayTail(env, files, warnings);
  const broker = withFallback(scalars.sandboxBroker, 'auto' as const);
  const mode = withFallback(scalars.sandboxMode, DEFAULT_SANDBOX_MODE_CONFIG);
  const roots = withFallback(scalars.writableRoots, []);
  const hosts = withFallback(scalars.allowedNetworkHosts, []);
  const policy = withFallback(scalars.approvalPolicy, DEFAULT_APPROVAL_POLICY_CONFIG);
  const allowJs = withFallback(tail.pluginsAllowUnsandboxedJs, false);
  const allowNative = withFallback(tail.pluginsAllowNative, false);
  const hookFailure = withFallback(tail.pluginsOnHookFailure, 'refuse' as const);
  const dirs = withFallback(files.dirs, []);
  const enable = withFallback(files.enable, []);
  const disable = withFallback(files.disable, []);
  const pack = tail.workflowsDefaultPack;
  const todo = withFallback(tail.workflowsTodo, true);
  const engines = tail.enginesAdze;
  return {
    engineModel: scalars.engineModel.value,
    engineModelSource: scalars.engineModel.source,
    effort: scalars.effort.value,
    effortSource: scalars.effort.source,
    temperature: scalars.temperature.value,
    temperatureSource: scalars.temperature.source,
    maxTokens: scalars.maxTokens.value,
    maxTokensSource: scalars.maxTokens.source,
    maxOutputTokens: scalars.maxOutputTokens.value,
    maxOutputTokensSource: scalars.maxOutputTokens.source,
    sandboxBroker: broker.value,
    sandboxBrokerSource: broker.source,
    sandboxMode: mode.value,
    sandboxModeSource: mode.source,
    writableRoots: roots.value,
    writableRootsSource: roots.source,
    allowedNetworkHosts: hosts.value,
    allowedNetworkHostsSource: hosts.source,
    approvalPolicy: policy.value,
    approvalPolicySource: policy.source,
    allowRules: rules.allow,
    forbidRules: rules.forbid,
    promptRules: rules.prompt,
    pluginsAllowUnsandboxedJs: allowJs.value,
    pluginsAllowUnsandboxedJsSource: allowJs.source,
    pluginsAllowNative: allowNative.value,
    pluginsAllowNativeSource: allowNative.source,
    pluginsOnHookFailure: hookFailure.value,
    pluginsOnHookFailureSource: hookFailure.source,
    pluginsDirs: dirs.value,
    pluginsDirsSource: dirs.source,
    pluginsEnable: enable.value,
    pluginsEnableSource: enable.source,
    pluginsDisable: disable.value,
    pluginsDisableSource: disable.source,
    workflowsTodo: todo.value,
    workflowsTodoSource: todo.source,
    workflowsDefaultPack: pack.value,
    workflowsDefaultPackSource: pack.source,
    galleryOpenVsxUrl: tail.galleryOpenVsxUrl,
    galleryOpenVsxUrlSource: tail.galleryOpenVsxUrlSource,
    enginesAdze: engines.value,
    enginesAdzeSource: engines.source,
    filesRead,
    warnings,
  };
}

/** A sourced value with the documented default filled in when unset. */
function withFallback<T>(
  sourced: SourcedValue<T>,
  fallback: T,
): { readonly value: T; readonly source: ConfigSource } {
  if (sourced.value !== undefined) return { value: sourced.value, source: sourced.source };
  return { value: fallback, source: 'default' };
}
