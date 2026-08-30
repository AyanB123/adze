/**
 * The plugin loader.
 *
 * A plugin is a directory containing `adze.plugin.json`. Loading it means reading
 * that manifest, refusing it for any of the reasons below, and — only then —
 * resolving the surfaces it declares.
 *
 * ## Refusal is the default for anything unproven
 *
 * The order of checks is the security design, so it is worth reading as a list
 * rather than as code:
 *
 * 1. **Hidden characters**, on the manifest bytes, before JSON is parsed.
 * 2. **Schema**, including path traversal in every module reference.
 * 3. **`engines.adze`**, against the running engine. An unparseable range refuses.
 * 4. **Namespace claim**, when the host supplies a claim list.
 * 5. **Isolation**: a module that cannot be run in a sandbox is refused unless the
 *    host explicitly opted in, per runtime.
 * 6. **Hidden characters again**, on every JavaScript module and every markdown file
 *    the manifest points at.
 * 7. **Module load**. A hook whose module will not load **fails the whole plugin.**
 *
 * Step 7 is the one worth defending. It would be friendlier to load a plugin's other
 * surfaces and report the broken hook — and it would be wrong. A plugin exists to
 * enforce a policy; a plugin that loaded with its policy hook missing is a plugin
 * that appears installed and enforces nothing, which is worse than one that refused
 * to install. Fail closed at load, so the failure is visible while a human is
 * watching.
 *
 * ## Both procedural runtimes require an explicit opt-in
 *
 * `runtime: "native"` is unsandboxed, and the spec says such plugins are labelled
 * and never installed silently. `runtime: "js"` is *also* unsandboxed — an ES module
 * imported into this process has the engine's full privileges — so it carries the
 * same requirement, even though the spec does not mention it. Treating the JS path
 * as safe because it is convenient would put the one genuinely working procedural
 * path outside the security model.
 *
 * Only `runtime: "wasm"` needs no opt-in, and there is no WASM runtime yet, so in
 * this build every procedural plugin needs a flag. That is an accurate description
 * of the state of the world rather than a limitation being hidden.
 */

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parseSubagent, type SubagentDefinition } from './agents.js';
import { parseSlashCommand, type SlashCommand } from './commands.js';
import {
  buildGlobProvider,
  buildWasmProvider,
  type ContextFileSystem,
  type ResolvedContextProvider,
} from './context.js';
import { HookHost, type HookHostOptions, type HookInstance } from './hooks.js';
import {
  type ContextProviderContribution,
  checkEngineCompatibility,
  errorDiagnostic,
  type HookRuntime,
  hookTimeoutMs,
  namespaceOf,
  type PluginDiagnostic,
  type PluginManifest,
  type PluginPermissions,
  parseManifest,
  resolveRuntime,
  warningDiagnostic,
} from './manifest.js';
import { type ToolTranslation, translateToolContribution } from './tools.js';
import { partitionUi, type SurfaceUiContribution } from './ui.js';
import { describeFindings, scanForHiddenCharacters } from './unicode.js';
import {
  DEFAULT_GUEST_LIMITS,
  type GuestLimits,
  type GuestModule,
  type GuestRuntime,
  unavailableWasmRuntime,
} from './wasm.js';

export const MANIFEST_FILENAME = 'adze.plugin.json';

