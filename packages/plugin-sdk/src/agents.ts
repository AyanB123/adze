/**
 * Surface 5 — subagents.
 *
 * Declarative: a prompt, a tool allowlist, a model preference, and a step ceiling.
 * `@adze/core` already implements the delegation primitive — `SubagentRequest`,
 * `SubagentRunner`, and the `task` tool — and its `ToolRegistry.narrow` makes the
 * allowlist a subset *by construction* rather than by check. What this surface adds
 * is the declaration, so a subagent can ship in a plugin instead of being hard-coded.
 *
 * ## Narrower tools, never broader permissions
 *
 * The spec's rule is one sentence and it has two halves, which are enforced in two
 * different places for a reason.
 *
 * **Tools narrow by set intersection**, and a name the parent does not have is an
 * *error* rather than a silent omission — {@link narrowSubagent} reports it, matching
 * `ToolRegistry.narrow`. Silently dropping an unknown tool would give a subagent a
 * smaller allowlist than its author wrote and make the resulting failure look like
 * model incompetence.
 *
 * **Permissions intersect on a lattice**, which is the half a set operation cannot
 * express. `filesystem` is ordered `none < read < workspace-write`, so a child asking
 * for `workspace-write` under a `read` parent is clamped to `read`, not refused: the
 * subagent still has a useful job to do with less. `network` and `env` intersect as
 * sets. Every clamp is reported, because a subagent that quietly received less than
 * it asked for and then failed is indistinguishable from a subagent that is broken.
 *
 * There is deliberately no code path that widens. {@link narrowSubagent} takes the
 * parent's grant as input and can only return something equal or smaller, and
 * `test/agents.test.ts` asserts the property from the widening direction.
 */

import {
  type FrontmatterScalar,
  parseFrontmatter,
  readMapping,
  readPositiveInteger,
  readString,
  readStringList,
} from './frontmatter.js';
import {
  errorDiagnostic,
  type PluginDiagnostic,
  type PluginPermissions,
  warningDiagnostic,
} from './manifest.js';
import { describeFindings, scanForHiddenCharacters } from './unicode.js';

export interface SubagentDefinition {
  readonly pluginId: string;
  readonly name: string;
  readonly description: string;
  /** Requested allowlist. Intersected with the parent's at invocation. */
  readonly tools: readonly string[];
  readonly modelPreference: string | undefined;
  readonly maxSteps: number | undefined;
  readonly prompt: string;
  readonly source: string;
  /** Requested permissions, if the definition narrows them further. */
  readonly permissions: Partial<PluginPermissions> | undefined;
}

