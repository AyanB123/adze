/**
 * `@adze/plugin-sdk` — the plugin manifest, the loader, and the six extension
 * surfaces from ADR-0008.
 *
 * ```ts
 * import {
 *   hookHostFor,
 *   jsModuleRuntime,
 *   loadPlugins,
 *   toRegisteredHook,
 * } from '@adze/plugin-sdk';
 *
 * const set = await loadPlugins([resolve('plugins/acme-migration-guard')], {
 *   engineVersion: '0.0.1',
 *   jsRuntime: jsModuleRuntime({ allowedRoots: [resolve('plugins')] }),
 *   allowUnsandboxedJs: true, // required: a JS module is not sandboxed
 * });
 *
 * const hooks = hookHostFor(set.plugins);
 * engineHookBus.register(toRegisteredHook({ host: hooks }));
 * // A `tool.pre` or `edit.pre` denial now stops the call inside
 * // `dispatchToolCall`, before the permission gate is consulted.
 * ```
 *
 * ## What is real, and what is a seam
 *
 * Stated first because the spec describes all six surfaces in the present tense and
 * none of them existed when it was written.
 *
 * | Surface | State |
 * | --- | --- |
 * | 1 — Tools (MCP) | **Real.** Translation to `@adze/mcp`'s config; MCP is not reimplemented. |
 * | 2 — Context providers | **Real** for `type: "glob"`. A `type: "wasm"` provider needs a runtime this build does not have. |
 * | 3 — Slash commands | **Real**, including `!` and `@` interpolation. `!` needs a host-supplied gate-checked runner. |
 * | 4 — Hooks | **Real** for seven of the spec's nine events, wired to core's dispatch path. `edit.pre`/`edit.post` are derived from `tool.pre`/`tool.post`; `context.pre` and `session.compact` have no seam in core and do not fire. |
 * | 5 — Subagents | **Real.** Declaration plus narrowing that cannot widen. |
 * | 6 — UI | **Type only, by design.** The engine refuses UI contributions. |
 * | WASM runtime | **Seam.** `wasm32-wasip2` is not implemented; the default runtime refuses the load rather than skipping the module. |
 *
 * The one thing to take from that table: a policy hook shipped as `.wasm` will not
 * run in this build, and the plugin containing it will refuse to load rather than
 * load without it.
 *
 * Design rationale: docs/plugins/spec.md, docs/architecture/adr/0008-plugin-architecture.md,
 * docs/architecture/adr/0001-engine-first-architecture.md.
 */