/** Reading plugin files. Injected so loading is testable without a disk. */
export interface PluginFileSystem {
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

export function nodePluginFileSystem(): PluginFileSystem {
  return {
    readFile: (path) => readFile(path, 'utf8'),
    exists: async (path) => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export interface LoaderOptions {
  /** The running engine's version, checked against `engines.adze`. */
  readonly engineVersion: string;
  readonly files?: PluginFileSystem;
  /** Defaults to {@link unavailableWasmRuntime}, which refuses. */
  readonly wasmRuntime?: GuestRuntime;
  /** Required for `runtime: "js"`. There is no default: it is unsandboxed. */
  readonly jsRuntime?: GuestRuntime;
  /** Required for `runtime: "native"`. There is no default: it is unsandboxed. */
  readonly nativeRuntime?: GuestRuntime;
  /**
   * Permit unsandboxed runtimes. Two flags, because the risks differ in degree and
   * a single `allowUnsafe` would let one decision authorize the other.
   */
  readonly allowUnsandboxedJs?: boolean;
  readonly allowNative?: boolean;
  /** Namespaces the host recognises. Omit to skip the claim check. */
  readonly claimedNamespaces?: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly guestLimits?: GuestLimits;
  readonly hookOptions?: HookHostOptions;
}

/** A glob provider, held unresolved until a workspace is known. */
export interface PendingContextProvider {
  readonly pluginId: string;
  readonly contribution: ContextProviderContribution;
  readonly guest: GuestModule | undefined;
  readonly timeoutMs: number;
}

export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  readonly permissions: PluginPermissions;
  /** Absolute path to the plugin directory. */
  readonly root: string;
  readonly tools: readonly ToolTranslation[];
  readonly contextProviders: readonly PendingContextProvider[];
  readonly commands: readonly SlashCommand[];
  readonly hooks: readonly HookInstance[];
  readonly agents: readonly SubagentDefinition[];
  /** Available to surfaces only. The engine refuses these; see `ui.ts`. */
  readonly ui: readonly SurfaceUiContribution[];
  /** Warnings and refusals worth showing. Never fatal — a fatal load returns `ok: false`. */
  readonly notices: readonly PluginDiagnostic[];
}

export type PluginLoadOutcome =
  | { readonly ok: true; readonly plugin: LoadedPlugin }
  | { readonly ok: false; readonly diagnostics: readonly PluginDiagnostic[] };

/**
 * Load one plugin directory.
 *
 * `root` must be absolute: a relative plugin root would resolve against whatever
 * `process.cwd()` happened to be, and "which directory did this policy come from"
 * is not a question that should have an ambient answer.
 */
export async function loadPlugin(root: string, options: LoaderOptions): Promise<PluginLoadOutcome> {
  if (!isAbsolute(root)) {
    return {
      ok: false,
      diagnostics: [
        errorDiagnostic(
          'manifest-unreadable',
          `plugin root '${root}' is not an absolute path. A relative root resolves against the ` +
            `current working directory, which makes the source of a policy ambient.`,
        ),
      ],
    };
  }

  const files = options.files ?? nodePluginFileSystem();
  const manifestPath = join(root, MANIFEST_FILENAME);

  let raw: string;
  try {
    raw = await files.readFile(manifestPath);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        errorDiagnostic(
          'manifest-unreadable',
          `could not read ${manifestPath}: ` +
            `${error instanceof Error ? error.message : String(error)}. A plugin is a directory ` +
            `containing ${MANIFEST_FILENAME}.`,
        ),
      ],
    };
  }

  const parsed = parseManifest(raw, manifestPath);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  const { manifest, permissions } = parsed;
  const notices: PluginDiagnostic[] = [...parsed.warnings];

  const compatibility = checkEngineCompatibility(manifest, options.engineVersion);
  if (!compatibility.ok) return { ok: false, diagnostics: [compatibility.diagnostic] };

  const claims = options.claimedNamespaces;
  if (claims !== undefined) {
    const namespace = namespaceOf(manifest.id);
    if (!claims.includes(namespace)) {
      return {
        ok: false,
        diagnostics: [
          errorDiagnostic(
            'manifest-schema',
            `plugin '${manifest.id}' uses the namespace '${namespace}', which this host does ` +
              `not recognise as claimed. An unclaimed namespace is how a squatted name reaches ` +
              `a position of trust.`,
            'id',
          ),
        ],
      };
    }
  }

  const limits = options.guestLimits ?? DEFAULT_GUEST_LIMITS;
  const diagnostics: PluginDiagnostic[] = [];

  // --- Surface 1: tools ----------------------------------------------------
  const tools: ToolTranslation[] = [];
  for (const contribution of manifest.contributes?.tools ?? []) {
    const translated = translateToolContribution(
      manifest.id,
      contribution,
      permissions,
      options.environment ?? {},
    );
    if (!translated.ok) {
      diagnostics.push(...translated.diagnostics);
      continue;
    }
    tools.push(translated.translation);
    notices.push(...translated.translation.warnings);
  }

