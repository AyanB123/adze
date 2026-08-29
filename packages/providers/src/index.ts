/**
 * @adze/providers — the model gateway.
 *
 * Implements `@adze/core`'s `ModelProvider` seam against Anthropic, OpenAI, and any
 * OpenAI-compatible endpoint. The third is what makes this package finite: OpenRouter, a
 * local llama.cpp or Ollama server, vLLM, and any corporate gateway all speak that
 * protocol, so pointing Adze at one is configuration rather than a new adapter.
 *
 * ```ts
 * import { createGateway } from '@adze/providers';
 *
 * const gateway = createGateway({ model: { provider: 'anthropic', model: 'claude-sonnet-4-5' } });
 * // -> pass as `provider` to `new Engine({ ... })`
 * ```
 *
 * ### What this package guarantees
 *
 * - **Native tool calling only.** No JSON-in-a-string path exists here. ADR-0004
 *   measured that transport at a 7.3% invalid-JSON rejection rate on open-weight
 *   rollouts, so a model without native tool calling is reported `degraded` and run
 *   without tools rather than served by a worse code path.
 * - **Usage split three ways, non-overlapping.** `inputTokens`, `cachedInputTokens`,
 *   `outputTokens`, plus a derived cache hit rate. See `usage.ts` for the one
 *   subtraction that keeps cached tokens from being counted twice.
 * - **Cost from data.** `catalog.json` holds the rates; a contributor updating a price
 *   edits JSON and touches no code. An unpriced model reports `undefined`, never zero.
 * - **Credentials never leave.** Every provider message passes through `redact()` before
 *   it can reach a terminal, a log, or a trajectory artifact.
 *
 * ### What it does not do
 *
 * It makes no outbound call except the one a configured provider requires, and its own
 * test suite makes none at all — the SDK's mock model is injected through
 * {@link GatewayOptions.languageModel}. See `docs/roadmap.md` for what is still ahead.
 */

// --- Catalog: prices and capabilities, from data ----------------------------
export type { Catalog, CatalogEntry, ModelCapabilities } from './catalog.js';
export { capabilitiesFor, findEntry, loadCatalog, modelsOf, priceFor } from './catalog.js';
// --- Configuration and credential resolution -------------------------------
export type {
  ProviderEntry,
  ProviderKind,
  ProvidersFile,
  ResolvedConfig,
  ResolvedProvider,
  ResolveOptions,
} from './config.js';
export {
  API_KEY_ENV,
  BASE_URL_ENV,
  CONFIG_FILENAME,
  PROVIDER_KINDS,
  parseModelRef,
  resolveConfig,
} from './config.js';
// --- Errors ----------------------------------------------------------------
export type { RequestFailureKind } from './errors.js';
export {
  adviceFor,
  classifyStatus,
  ProviderConfigurationError,
  ProviderRequestError,
} from './errors.js';
// --- Entry point -----------------------------------------------------------
export type { CreateGatewayOptions, GatewayBundle } from './factory.js';
export { createGateway, FALLBACK_MODEL, isPriced } from './factory.js';
// --- The gateway -----------------------------------------------------------
export type { GatewayOptions, LanguageModelFactory } from './gateway.js';
export { AiSdkGateway } from './gateway.js';
// --- History and tool conversion -------------------------------------------
export { toModelMessages, toToolSet } from './messages.js';
// --- Credential redaction --------------------------------------------------
export type { Redactor } from './redact.js';
export { createRedactor, REDACTED, redact } from './redact.js';
// --- Usage mapping ---------------------------------------------------------
export type { SdkUsage } from './usage.js';
export { toProtocolUsage } from './usage.js';
