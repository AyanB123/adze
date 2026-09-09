/**
 * The full `.adze/config.jsonc` schema — the M2 remainder after the provider slice.
 *
 * The provider slice lives in `@adze/providers` as strict JSON
 * (`.adze/providers.json`); everything else lives here as JSONC. The split is
 * deliberate: credentials stay in the providers file and the environment, never
 * in this one, so `chat /init` can scaffold this file without ever writing a
 * secret.
 *
 * ### Fail-closed parsing (ADR-0007)
 *
 * An invalid sandbox mode narrows to `read-only` and an invalid approval policy
 * narrows to `never`, with a warning — never to the documented defaults
 * (`workspace-write` / `on-request`), which would grant more than was asked for.
 * That mirrors the VS Code settings (`apps/vscode/src/settings.ts`) and the CLI
 * flag parser (`src/agent/flags.ts`), which both refuse an invalid value rather
 * than defaulting permissively. A typo that quietly becomes the permissive
 * default is the failure the permission model exists to prevent.
 *
 * ### Unknown keys warn, never silently ignored
 *
 * Zod objects here are non-strict so parsing continues, and {@link collectUnknownKeys}
 * reports every key the schema does not recognise as a warning carrying its dotted
 * path. A typo'd policy key that does nothing is a FINDINGS-class defect: the user
 * believes a boundary exists where none does.
 *
 * ### Prefix rules match the requested command (ADR-0013)
 *
 * `commandRules` are matched against what the model asked to run, not the argv
 * the `bash` tool executes — so `--forbid "rm "` refuses `rm -rf /` and
 * `--allow "pnpm test"` fires. The matching itself is unchanged; this file only
 * collects the rules. Merging across layers is in `loader.ts`, where a lower
 * layer may never weaken a higher layer's refusal into a grant.
 *
 * ### Gallery (ADR-0009)
 *
 * Only an Open VSX URL is accepted. A URL naming Microsoft's Marketplace is
 * rejected with a warning and ignored: pointing a fork at that gallery violates
 * its Terms of Use (§2(b), §3), and the config must not be the vehicle for it.
 */

import { z } from 'zod';

export const EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
export type ConfigEffort = (typeof EFFORTS)[number];

export const SANDBOX_MODES = ['read-only', 'workspace-write', 'full-access'] as const;
export type ConfigSandboxMode = (typeof SANDBOX_MODES)[number];

export const APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'] as const;
export type ConfigApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

/** Fail-closed values. See the file comment. */
export const NARROWEST_SANDBOX_MODE: ConfigSandboxMode = 'read-only';
export const NARROWEST_APPROVAL_POLICY: ConfigApprovalPolicy = 'never';

/** Documented defaults, used only when nothing sets a value. */
export const DEFAULT_SANDBOX_MODE_CONFIG: ConfigSandboxMode = 'workspace-write';
export const DEFAULT_APPROVAL_POLICY_CONFIG: ConfigApprovalPolicy = 'on-request';

/** `sandbox.broker`: which mechanism to prefer. `auto` is the current selection. */
export const SANDBOX_BROKERS = [
  'auto',
  'seatbelt',
  'bubblewrap',
  'docker',
  'windows-partial',
  'none',
] as const;
export type ConfigSandboxBroker = (typeof SANDBOX_BROKERS)[number];

export const HOOK_FAILURE_MODES = ['refuse', 'warn'] as const;
export type ConfigHookFailure = (typeof HOOK_FAILURE_MODES)[number];

const EngineSchema = z.object({
  model: z.string().min(1).optional(),
  effort: z.enum(EFFORTS).optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** Budget ceiling: total tokens for the turn. Positive, omitted when unbounded. */
  maxTokens: z.number().int().positive().optional(),
  /** Per-request cap forwarded to the provider. Positive, omitted when unset. */
  maxOutputTokens: z.number().int().positive().optional(),
});

const SandboxSchema = z.object({
  broker: z.enum(SANDBOX_BROKERS).optional(),
  mode: z.enum(SANDBOX_MODES).optional(),
  writableRoots: z.array(z.string().min(1)).optional(),
  allowedNetworkHosts: z.array(z.string().min(1)).optional(),
});

const ApprovalsSchema = z.object({
  policy: z.enum(APPROVAL_POLICIES).optional(),
});