  // --- Surface 4: hooks (and surface 2's wasm providers) -------------------
  const hooks: HookInstance[] = [];
  for (const [index, contribution] of (manifest.contributes?.hooks ?? []).entries()) {
    const field = `contributes.hooks[${index}]`;
    const runtimeChoice = resolveRuntime(contribution.module, contribution.runtime);
    if (!runtimeChoice.ok) {
      diagnostics.push(
        errorDiagnostic(
          'module-unloadable',
          `plugin '${manifest.id}' ${field}: ${runtimeChoice.message}`,
          field,
        ),
      );
      continue;
    }

    const loaded = await loadGuest(
      manifest.id,
      root,
      contribution.module,
      runtimeChoice.runtime,
      { ...limits, timeoutMs: hookTimeoutMs(contribution) },
      options,
      files,
      field,
    );
    if (!loaded.ok) {
      diagnostics.push(...loaded.diagnostics);
      continue;
    }

    hooks.push({
      pluginId: manifest.id,
      event: contribution.event,
      module: contribution.module,
      runtime: runtimeChoice.runtime,
      timeoutMs: hookTimeoutMs(contribution),
      exportName: contribution.export ?? contribution.event,
      guest: loaded.guest,
    });
  }

  // --- Surface 2: context providers ---------------------------------------
  const contextProviders: PendingContextProvider[] = [];
  for (const [index, contribution] of (manifest.contributes?.contextProviders ?? []).entries()) {
    if (contribution.type === 'glob') {
      contextProviders.push({
        pluginId: manifest.id,
        contribution,
        guest: undefined,
        timeoutMs: limits.timeoutMs,
      });
      continue;
    }

    const field = `contributes.contextProviders[${index}]`;
    const runtimeChoice = resolveRuntime(contribution.module, undefined);
    if (!runtimeChoice.ok) {
      diagnostics.push(
        errorDiagnostic(
          'module-unloadable',
          `plugin '${manifest.id}' ${field}: ${runtimeChoice.message}`,
          field,
        ),
      );
      continue;
    }
    const timeoutMs = contribution.timeoutMs ?? limits.timeoutMs;
    const loaded = await loadGuest(
      manifest.id,
      root,
      contribution.module,
      runtimeChoice.runtime,
      { ...limits, timeoutMs },
      options,
      files,
      field,
    );
    if (!loaded.ok) {
      diagnostics.push(...loaded.diagnostics);
      continue;
    }
    contextProviders.push({
      pluginId: manifest.id,
      contribution,
      guest: loaded.guest,
      timeoutMs,
    });
  }

  // --- Surface 3: commands -------------------------------------------------
  const commands: SlashCommand[] = [];
  for (const [index, reference] of (manifest.contributes?.commands ?? []).entries()) {
    const field = `contributes.commands[${index}]`;
    const text = await readReferenced(files, root, reference.path, manifest.id, field);
    if (!text.ok) {
      diagnostics.push(...text.diagnostics);
      continue;
    }
    const parsedCommand = parseSlashCommand(manifest.id, reference.path, text.text);
    if (!parsedCommand.ok) {
      diagnostics.push(...parsedCommand.diagnostics);
      continue;
    }
    commands.push(parsedCommand.command);
    notices.push(...parsedCommand.warnings);
  }

  // --- Surface 5: subagents ------------------------------------------------
  const agents: SubagentDefinition[] = [];
  for (const [index, reference] of (manifest.contributes?.agents ?? []).entries()) {
    const field = `contributes.agents[${index}]`;
    const text = await readReferenced(files, root, reference.path, manifest.id, field);
    if (!text.ok) {
      diagnostics.push(...text.diagnostics);
      continue;
    }
    const parsedAgent = parseSubagent(manifest.id, reference.path, text.text);
    if (!parsedAgent.ok) {
      diagnostics.push(...parsedAgent.diagnostics);
      continue;
    }
    agents.push(parsedAgent.definition);
    notices.push(...parsedAgent.warnings);
  }

  // --- Surface 6: UI, which the engine refuses ----------------------------
  const ui = partitionUi(manifest.id, manifest.contributes?.ui ?? []);
  notices.push(...ui.refusals.map((refusal) => refusal.diagnostic));

  if (diagnostics.length > 0) return { ok: false, diagnostics };

  return {
    ok: true,
    plugin: {
      manifest,
      permissions,
      root,
      tools,
      contextProviders,
      commands,
      hooks,
      agents,
      ui: ui.forSurfaces,
      notices,
    },
  };
}

type GuestOutcome =
  | { readonly ok: true; readonly guest: GuestModule }
  | { readonly ok: false; readonly diagnostics: readonly PluginDiagnostic[] };

