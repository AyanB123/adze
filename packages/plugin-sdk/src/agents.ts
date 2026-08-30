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
      permissions: undefined,
    },
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