// --- Surface 5: subagents ---------------------------------------------------
export type {
  NarrowedSubagent,
  NarrowOutcome as SubagentNarrowOutcome,
  ParentGrant,
  SubagentDefinition,
  SubagentParseOutcome,
} from './agents.js';
export { narrowSubagent, parseSubagent } from './agents.js';
// --- The bridge to @adze/core ----------------------------------------------
export type { BridgeOptions, EditShape, EditShapeReader } from './bridge.js';
export {
  DEFAULT_EDIT_TOOLS,
  readCoreEditArgs,
  readCoreWriteArgs,
  toRegisteredHook,
} from './bridge.js';
// --- Surface 3: slash commands ---------------------------------------------
export type {
  CommandParseOutcome,
  CommandRunner,
  Interpolation,
  InterpolationDeps,
  InterpolationOutcome,
  SlashCommand,
  TriggerResolver,
} from './commands.js';
export { DEFAULT_MAX_COMMAND_BYTES, interpolate, parseSlashCommand } from './commands.js';
// --- Surface 2: context providers ------------------------------------------
export type {
  ContextChunk,
  ContextFileSystem,
  ContextResolution,
  GlobProviderDeps,
  ProviderBuildOutcome,
  ResolvedContextProvider,
  WasmProviderDeps,
} from './context.js';
export {
  buildGlobProvider,
  buildWasmProvider,
  DEFAULT_PROVIDER_MAX_BYTES,
  PROVIDE_CONTEXT_EXPORT,
} from './context.js';
// --- Front matter -----------------------------------------------------------
export type {
  FrontmatterDocument,
  FrontmatterOutcome,
  FrontmatterScalar,
  FrontmatterValue,
} from './frontmatter.js';
export {
  parseFrontmatter,
  readMapping,
  readPositiveInteger,
  readString,
  readStringList,
} from './frontmatter.js';
// --- Globs ------------------------------------------------------------------
export type { GlobOutcome, GlobSetOutcome } from './glob.js';
export { compileGlob, compileGlobSet, toPosix } from './glob.js';
// --- Surface 4: hooks -------------------------------------------------------
export type {
  ContextPrePayload,
  DecodeOutcome,
  EditPostPayload,
  EditPrePayload,
  HookDecision,
  HookHostOptions,
  HookInstance,
  HookObserver,
  HookOutput,
  HookPayload,
  HookRecord,
  RecordingObserver,
  SessionCompactPayload,
  SessionStartPayload,
  ToolPostPayload,
  ToolPrePayload,
  TurnEndPayload,
  TurnStartPayload,
} from './hooks.js';
export {
  consoleHookObserver,
  decodeHookOutput,
  HookHost,
  recordingObserver,
} from './hooks.js';
// --- Loading ----------------------------------------------------------------
export type {
  ContextProviderDeps,
  ContextProviderSet,
  LoadedPlugin,
  LoaderOptions,
  PendingContextProvider,
  PluginFileSystem,
  PluginLoadOutcome,
  PluginSet,
} from './loader.js';
export {
  buildContextProviders,
  hookHostFor,
  loadPlugin,
  loadPlugins,
  MANIFEST_FILENAME,
  nodePluginFileSystem,
} from './loader.js';
// --- Manifest ---------------------------------------------------------------
export type {
  ContextProviderContribution,
  DiagnosticSeverity,
  EngineCompatibility,
  FileContribution,
  HookContribution,
  HookEvent,
  HookRuntime,
  ManifestParseOutcome,
  PluginDiagnostic,
  PluginDiagnosticCode,
  PluginManifest,
  PluginPermissions,
  RuntimeResolution,
  ToolContribution,
  UiContribution,
} from './manifest.js';
export {
  canVeto,
  checkEngineCompatibility,
  DEFAULT_HOOK_TIMEOUT_MS,
  errorDiagnostic,
  HOOK_EVENTS,
  hookTimeoutMs,
  MAX_HOOK_TIMEOUT_MS,
  NO_PERMISSIONS,
  namespaceOf,
  normalizePermissions,
  PluginManifestSchema,
  parseManifest,
  resolveRuntime,
  VETO_EVENTS,
  warningDiagnostic,
} from './manifest.js';
// --- Semver -----------------------------------------------------------------
export type { RangeCheckOutcome, SemanticVersion, VersionParseOutcome } from './semver.js';
export { compareVersions, parseVersion, satisfiesRange } from './semver.js';
// --- Surface 1: tools -------------------------------------------------------
export type {
  PluginMcpServerConfig,
  ToolTranslation,
  ToolTranslationOutcome,
} from './tools.js';
export { namespacedServerName, translateToolContribution } from './tools.js';
// --- Surface 6: UI, which the engine refuses -------------------------------
export type { EngineUiRefusal, SurfaceUiContribution } from './ui.js';
export {
  assertNoEngineUi,
  EngineUiRefusedError,
  partitionUi,
  surfaceUiContributions,
} from './ui.js';
// --- Hidden-character scanning ---------------------------------------------
export type {
  UnicodeFinding,
  UnicodeFindingCategory,
  UnicodeScanOutcome,
} from './unicode.js';
export { describeFindings, notationFor, scanForHiddenCharacters } from './unicode.js';
// --- The guest host --------------------------------------------------------
export type {
  GuestCallOutcome,
  GuestLimits,
  GuestLoadOutcome,
  GuestLoadRequest,
  GuestModule,
  GuestRuntime,
  JsGuestExports,
} from './wasm.js';
export {
  callGuest,
  DEFAULT_GUEST_LIMITS,
  GUEST_TIMEOUT,
  jsModuleRuntime,
  unavailableWasmRuntime,
} from './wasm.js';