export type SubagentParseOutcome =
  | {
      readonly ok: true;
      readonly definition: SubagentDefinition;
      readonly warnings: readonly PluginDiagnostic[];
    }
  | { readonly ok: false; readonly diagnostics: readonly PluginDiagnostic[] };

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function parseSubagent(
  pluginId: string,
  source: string,
  text: string,
): SubagentParseOutcome {
  const scan = scanForHiddenCharacters(text);
  if (!scan.ok) {
    return {
      ok: false,
      diagnostics: [errorDiagnostic('hidden-characters', describeFindings(source, scan.findings))],
    };
  }

  const parsed = parseFrontmatter(text, source);
  if (!parsed.ok) {
    return { ok: false, diagnostics: [errorDiagnostic('frontmatter-invalid', parsed.message)] };
  }

  const data = parsed.document.data;
  const diagnostics: PluginDiagnostic[] = [];
  const warnings: PluginDiagnostic[] = [];

  const name = readString(data, 'name');
  if (!name.ok) {
    diagnostics.push(errorDiagnostic('frontmatter-invalid', `${source}: ${name.message}`));
  } else if (!NAME_PATTERN.test(name.value)) {
    diagnostics.push(
      errorDiagnostic(
        'frontmatter-invalid',
        `${source}: '${name.value}' is not a usable subagent name. Use lowercase letters, ` +
          `digits, and hyphens.`,
      ),
    );
  }

  const description = readString(data, 'description');
  if (!description.ok) {
    diagnostics.push(errorDiagnostic('frontmatter-invalid', `${source}: ${description.message}`));
  }

  const tools = readStringList(data, 'tools');
  if (!tools.ok) {
    diagnostics.push(errorDiagnostic('frontmatter-invalid', `${source}: ${tools.message}`));
  } else if (tools.value.length === 0) {
    // A subagent with no allowlist would inherit everything, which is the one thing
    // a subagent must not do. The spec's own example lists tools explicitly and says
    // "deliberately no bash, no write"; that intent is only expressible as a list.
    diagnostics.push(
      errorDiagnostic(
        'frontmatter-invalid',
        `${source}: 'tools' is required and must not be empty. A subagent that inherits the ` +
          `parent's whole tool set is not narrower than its parent, which is the only ` +
          `guarantee delegation offers.`,
      ),
    );
  }

  const maxSteps = readPositiveInteger(data, 'maxSteps');
  if (!maxSteps.ok) {
    diagnostics.push(errorDiagnostic('frontmatter-invalid', `${source}: ${maxSteps.message}`));
  }

  const model = readMapping(data, 'model');
  if (!model.ok) {
    diagnostics.push(errorDiagnostic('frontmatter-invalid', `${source}: ${model.message}`));
  }

  const permissionsMapping = readMapping(data, 'permissions');
  if (!permissionsMapping.ok) {
    diagnostics.push(
      errorDiagnostic('frontmatter-invalid', `${source}: ${permissionsMapping.message}`),
    );
  }
  const requestedPermissions = permissionsMapping.ok
    ? readSubagentPermissions(permissionsMapping.value, source)
    : { permissions: undefined, diagnostics: [] as readonly PluginDiagnostic[] };
  diagnostics.push(...requestedPermissions.diagnostics);

  const prompt = parsed.document.body.trim();
  if (prompt.length === 0) {
    diagnostics.push(
      errorDiagnostic(
        'frontmatter-invalid',
        `${source}: the file has front matter but no system prompt after the closing '---'.`,
      ),
    );
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  if (!name.ok || !description.ok || !tools.ok || !maxSteps.ok || !model.ok) {
    return { ok: false, diagnostics };
  }

  const prefer = model.value?.prefer;
  if (prefer !== undefined && typeof prefer !== 'string') {
    warnings.push(
      warningDiagnostic('frontmatter-invalid', `${source}: model.prefer is not text; ignored.`),
    );
  }

  return {
    ok: true,
    warnings,
    definition: {
      pluginId,
      name: name.value,
      description: description.value,
      tools: tools.value,
      modelPreference: typeof prefer === 'string' ? prefer : undefined,
      maxSteps: maxSteps.value,
      prompt,
      source,
      permissions: requestedPermissions.permissions,
    },
  };
}

/**
 * The `permissions:` block a subagent may declare to narrow itself further.
 *
 * This used to be hardcoded to `undefined`, which meant the whole permission half of
 * {@link narrowSubagent} was unreachable from the parse path: an author writing
 * `permissions: { filesystem: none }` to give a reviewer subagent no write access got
 * the parent's level instead, and nothing said so. That direction is safe — a missing
 * request falls back to the parent's grant, so it could never widen — but a declared
 * narrowing that is silently discarded is the failure mode this package is otherwise
 * careful about, and it is worse than a refusal because the author has no way to
 * discover it.
 *
 * Only `filesystem` can be honoured, and the reason is a real limitation of the
 * front-matter grammar rather than a choice. An inline mapping's values are scalars —
 * `readMapping` returns `Record<string, FrontmatterScalar>` — and `network` and `env`
 * are lists. `permissions: { network: [a, b] }` parses the value as the *string*
 * '[a, b]', and the block form that would carry a list cannot nest under a mapping key
 * because nested block mappings are refused. So those two are rejected with the reason
 * named, rather than accepted and dropped. Narrow them in the plugin manifest, which
 * is JSON and has no such limit.
 */
function readSubagentPermissions(
  mapping: Readonly<Record<string, FrontmatterScalar>> | undefined,
  source: string,
): {
  readonly permissions: Partial<PluginPermissions> | undefined;
  readonly diagnostics: readonly PluginDiagnostic[];
} {
  if (mapping === undefined) return { permissions: undefined, diagnostics: [] };

  const diagnostics: PluginDiagnostic[] = [];
  let filesystem: PluginPermissions['filesystem'] | undefined;

  for (const [key, value] of Object.entries(mapping)) {
    if (key === 'filesystem') {
      if (value === 'none' || value === 'read' || value === 'workspace-write') {
        filesystem = value;
        continue;
      }
      diagnostics.push(
        errorDiagnostic(
          'frontmatter-invalid',
          `${source}: permissions.filesystem must be 'none', 'read', or 'workspace-write'. ` +
            `Found '${String(value)}'.`,
        ),
      );
      continue;
    }

    if (key === 'network' || key === 'env') {
      diagnostics.push(
        errorDiagnostic(
          'frontmatter-invalid',
          `${source}: permissions.${key} is a list, and front matter cannot express a list ` +
            `inside an inline mapping — '${key}: ${String(value)}' would be read as text, not ` +
            `as ${key === 'network' ? 'hosts' : 'variable names'}. Declare it in the plugin ` +
            `manifest instead. This is an error rather than a silent omission because a ` +
            `permission narrowing that does not take effect is worse than one that is refused.`,
        ),
      );
      continue;
    }

    diagnostics.push(
      errorDiagnostic(
        'frontmatter-invalid',
        `${source}: '${key}' is not a subagent permission. Only 'filesystem' can be narrowed ` +
          `here.`,
      ),
    );
  }

  if (diagnostics.length > 0) return { permissions: undefined, diagnostics };
  return {
    permissions: filesystem === undefined ? undefined : { filesystem },
    diagnostics: [],
  };
}

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

/** What the parent session actually holds. */
export interface ParentGrant {
  readonly tools: readonly string[];
  readonly permissions: PluginPermissions;
  readonly maxSteps: number | undefined;
}

export interface NarrowedSubagent {
  readonly tools: readonly string[];
  readonly permissions: PluginPermissions;
  readonly maxSteps: number | undefined;
  /** Every clamp that happened, so a reduced grant is never silent. */
  readonly narrowings: readonly PluginDiagnostic[];
}

export type NarrowOutcome =
  | { readonly ok: true; readonly narrowed: NarrowedSubagent }
  | { readonly ok: false; readonly diagnostics: readonly PluginDiagnostic[] };

const FILESYSTEM_ORDER: readonly PluginPermissions['filesystem'][] = [
  'none',
  'read',
  'workspace-write',
];

function filesystemRank(level: PluginPermissions['filesystem']): number {
  const index = FILESYSTEM_ORDER.indexOf(level);
  // An unrecognised level ranks as the most restrictive rather than the least.
  return index < 0 ? 0 : index;
}

/**
 * Resolve what a subagent gets, given what its parent has.
 *
 * The only function that produces a subagent's effective grant, and it takes the
 * parent's as an argument. There is no overload that omits it, so "never broader
 * permissions" is a property of the signature rather than a rule to remember.
 */
export function narrowSubagent(definition: SubagentDefinition, parent: ParentGrant): NarrowOutcome {
  const parentTools = new Set(parent.tools);
  const unknown = definition.tools.filter((tool) => !parentTools.has(tool));
  if (unknown.length > 0) {
    return {
      ok: false,
      diagnostics: [
        errorDiagnostic(
          'permission-narrowed',
          `subagent '${definition.name}' from plugin '${definition.pluginId}' requests ` +
            `${unknown.length === 1 ? 'a tool' : 'tools'} the parent session does not have: ` +
            `${unknown.join(', ')}. Available: ${parent.tools.join(', ')}. This is an error ` +
            `rather than a silent omission — a subagent quietly missing the tool it was told ` +
            `to use fails in a way that looks like the model being incompetent.`,
        ),
      ],
    };
  }

  const narrowings: PluginDiagnostic[] = [];
  const requested = definition.permissions;

  const requestedFilesystem = requested?.filesystem;
  let filesystem = parent.permissions.filesystem;
  if (requestedFilesystem !== undefined) {
    if (filesystemRank(requestedFilesystem) > filesystemRank(filesystem)) {
      narrowings.push(
        warningDiagnostic(
          'permission-narrowed',
          `subagent '${definition.name}' asked for filesystem '${requestedFilesystem}' and ` +
            `was clamped to the parent's '${filesystem}'. A subagent inherits the parent's ` +
            `sandbox and cannot widen it.`,
        ),
      );
    } else {
      filesystem = requestedFilesystem;
    }
  }

  const parentHosts = new Set(parent.permissions.network);
  const requestedHosts = requested?.network;
  let network: readonly string[] = parent.permissions.network;
  if (requestedHosts !== undefined) {
    const denied = requestedHosts.filter((host) => !parentHosts.has(host));
    for (const host of denied) {
      narrowings.push(
        warningDiagnostic(
          'permission-narrowed',
          `subagent '${definition.name}' asked for network access to '${host}', which the ` +
            `parent session does not have. Dropped.`,
        ),
      );
    }
    network = requestedHosts.filter((host) => parentHosts.has(host));
  }

  const parentEnv = new Set(parent.permissions.env);
  const requestedEnv = requested?.env;
  let env: readonly string[] = parent.permissions.env;
  if (requestedEnv !== undefined) {
    for (const variable of requestedEnv.filter((name) => !parentEnv.has(name))) {
      narrowings.push(
        warningDiagnostic(
          'permission-narrowed',
          `subagent '${definition.name}' asked to read '${variable}', which the parent ` +
            `session does not have. Dropped.`,
        ),
      );
    }
    env = requestedEnv.filter((name) => parentEnv.has(name));
  }

  // A child's step ceiling can only lower the parent's. An unbounded child under a
  // bounded parent would let delegation launder the budget.
  const maxSteps =
    definition.maxSteps === undefined
      ? parent.maxSteps
      : parent.maxSteps === undefined
        ? definition.maxSteps
        : Math.min(definition.maxSteps, parent.maxSteps);

  if (
    definition.maxSteps !== undefined &&
    parent.maxSteps !== undefined &&
    definition.maxSteps > parent.maxSteps
  ) {
    narrowings.push(
      warningDiagnostic(
        'permission-narrowed',
        `subagent '${definition.name}' asked for ${definition.maxSteps} steps and was ` +
          `clamped to the parent's ${parent.maxSteps}.`,
      ),
    );
  }

  return {
    ok: true,
    narrowed: {
      tools: [...definition.tools],
      permissions: { filesystem, network: [...network], env: [...env] },
      maxSteps,
      narrowings,
    },
  };
}
