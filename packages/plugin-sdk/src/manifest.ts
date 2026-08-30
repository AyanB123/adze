/**
 * The plugin manifest: `adze.plugin.json`.
 *
 * A plugin is a directory containing this file, and for most plugins it is the
 * only file that matters — a tool integration, a context provider, a slash
 * command, and a subagent are all pure declaration. That is the easy path on
 * purpose (ADR-0008): requiring a toolchain to contribute a slash command would
 * cut the contributor pool to programmers, and the surfaces most likely to be
 * wrong are the ones fewest people can try.
 *
 * ## Validation is refusal, not repair
 *
 * Every failure below returns a diagnostic naming the field, what was found, and
 * what was expected. Nothing is defaulted-through: a manifest with an unreadable
 * `engines.adze` range is refused rather than loaded optimistically, because the
 * alternative is a plugin running against an engine its author never tested and a
 * failure that surfaces later as a mysterious runtime error.
 *
 * ## Where this file deviates from `docs/plugins/spec.md`
 *
 * The spec shows `contributes.commands`, `contributes.hooks`, `contributes.agents`,
 * and `contributes.ui` as `[ /* surface N *\/ ]` — a comment where the entry shape
 * should be. Only `contributes.tools` and `contributes.contextProviders` have a
 * worked example. The shapes below are therefore this implementation's answer, and
 * the ones to argue with:
 *
 * - **Commands and agents are file references** (`{ "path": "commands/review.md" }`),
 *   because the spec's own directory layout puts the definition in a markdown file
 *   with front matter, and duplicating `name` and `description` into the manifest
 *   would create two sources of truth that can disagree.
 * - **Hook entries gained a `runtime` field.** The spec's example is
 *   `{ "event": ..., "module": "hooks/policy.wasm", "timeoutMs": 500 }`, which
 *   leaves the execution model implicit in a file extension. Inference from the
 *   extension is kept as the default, but a native (unsandboxed) module cannot be
 *   inferred safely and has to say so.
 * - **`timeoutMs` has no default in the spec.** It defaults to
 *   {@link DEFAULT_HOOK_TIMEOUT_MS} here, and the value is stated rather than
 *   hidden, because an unbounded hook in the hot path is a latency bug the plugin
 *   author will not be the one to notice.
 * - **`id` must contain exactly one dot.** The spec says `<namespace>.<name>`
 *   without saying whether `acme.team.guard` is legal. One dot keeps
 *   {@link namespaceOf} unambiguous, which matters because namespace claims are
 *   the defence against squatting.
 */

import { z } from 'zod';
import { satisfiesRange } from './semver.js';
import { describeFindings, scanForHiddenCharacters } from './unicode.js';

/** Applied when a hook entry omits `timeoutMs`. See the header. */
export const DEFAULT_HOOK_TIMEOUT_MS = 500;

/**
 * Ceiling on a declared hook timeout.
 *
 * A hook is synchronous with respect to the agent's progress, so a 30-second hook
 * is indistinguishable from a hang. The cap is high enough for a policy check that
 * reads files and low enough that a mistake is recoverable without killing the
 * process.
 */
export const MAX_HOOK_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Hook events — all nine from the spec
// ---------------------------------------------------------------------------

/**
 * The lifecycle points a hook can attach to.
 *
 * `tool.pre` and `edit.pre` are the two that may deny. The rest observe or
 * enrich, which is why only those two carry a decision type.
 */
export const HOOK_EVENTS = [
  'session.start',
  'session.turnStart',
  'context.pre',
  'tool.pre',
  'tool.post',
  'edit.pre',
  'edit.post',
  'session.compact',
  'session.turnEnd',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The two events whose hooks may veto. */
export const VETO_EVENTS: readonly HookEvent[] = ['tool.pre', 'edit.pre'];

export function canVeto(event: HookEvent): boolean {
  return VETO_EVENTS.includes(event);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * `<namespace>.<name>`, lowercase.
 *
 * Enforced here rather than by convention because the namespace is a trust
 * boundary: an unclaimed namespace is how researchers targeted users of four
 * major VS Code forks, so the part of the id that a claim applies to has to be
 * mechanically extractable.
 */
const PluginIdSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    'must be <namespace>.<name>, lowercase letters, digits and hyphens only, exactly one dot',
  );

const SemverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    'must be a semantic version such as 1.2.0',
  );

