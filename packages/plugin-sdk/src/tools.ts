/**
 * Surface 1 — tools, as MCP servers.
 *
 * **Nothing here implements MCP.** `@adze/mcp` already does: it connects over stdio
 * and Streamable HTTP, discovers tools, namespaces their names, classifies
 * read-only hints, and turns each into a `RegisteredTool` whose `execute` needs a
 * `Grant`. Duplicating any of that would produce a second tool path with a second
 * set of bugs, and the reason Adze has no tool protocol of its own is that the
 * existing ecosystem is worth more than a bespoke one.
 *
 * So this module does exactly two things: it translates a manifest entry into the
 * config shape `@adze/mcp` consumes, and it refuses translations that would leak
 * something.
 *
 * ## Why the config type is redeclared instead of imported
 *
 * {@link PluginMcpServerConfig} is structurally `McpServerConfig` from `@adze/mcp`.
 * It is redeclared because service packages do not import each other — that rule is
 * what keeps `@adze/mcp` swappable — so the translation is the cost of the
 * boundary, exactly as `@adze/core`'s edit tool pays it when converting applier
 * telemetry into protocol telemetry. It is written field by field for the same
 * reason: a field added on one side fails to compile here rather than silently not
 * crossing.
 *
 * ## `${env:NAME}` is checked against the manifest, not just expanded
 *
 * The spec shows `"env": { "ACME_TOKEN": "${env:ACME_TOKEN}" }` and separately shows
 * `permissions.env: ["ACME_TOKEN"]`, without saying that the two are related. They
 * are: a plugin that interpolates a variable it did not declare is **refused**. The
 * alternative is a permission list that a user reads at install time and that
 * describes less than the plugin actually reads, which makes the display worse than
 * useless.
 */

import {
  errorDiagnostic,
  type PluginDiagnostic,
  type PluginPermissions,
  type ToolContribution,
  warningDiagnostic,
} from './manifest.js';

/** Structurally `McpServerConfig` from `@adze/mcp`. See the header. */
export interface PluginMcpServerConfig {
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly autoApprove?: readonly string[];
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxResultBytes?: number;
}

export interface ToolTranslation {
  readonly config: PluginMcpServerConfig;
  /** The sandbox mode the plugin asked for. Advice to the surface, never a bypass. */
  readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined;
  readonly warnings: readonly PluginDiagnostic[];
}

export type ToolTranslationOutcome =
  | { readonly ok: true; readonly translation: ToolTranslation }
  | { readonly ok: false; readonly diagnostics: readonly PluginDiagnostic[] };

/**
 * Server names are namespaced by plugin id.
 *
 * `@adze/mcp` derives tool names from the server name, so two plugins each
 * contributing a server called `db` would collide — and a collision in the tool
 * registry throws, which would mean the second plugin installed breaks the first.
 * The `.` in a plugin id becomes `_` because MCP tool names have to survive a
 * provider's native tool-name rules.
 */
export function namespacedServerName(pluginId: string, serverName: string): string {
  return `${pluginId.replace(/\./g, '_')}_${serverName}`;
}

const ENV_REFERENCE = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Translate one manifest tool entry.
 *
 * `environment` is passed in rather than read from `process.env` so this is
 * testable without mutating global state, and so a host can hand a plugin a
 * narrowed environment. An undeclared or missing variable is a refusal, not an
 * empty string: a server started with a blank credential fails later, somewhere
 * else, with a message about authentication rather than about configuration.
 */