const CommandRulesSchema = z.object({
  allow: z.array(z.string().min(1)).optional(),
  forbid: z.array(z.string().min(1)).optional(),
  /** Protocol-level `prompt` action. Accepted so config is not less expressive. */
  prompt: z.array(z.string().min(1)).optional(),
});

const PluginsSchema = z.object({
  allowUnsandboxedJs: z.boolean().optional(),
  allowNative: z.boolean().optional(),
  onHookFailure: z.enum(HOOK_FAILURE_MODES).optional(),
  /** Extra directories to load plugins from. */
  dirs: z.array(z.string().min(1)).optional(),
  /** Plugin ids to enable. Empty means no filter. */
  enable: z.array(z.string().min(1)).optional(),
  /** Plugin ids to disable. Wins over `enable` on overlap. */
  disable: z.array(z.string().min(1)).optional(),
  /** Per-plugin opaque settings, keyed by plugin id. */
  config: z.record(z.string().min(1), z.unknown()).optional(),
});

const WorkflowsSchema = z.object({
  /** Whether the `todo` planning tool is available. Defaults to true. */
  todo: z.boolean().optional(),
  /** Default workflow pack id. */
  defaultPack: z.string().min(1).optional(),
});

const GallerySchema = z.object({
  openVsxUrl: z.string().min(1).optional(),
});

const EnginesSchema = z.object({
  adze: z.string().min(1).optional(),
});

/**
 * Top-level shape. Non-strict on purpose: unknown keys are reported by
 * {@link collectUnknownKeys} and stripped, so parsing continues and `doctor`
 * can show what was ignored rather than the run dying on a forward-compatible
 * key — while a typo'd policy key still warns loudly.
 */
export const AdzeConfigSchema = z.object({
  $schema: z.string().optional(),
  engines: EnginesSchema.optional(),
  engine: EngineSchema.optional(),
  sandbox: SandboxSchema.optional(),
  approvals: ApprovalsSchema.optional(),
  commandRules: CommandRulesSchema.optional(),
  plugins: PluginsSchema.optional(),
  workflows: WorkflowsSchema.optional(),
  gallery: GallerySchema.optional(),
  /** Deprecated alias for `engine.model`. Warns when used. */
  defaultModel: z.string().min(1).nullable().optional(),
});

export type AdzeConfig = z.infer<typeof AdzeConfigSchema>;

/** Known top-level keys, for the unknown-key scan. `$schema` never warns. */
const KNOWN_TOP_LEVEL: ReadonlySet<string> = new Set([
  '$schema',
  'engines',
  'engine',
  'sandbox',
  'approvals',
  'commandRules',
  'plugins',
  'workflows',
  'gallery',
  'defaultModel',
]);

/** Known nested keys per section. */
const KNOWN_NESTED: Readonly<Record<string, ReadonlySet<string>>> = {
  engines: new Set(['adze']),
  engine: new Set(['model', 'effort', 'temperature', 'maxTokens', 'maxOutputTokens']),
  sandbox: new Set(['broker', 'mode', 'writableRoots', 'allowedNetworkHosts']),
  approvals: new Set(['policy']),
  commandRules: new Set(['allow', 'forbid', 'prompt']),
  plugins: new Set([
    'allowUnsandboxedJs',
    'allowNative',
    'onHookFailure',
    'dirs',
    'enable',
    'disable',
    'config',
  ]),
  workflows: new Set(['todo', 'defaultPack']),
  gallery: new Set(['openVsxUrl']),
};

/**
 * Every key in `value` the schema does not recognise, as dotted paths.
 *
 * Reports top-level and one level of nesting — the full depth of this schema —
 * so `approval: { pollicy: ... }` (wrong section) and
 * `approvals: { pollicy: ... }` (typo in the right section) both warn with the
 * path that names the mistake.
 */
export function collectUnknownKeys(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const unknown: string[] = [];
  for (const key of Object.keys(record)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      unknown.push(key);
      continue;
    }
    const nested = KNOWN_NESTED[key];
    const child = record[key];
    if (
      nested !== undefined &&
      typeof child === 'object' &&
      child !== null &&
      !Array.isArray(child)
    ) {
      for (const childKey of Object.keys(child as Record<string, unknown>)) {
        if (!nested.has(childKey)) unknown.push(`${key}.${childKey}`);
      }
    }
  }
  return unknown;
}

/** True when a gallery URL names Microsoft's Marketplace. Rejected per ADR-0009. */
export function isMarketplaceUrl(url: string): boolean {
  return url.toLowerCase().includes('marketplace.visualstudio.com');
}