/**
 * A path inside the plugin directory.
 *
 * Absolute paths and `..` segments are rejected at the schema level. A manifest is
 * data from an untrusted source, and a module path that can leave the plugin
 * directory is an arbitrary-file-read primitive before any sandbox is involved.
 */
const RelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !/^[A-Za-z]:/.test(value), {
    message: 'must be relative to the plugin directory, not absolute',
  })
  .refine((value) => !value.split(/[\\/]/).includes('..'), {
    message: 'must not contain a ".." segment: a plugin may not reference files outside itself',
  });

/** Surface 1. Structurally the `McpServerConfig` of `@adze/mcp`. */
const ToolContributionSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['stdio', 'http']),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** Sandbox mode for the subprocess. Advice to the surface, never a gate bypass. */
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  autoApprove: z.array(z.string()).optional(),
  connectTimeoutMs: z.number().int().positive().optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  maxResultBytes: z.number().int().positive().optional(),
});

/** Surface 2. `@trigger` is what a prompt writes to pull the content in. */
const TriggerSchema = z
  .string()
  .regex(/^@[a-z0-9][a-z0-9-]*$/, 'must look like @name, lowercase letters, digits and hyphens');

const ContextProviderContributionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('glob'),
    name: z.string().min(1),
    patterns: z.array(z.string().min(1)).min(1),
    trigger: TriggerSchema,
    /** Hard cap on the bytes this provider may contribute. */
    maxBytes: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('wasm'),
    name: z.string().min(1),
    module: RelativePathSchema,
    trigger: TriggerSchema,
    timeoutMs: z.number().int().positive().max(MAX_HOOK_TIMEOUT_MS).optional(),
    maxBytes: z.number().int().positive().optional(),
  }),
]);

/** Surface 3 and surface 5: a file reference. See the header for why. */
const FileContributionSchema = z.object({
  path: RelativePathSchema,
});

/**
 * How a hook module is executed.
 *
 * `native` exists so an unsandboxed plugin can be *labelled* as one. It is never
 * inferred from a file extension and never loaded without an explicit host opt-in,
 * because the whole point of the label is that a user gets to decline it.
 */
const HookRuntimeSchema = z.enum(['wasm', 'js', 'native']);

/** Surface 4. */
const HookContributionSchema = z.object({
  event: z.enum(HOOK_EVENTS),
  module: RelativePathSchema,
  runtime: HookRuntimeSchema.optional(),
  timeoutMs: z.number().int().positive().max(MAX_HOOK_TIMEOUT_MS).optional(),
  /** Exported function name, for a module that offers more than one hook. */
  export: z.string().min(1).optional(),
});

/**
 * Surface 6. Declared in the manifest, accepted only by a surface.
 *
 * The type exists here so a manifest carrying UI is *valid* — refusing to parse it
 * would mean a plugin with both a hook and a panel could not be loaded engine-side
 * at all. The engine host drops these and records why; see `ui.ts`.
 */
const UiContributionSchema = z.object({
  surface: z.enum(['cli', 'vscode', 'ide']),
  id: z.string().min(1),
  kind: z.string().min(1),
  title: z.string().min(1).optional(),
  entry: RelativePathSchema.optional(),
});

const PermissionsSchema = z.object({
  filesystem: z.enum(['none', 'read', 'workspace-write']).optional(),
  network: z.array(z.string().min(1)).optional(),
  env: z.array(z.string().min(1)).optional(),
});

const ContributesSchema = z.object({
  tools: z.array(ToolContributionSchema).optional(),
  contextProviders: z.array(ContextProviderContributionSchema).optional(),
  commands: z.array(FileContributionSchema).optional(),
  hooks: z.array(HookContributionSchema).optional(),
  agents: z.array(FileContributionSchema).optional(),
  ui: z.array(UiContributionSchema).optional(),
});