export function translateToolContribution(
  pluginId: string,
  contribution: ToolContribution,
  permissions: PluginPermissions,
  environment: Readonly<Record<string, string | undefined>>,
): ToolTranslationOutcome {
  const resolved = resolveServerEnv(
    pluginId,
    contribution.env ?? {},
    new Set(permissions.env),
    environment,
  );
  if (resolved.diagnostics.length > 0) return { ok: false, diagnostics: resolved.diagnostics };

  const warnings = [...resolved.warnings];
  if (contribution.sandbox === 'danger-full-access') {
    warnings.push(
      warningDiagnostic(
        'native-not-permitted',
        `plugin '${pluginId}' asks to run its '${contribution.name}' server with ` +
          `danger-full-access, which means no containment at all for that subprocess.`,
        'contributes.tools',
      ),
    );
  }

  const env = resolved.env;
  const config: PluginMcpServerConfig = {
    name: namespacedServerName(pluginId, contribution.name),
    transport: contribution.transport,
    ...(contribution.command === undefined ? {} : { command: contribution.command }),
    ...(contribution.args === undefined ? {} : { args: [...contribution.args] }),
    ...(contribution.cwd === undefined ? {} : { cwd: contribution.cwd }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
    ...(contribution.url === undefined ? {} : { url: contribution.url }),
    ...(contribution.headers === undefined ? {} : { headers: { ...contribution.headers } }),
    ...(contribution.autoApprove === undefined
      ? {}
      : { autoApprove: [...contribution.autoApprove] }),
    ...(contribution.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: contribution.connectTimeoutMs }),
    ...(contribution.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: contribution.requestTimeoutMs }),
    ...(contribution.maxResultBytes === undefined
      ? {}
      : { maxResultBytes: contribution.maxResultBytes }),
  };

  return {
    ok: true,
    translation: {
      config,
      sandbox: contribution.sandbox,
      warnings,
    },
  };
}

interface EnvResolution {
  readonly env: Record<string, string>;
  readonly diagnostics: readonly PluginDiagnostic[];
  readonly warnings: readonly PluginDiagnostic[];
}

/**
 * Resolve a server's `env` block against the plugin's declared permissions.
 *
 * Split out from {@link translateToolContribution} because it is the only part with a
 * loop and three failure modes, and because it is the part where being wrong leaks a
 * credential or starts a server with a blank one.
 */
function resolveServerEnv(
  pluginId: string,
  entries: Readonly<Record<string, string>>,
  declared: ReadonlySet<string>,
  environment: Readonly<Record<string, string | undefined>>,
): EnvResolution {
  const env: Record<string, string> = {};
  const diagnostics: PluginDiagnostic[] = [];
  const warnings: PluginDiagnostic[] = [];

  for (const [key, rawValue] of Object.entries(entries)) {
    const reference = ENV_REFERENCE.exec(rawValue);
    if (reference === null) {
      const warning = literalCredentialWarning(pluginId, key);
      if (warning !== undefined) warnings.push(warning);
      env[key] = rawValue;
      continue;
    }

    const variable = reference[1];
    if (variable === undefined) continue;

    const resolved = resolveReference(pluginId, variable, declared, environment);
    if (!resolved.ok) {
      diagnostics.push(resolved.diagnostic);
      continue;
    }
    env[key] = resolved.value;
  }

  return { env, diagnostics, warnings };
}

/**
 * A literal value where a reference was expected.
 *
 * Almost always a mistake for a credential, and worth saying so: a token committed to
 * a manifest is a token in git history.
 */
function literalCredentialWarning(pluginId: string, key: string): PluginDiagnostic | undefined {
  if (!/token|secret|key|password/i.test(key)) return undefined;
  return warningDiagnostic(
    'permission-narrowed',
    `plugin '${pluginId}' sets '${key}' to a literal value in its manifest rather ` +
      `than to \${env:${key}}. A credential in a manifest is a credential in git.`,
    'contributes.tools',
  );
}

function resolveReference(
  pluginId: string,
  variable: string,
  declared: ReadonlySet<string>,
  environment: Readonly<Record<string, string | undefined>>,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly diagnostic: PluginDiagnostic } {
  if (!declared.has(variable)) {
    return {
      ok: false,
      diagnostic: errorDiagnostic(
        'transport-fields',
        `plugin '${pluginId}' reads the environment variable '${variable}' but does not ` +
          `list it in permissions.env. Add it, so the user sees it before installing: a ` +
          `permission list that understates what a plugin reads is worse than none.`,
        'permissions.env',
      ),
    };
  }

  const value = environment[variable];
  if (value === undefined) {
    return {
      ok: false,
      diagnostic: errorDiagnostic(
        'transport-fields',
        `plugin '${pluginId}' needs the environment variable '${variable}', which is not ` +
          `set. Set it before starting Adze.`,
        'contributes.tools',
      ),
    };
  }
  return { ok: true, value };
}