async function loadGuest(
  pluginId: string,
  root: string,
  modulePath: string,
  runtime: HookRuntime,
  limits: GuestLimits,
  options: LoaderOptions,
  files: PluginFileSystem,
  field: string,
): Promise<GuestOutcome> {
  const absolutePath = resolve(root, modulePath);

  if (runtime === 'native' && options.allowNative !== true) {
    return {
      ok: false,
      diagnostics: [
        errorDiagnostic(
          'native-not-permitted',
          `plugin '${pluginId}' ${field} is a NATIVE module and runs UNSANDBOXED with the full ` +
            `privileges of the Adze process. It is refused unless the host opts in with ` +
            `allowNative. A native plugin is never installed silently.`,
          field,
        ),
      ],
    };
  }

  if (runtime === 'js' && options.allowUnsandboxedJs !== true) {
    return {
      ok: false,
      diagnostics: [
        errorDiagnostic(
          'native-not-permitted',
          `plugin '${pluginId}' ${field} is a JavaScript module. Importing it runs its code ` +
            `in the Adze process with no sandbox — the same exposure as a native plugin, so it ` +
            `carries the same requirement. Set allowUnsandboxedJs to opt in, or ship the hook ` +
            `as wasm32-wasip2.`,
          field,
        ),
      ],
    };
  }

  if (!(await files.exists(absolutePath))) {
    return {
      ok: false,
      diagnostics: [
        errorDiagnostic(
          'file-missing',
          `plugin '${pluginId}' ${field} points at '${modulePath}', which does not exist.`,
          field,
        ),
      ],
    };
  }

  // Scan JavaScript source. A WASM binary is not text and this scan would be
  // meaningless on it — see the README for why that gap is real and unclosed.
  if (runtime === 'js') {
    let source: string;
    try {
      source = await files.readFile(absolutePath);
    } catch (error) {
      return {
        ok: false,
        diagnostics: [
          errorDiagnostic(
            'module-unloadable',
            `plugin '${pluginId}' ${field}: could not read '${modulePath}': ` +
              `${error instanceof Error ? error.message : String(error)}`,
            field,
          ),
        ],
      };
    }
    const scan = scanForHiddenCharacters(source);
    if (!scan.ok) {
      return {
        ok: false,
        diagnostics: [
          errorDiagnostic('hidden-characters', describeFindings(modulePath, scan.findings), field),
        ],
      };
    }
  }

  const engine =
    runtime === 'wasm'
      ? (options.wasmRuntime ?? unavailableWasmRuntime())
      : runtime === 'js'
        ? options.jsRuntime
        : options.nativeRuntime;

  if (engine === undefined) {
    return {
      ok: false,
      diagnostics: [
        errorDiagnostic(
          'module-unloadable',
          `plugin '${pluginId}' ${field} needs a '${runtime}' runtime and none was supplied.`,
          field,
        ),
      ],
    };
  }

  const loaded = await engine.load({ pluginId, modulePath: absolutePath, limits });
  if (!loaded.ok) {
    return {
      ok: false,
      diagnostics: [errorDiagnostic('module-unloadable', loaded.message, field)],
    };
  }
  return { ok: true, guest: loaded.module };
}

type TextOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly diagnostics: readonly PluginDiagnostic[] };