export const PluginManifestSchema = z.object({
  $schema: z.string().optional(),
  id: PluginIdSchema,
  version: SemverSchema,
  displayName: z.string().min(1),
  description: z.string().min(1),
  license: z.string().min(1),
  repository: z.string().min(1),
  engines: z.object({ adze: z.string().min(1) }),
  contributes: ContributesSchema.optional(),
  permissions: PermissionsSchema.optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type ToolContribution = z.infer<typeof ToolContributionSchema>;
export type ContextProviderContribution = z.infer<typeof ContextProviderContributionSchema>;
export type FileContribution = z.infer<typeof FileContributionSchema>;
export type HookContribution = z.infer<typeof HookContributionSchema>;
export type HookRuntime = z.infer<typeof HookRuntimeSchema>;
export type UiContribution = z.infer<typeof UiContributionSchema>;

/**
 * Requested capabilities, normalized so absent means none.
 *
 * Deny by default. A manifest that omits `permissions` gets no filesystem access,
 * no network, and no environment, rather than inheriting the session's — a plugin
 * that never said what it needs has not earned anything.
 */
export interface PluginPermissions {
  readonly filesystem: 'none' | 'read' | 'workspace-write';
  readonly network: readonly string[];
  readonly env: readonly string[];
}

export const NO_PERMISSIONS: PluginPermissions = {
  filesystem: 'none',
  network: [],
  env: [],
};

export function normalizePermissions(
  requested: z.infer<typeof PermissionsSchema> | undefined,
): PluginPermissions {
  return {
    filesystem: requested?.filesystem ?? 'none',
    network: [...(requested?.network ?? [])],
    env: [...(requested?.env ?? [])],
  };
}

export function namespaceOf(id: string): string {
  const dot = id.indexOf('.');
  return dot < 0 ? id : id.slice(0, dot);
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = 'error' | 'warning';

export interface PluginDiagnostic {
  readonly severity: DiagnosticSeverity;
  /** Stable code, so a surface can group without parsing prose. */
  readonly code: PluginDiagnosticCode;
  /** Dotted manifest path when the problem has one. */
  readonly field?: string;
  /** Addressed to the plugin author or to the user deciding whether to install. */
  readonly message: string;
}

export type PluginDiagnosticCode =
  | 'manifest-unreadable'
  | 'manifest-invalid-json'
  | 'manifest-schema'
  | 'hidden-characters'
  | 'engine-range-unparseable'
  | 'engine-mismatch'
  | 'transport-fields'
  | 'duplicate-name'
  | 'file-missing'
  | 'frontmatter-invalid'
  | 'module-unloadable'
  | 'native-not-permitted'
  | 'ui-refused-by-engine'
  | 'hook-timeout'
  | 'hook-error'
  | 'permission-narrowed';

export function errorDiagnostic(
  code: PluginDiagnosticCode,
  message: string,
  field?: string,
): PluginDiagnostic {
  return field === undefined
    ? { severity: 'error', code, message }
    : { severity: 'error', code, field, message };
}

export function warningDiagnostic(
  code: PluginDiagnosticCode,
  message: string,
  field?: string,
): PluginDiagnostic {
  return field === undefined
    ? { severity: 'warning', code, message }
    : { severity: 'warning', code, field, message };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type ManifestParseOutcome =
  | {
      readonly ok: true;
      readonly manifest: PluginManifest;
      readonly permissions: PluginPermissions;
      readonly warnings: readonly PluginDiagnostic[];
    }
  | { readonly ok: false; readonly diagnostics: readonly PluginDiagnostic[] };

/**
 * Parse and validate manifest text.
 *
 * Order is deliberate: **hidden-character scanning runs before JSON parsing.** A
 * bidi override inside a string literal produces perfectly valid JSON, so a parse
 * gate would let it through; and a reviewer comparing this manifest against the
 * one they read cannot see the difference. Scanning the raw bytes first means the
 * refusal happens before any structure is trusted.
 */
export function parseManifest(raw: string, label = 'adze.plugin.json'): ManifestParseOutcome {
  const scan = scanForHiddenCharacters(raw);
  if (!scan.ok) {
    return {
      ok: false,
      diagnostics: [errorDiagnostic('hidden-characters', describeFindings(label, scan.findings))],
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        errorDiagnostic(
          'manifest-invalid-json',
          `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }

  const parsed = PluginManifestSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: parsed.error.issues.map((issue) =>
        errorDiagnostic(
          'manifest-schema',
          `${label}: ${issue.path.length === 0 ? '(root)' : issue.path.join('.')} ${issue.message}`,
          issue.path.length === 0 ? undefined : issue.path.join('.'),
        ),
      ),
    };
  }

  const manifest = parsed.data;
  const structural = validateStructure(manifest, label);
  if (structural.length > 0) return { ok: false, diagnostics: structural };

  return {
    ok: true,
    manifest,
    permissions: normalizePermissions(manifest.permissions),
    warnings: collectWarnings(manifest, label),
  };
}

/**
 * Cross-field rules Zod cannot express as a shape.
 *
 * Transport completeness is here rather than as a refinement so the message can
 * name both the transport and the missing field: "url is required" without saying
 * which transport asked for it sends the author to the wrong line.
 */
function validateStructure(manifest: PluginManifest, label: string): PluginDiagnostic[] {
  const diagnostics: PluginDiagnostic[] = [];
  const tools = manifest.contributes?.tools ?? [];

  for (const [index, tool] of tools.entries()) {
    const field = `contributes.tools[${index}]`;
    if (tool.transport === 'stdio') {
      if (tool.command === undefined) {
        diagnostics.push(
          errorDiagnostic(
            'transport-fields',
            `${label}: ${field} uses the stdio transport, which requires 'command'.`,
            field,
          ),
        );
      }
      if (tool.url !== undefined) {
        diagnostics.push(
          errorDiagnostic(
            'transport-fields',
            `${label}: ${field} uses the stdio transport but sets 'url'. ` +
              `A config that names both transports' fields is ambiguous about which one runs.`,
            field,
          ),
        );
      }
    } else {
      if (tool.url === undefined) {
        diagnostics.push(
          errorDiagnostic(
            'transport-fields',
            `${label}: ${field} uses the http transport, which requires 'url'.`,
            field,
          ),
        );
      }
      if (tool.command !== undefined) {
        diagnostics.push(
          errorDiagnostic(
            'transport-fields',
            `${label}: ${field} uses the http transport but sets 'command'.`,
            field,
          ),
        );
      }
    }
  }

  diagnostics.push(...duplicates(label, 'contributes.tools', tools.map((tool) => tool.name)));

  const providers = manifest.contributes?.contextProviders ?? [];
  diagnostics.push(
    ...duplicates(
      label,
      'contributes.contextProviders',
      providers.map((provider) => provider.name),
    ),
  );
  diagnostics.push(
    ...duplicates(
      label,
      'contributes.contextProviders (trigger)',
      providers.map((provider) => provider.trigger),
    ),
  );

  return diagnostics;
}

function duplicates(label: string, field: string, names: readonly string[]): PluginDiagnostic[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) repeated.add(name);
    seen.add(name);
  }
  return [...repeated].map((name) =>
    errorDiagnostic(
      'duplicate-name',
      `${label}: ${field} declares '${name}' more than once. ` +
        `Names are how a prompt and the tool registry refer to a contribution, ` +
        `so a duplicate makes one of them unreachable.`,
      field,
    ),
  );
}

