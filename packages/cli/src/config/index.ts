/**
 * Public surface of the CLI config system: `.adze/config.jsonc` plus env.
 *
 * `run`, `chat`, and `doctor` import from here and nowhere deeper, so the
 * layering stays visible: strip comments (`jsonc`), validate (`schema`), merge
 * by precedence (`loader`), then apply flags (`resolve`).
 */

export { parseJsonc, stripJsoncComments } from './jsonc.js';
export {
  applyForbidWins,
  CONFIG_FILENAME,
  type CommandRuleWithSource,
  ConfigError,
  type ConfigSource,
  type LoadedConfig,
  type LoadOptions,
  loadCliConfig,
} from './loader.js';
export { type EffectiveResolution, resolveWithFlags } from './resolve.js';
export {
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