async function readReferenced(
  files: PluginFileSystem,
  root: string,
  relative: string,
  pluginId: string,
  field: string,
): Promise<TextOutcome> {
  const absolutePath = resolve(root, relative);
  try {
    return { ok: true, text: await files.readFile(absolutePath) };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        errorDiagnostic(
          'file-missing',
          `plugin '${pluginId}' ${field} points at '${relative}', which could not be read: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          field,
        ),
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Several plugins at once
// ---------------------------------------------------------------------------

export interface PluginSet {
  readonly plugins: readonly LoadedPlugin[];
  /** Per-root failures. A plugin that refuses does not stop the others. */
  readonly failures: readonly {
    readonly root: string;
    readonly diagnostics: readonly PluginDiagnostic[];
  }[];
  readonly notices: readonly PluginDiagnostic[];
}

/**
 * Load several plugin directories.
 *
 * One plugin's refusal does not prevent the others from loading, which is the
 * opposite of the rule inside a single plugin. The asymmetry is deliberate: a broken
 * hook inside a plugin means *that plugin's* policy is not being enforced, so the
 * plugin must not load; a broken plugin elsewhere says nothing about this one, and
 * failing the whole set would let any single bad plugin disable every policy on the
 * machine.
 *
 * A duplicate plugin id is a refusal for the later one. Two plugins with the same id
 * would make every diagnostic ambiguous about which of them acted.
 */
export async function loadPlugins(
  roots: readonly string[],
  options: LoaderOptions,
): Promise<PluginSet> {
  const plugins: LoadedPlugin[] = [];
  const failures: { root: string; diagnostics: readonly PluginDiagnostic[] }[] = [];
  const notices: PluginDiagnostic[] = [];
  const seen = new Map<string, string>();

  for (const root of roots) {
    const outcome = await loadPlugin(root, options);
    if (!outcome.ok) {
      failures.push({ root, diagnostics: outcome.diagnostics });
      continue;
    }
    const previous = seen.get(outcome.plugin.manifest.id);
    if (previous !== undefined) {
      failures.push({
        root,
        diagnostics: [
          errorDiagnostic(
            'duplicate-name',
            `plugin id '${outcome.plugin.manifest.id}' is already loaded from '${previous}'. ` +
              `Two plugins with one id make every diagnostic ambiguous about which acted.`,
            'id',
          ),
        ],
      });
      continue;
    }
    seen.set(outcome.plugin.manifest.id, root);
    plugins.push(outcome.plugin);
    notices.push(...outcome.plugin.notices);
  }

  return { plugins, failures, notices };
}

/**
 * Register every loaded plugin's hooks on one host.
 *
 * Order is the order of `plugins`, then declaration order inside each manifest. See
 * `hooks.ts` on why that is enough and a priority field is not needed.
 */
export function hookHostFor(
  plugins: readonly LoadedPlugin[],
  options: HookHostOptions = {},
): HookHost {
  const host = new HookHost(options);
  for (const plugin of plugins) {
    for (const hook of plugin.hooks) host.register(hook);
  }
  return host;
}

export interface ContextProviderDeps {
  readonly workspaceRoot: string;
  readonly files: ContextFileSystem;
}

export interface ContextProviderSet {
  readonly providers: readonly ResolvedContextProvider[];
  readonly diagnostics: readonly PluginDiagnostic[];
}

/**
 * Build every provider now that a workspace is known.
 *
 * Separate from loading because a provider needs a workspace and a plugin does not.
 * Two plugins claiming the same `@trigger` is reported and the first one wins, since
 * silently merging their output would make a prompt's meaning depend on load order.
 */
export function buildContextProviders(
  plugins: readonly LoadedPlugin[],
  deps: ContextProviderDeps,
): ContextProviderSet {
  const providers: ResolvedContextProvider[] = [];
  const diagnostics: PluginDiagnostic[] = [];
  const triggers = new Map<string, string>();

  for (const plugin of plugins) {
    for (const pending of plugin.contextProviders) {
      const trigger = pending.contribution.trigger;
      const owner = triggers.get(trigger);
      if (owner !== undefined) {
        diagnostics.push(
          warningDiagnostic(
            'duplicate-name',
            `plugin '${pending.pluginId}' claims the trigger '${trigger}', which '${owner}' ` +
              `already provides. The first one loaded wins; the later provider is inactive.`,
            'contributes.contextProviders',
          ),
        );
        continue;
      }

      if (pending.contribution.type === 'glob') {
        const built = buildGlobProvider(pending.pluginId, pending.contribution, deps);
        if (!built.ok) {
          diagnostics.push(...built.diagnostics);
          continue;
        }
        triggers.set(trigger, pending.pluginId);
        providers.push(built.provider);
        continue;
      }

      const guest = pending.guest;
      if (guest === undefined) {
        diagnostics.push(
          errorDiagnostic(
            'module-unloadable',
            `plugin '${pending.pluginId}' provider '${pending.contribution.name}' has no loaded ` +
              `module, so it contributes nothing.`,
          ),
        );
        continue;
      }
      triggers.set(trigger, pending.pluginId);
      providers.push(
        buildWasmProvider(pending.pluginId, pending.contribution, {
          guest,
          timeoutMs: pending.timeoutMs,
        }),
      );
    }
  }

  return { providers, diagnostics };
}