/**
 * Advisory findings that do not block loading.
 *
 * The permission notes are the important ones: a plugin asking for
 * `workspace-write` or for a network host is a plugin a user should have a reason
 * to accept, and the reason has to be visible at the moment of the decision.
 */
function collectWarnings(manifest: PluginManifest, label: string): PluginDiagnostic[] {
  const warnings: PluginDiagnostic[] = [];
  const permissions = normalizePermissions(manifest.permissions);
  const hooks = manifest.contributes?.hooks ?? [];

  if (permissions.filesystem === 'workspace-write') {
    warnings.push(
      warningDiagnostic(
        'permission-narrowed',
        `${label}: requests 'workspace-write' filesystem access, which lets it modify ` +
          `files in the workspace. Decline unless the plugin's purpose requires writing.`,
        'permissions.filesystem',
      ),
    );
  }
  for (const host of permissions.network) {
    warnings.push(
      warningDiagnostic(
        'permission-narrowed',
        `${label}: requests network access to '${host}'.`,
        'permissions.network',
      ),
    );
  }
  for (const [index, hook] of hooks.entries()) {
    if (hook.runtime === 'native') {
      warnings.push(
        warningDiagnostic(
          'native-not-permitted',
          `${label}: contributes.hooks[${index}] is a native module and runs UNSANDBOXED, ` +
            `with the full privileges of the Adze process. It is never loaded without an ` +
            `explicit opt-in.`,
          `contributes.hooks[${index}].runtime`,
        ),
      );
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// engines.adze
// ---------------------------------------------------------------------------

export type EngineCompatibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly diagnostic: PluginDiagnostic };

/**
 * Check `engines.adze` against the running engine.
 *
 * Checked at load, which is the whole value: the alternative is a plugin whose
 * hook silently stops matching an argument shape three releases later and a user
 * who experiences that as the agent behaving strangely.
 *
 * An unparseable range is a *separate* failure from an unsatisfied one and is
 * never treated as satisfied. Guessing "compatible" for a range we could not read
 * is how the check becomes decorative.
 */
export function checkEngineCompatibility(
  manifest: PluginManifest,
  engineVersion: string,
): EngineCompatibility {
  const range = manifest.engines.adze;
  const outcome = satisfiesRange(engineVersion, range);

  if (!outcome.ok) {
    return {
      ok: false,
      diagnostic: errorDiagnostic(
        'engine-range-unparseable',
        `plugin '${manifest.id}' declares engines.adze '${range}', which could not be ` +
          `interpreted: ${outcome.message} The plugin is not loaded, because a range that ` +
          `cannot be checked is not a compatibility statement.`,
        'engines.adze',
      ),
    };
  }

  if (!outcome.satisfied) {
    return {
      ok: false,
      diagnostic: errorDiagnostic(
        'engine-mismatch',
        `plugin '${manifest.id}' version ${manifest.version} supports Adze ` +
          `'${range}', and this engine is ${engineVersion}. Upgrade Adze, or install a ` +
          `version of the plugin that supports ${engineVersion}.`,
        'engines.adze',
      ),
    };
  }

  return { ok: true };
}

/** Effective timeout for a hook entry, with the default made explicit. */
export function hookTimeoutMs(hook: HookContribution): number {
  return hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
}

/**
 * How a hook module will be executed.
 *
 * Inference covers `.wasm` and JavaScript. Anything else is an error rather than a
 * guess: an unrecognised extension defaulting to `native` would silently run
 * unsandboxed code, and defaulting to `wasm` would fail at load with a confusing
 * message about a module that is not WebAssembly.
 */
export type RuntimeResolution =
  | { readonly ok: true; readonly runtime: HookRuntime }
  | { readonly ok: false; readonly message: string };

export function resolveRuntime(module: string, declared: HookRuntime | undefined): RuntimeResolution {
  if (declared !== undefined) return { ok: true, runtime: declared };
  const lower = module.toLowerCase();
  if (lower.endsWith('.wasm')) return { ok: true, runtime: 'wasm' };
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return { ok: true, runtime: 'js' };
  return {
    ok: false,
    message:
      `cannot tell how to run '${module}'. Set "runtime" to "wasm", "js", or "native". ` +
      `A native module is unsandboxed and is never inferred.`,
  };
}
