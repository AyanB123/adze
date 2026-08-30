/**
 * `adze models` — what is configured, and what the price table knows.
 *
 * Registered because `@adze/providers` already exposes everything it needs:
 * {@link resolveConfig} for the providers, {@link modelsOf} for the catalog, and
 * {@link capabilitiesFor} for the per-model facts. No new provider work was required, which
 * is the only reason this command is here rather than on the roadmap.
 *
 * ### It makes no network call
 *
 * It reports what is *configured*, never what is reachable. Probing every endpoint to
 * render a list would turn a diagnostic into an outbound request the user did not ask for,
 * which architecture invariant 5 forbids without an explicit opt-in. So a provider with a
 * key present is reported as having a key present — not as working.
 *
 * ### A credential is reported as present, never shown
 *
 * The variable *name* that supplied the key is useful, because the common failure is
 * having exported the wrong one of two accepted names. The value never is. `apiKeySource`
 * is a name by construction in `@adze/providers`, and nothing here reads `apiKey`.
 *
 * ### `unknown` is not a defect
 *
 * Every OpenAI-compatible endpoint is unpriced, so a model with no rates prints `unknown`
 * rather than `$0.00`. Zero would read as free, and a cost report that understates is worse
 * than one that admits the gap (ADR-0011).
 */

import {
  capabilitiesFor,
  loadCatalog,
  type ModelCapabilities,
  modelsOf,
  type ResolvedProvider,
  type ResolveOptions,
  resolveConfig,
} from '@adze/providers';
import { renderFailure } from '../agent/failure.js';
import { EXIT, type ExitCode, field, type Io, type Style, styleFor, writeJson } from '../output.js';

export interface ModelsOptions {
  readonly json?: boolean;
  readonly all?: boolean;
  /**
   * Isolates configuration resolution from the real environment.
   *
   * Without it a test of this command asserts what the developer happens to have exported,
   * not what the code does. See `buildAgent`'s `resolve` for the same seam and reason.
   */
  readonly __testHooks?: { readonly resolve?: ResolveOptions };
}

interface ModelRow {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  /** True when a request to the owning provider could actually be made. */
  readonly configured: boolean;
}

/**
 * Whether a request to this provider could be made at all.
 *
 * Mirrors `AiSdkGateway.assertCredential`, and has to: an `openai-compatible` endpoint —
 * a local llama.cpp or Ollama server, or a gateway on localhost — legitimately needs no
 * credential, and that check skips them for exactly that reason. Treating a missing key
 * as "unconfigured" here hid every model behind a keyless local endpoint, including the
 * one `defaultModel` names, so the list disagreed with what `adze run` was about to do.
 * A list that omits the model the next command will use is worse than no list.
 *
 * A credential is still *reported* when absent, because an OpenAI-compatible endpoint
 * that is a hosted gateway does need one. Optional is not the same as unnecessary.
 */
function isUsable(provider: ResolvedProvider): boolean {
  return provider.apiKey !== undefined || provider.kind === 'openai-compatible';
}

function rowsFor(providers: readonly ResolvedProvider[], includeAll: boolean): ModelRow[] {
  const rows: ModelRow[] = [];
  for (const provider of providers) {
    const configured = isUsable(provider);
    if (!configured && !includeAll) continue;

    for (const entry of modelsOf(provider.id)) {
      rows.push({
        provider: provider.id,
        model: entry.id,
        capabilities: capabilitiesFor(provider.id, entry.id),
        configured,
      });
    }

    // A declared default that the catalog has never heard of — the normal case for a local
    // endpoint. Listed anyway, because it is the model that would actually be used, and
    // omitting it would make the list disagree with what `adze run` reports.
    const declared = provider.defaultModel;
    if (
      declared !== undefined &&
      !rows.some((row) => row.provider === provider.id && row.model === declared)
    ) {
      rows.push({
        provider: provider.id,
        model: declared,
        capabilities: capabilitiesFor(provider.id, declared),
        configured,
      });
    }
  }
  return rows;
}

/**
 * How a provider's credential state reads.
 *
 * A keyless `openai-compatible` entry is not a misconfiguration, so it is not styled as a
 * warning and is not given an instruction to set a variable. It is reported as optional
 * rather than as unnecessary, because the same transport is how a hosted gateway is
 * configured and that one does need a key — the difference is not something this command
 * can determine without making the request it promises not to make.
 */
function credentialLine(provider: ResolvedProvider, style: Style): string {
  if (provider.apiKeySource !== undefined) {
    return style.good(`key from ${provider.apiKeySource}`);
  }
  if (provider.kind === 'openai-compatible') {
    return style.dim(
      `no credential — optional for openai-compatible (set ${provider.apiKeyEnvCandidates.join(' or ')} if the endpoint needs one)`,
    );
  }
  return style.warn(`no credential (set ${provider.apiKeyEnvCandidates.join(' or ')})`);
}

function renderProviders(providers: readonly ResolvedProvider[], io: Io, style: Style): void {
  io.out(`${style.bold('Providers')}\n`);
  for (const provider of providers) {
    io.out(`${field(provider.id, credentialLine(provider, style))}\n`);
    if (provider.baseURL !== undefined) {
      io.out(`${field('', style.dim(provider.baseURL))}\n`);
    }
  }
  io.out('\n');
}

function renderRows(rows: readonly ModelRow[], io: Io, style: Style): void {
  io.out(`${style.bold('Models')}\n`);
  if (rows.length === 0) {
    io.out(
      `  ${style.warn('No provider has a credential configured.')}\n` +
        `  ${style.dim('`adze models --all` lists the catalog anyway.')}\n`,
    );
    return;
  }

  for (const row of rows) {
    const cost = row.capabilities.costUnknown ? style.warn('cost unknown') : 'priced';
    const marks = [cost];
    if (row.capabilities.vision) marks.push('vision');
    if (row.capabilities.degraded) marks.push(style.warn('no tool calling'));
    if (!row.configured) marks.push(style.dim('provider unconfigured'));

    io.out(`  ${`${row.provider}/${row.model}`.padEnd(44)} ${marks.join(' · ')}\n`);
  }
}

export async function runModels(options: ModelsOptions, io: Io): Promise<ExitCode> {
  const json = options.json === true;
  const style = styleFor(json);

  let config: ReturnType<typeof resolveConfig>;
  try {
    config = resolveConfig({ cwd: process.cwd(), ...options.__testHooks?.resolve });
  } catch (error) {
    // A malformed `.adze/providers.json` is the realistic failure. Rendered through the
    // shared path so the message reads the same as it does from `run`.
    return renderFailure(error, io, style).code;
  }

  const catalog = loadCatalog();
  const rows = rowsFor(config.providers, options.all === true);

  if (json) {
    writeJson(io, {
      defaultModel: config.defaultModel ?? null,
      sources: config.sources,
      catalog: { sourcedOn: catalog.sourcedOn, notModelled: catalog.notModelled },
      providers: config.providers.map((provider) => ({
        id: provider.id,
        kind: provider.kind,
        // Whether a key resolved and which *name* supplied it. Never the value.
        credentialConfigured: provider.apiKey !== undefined,
        credentialSource: provider.apiKeySource ?? null,
        credentialCandidates: provider.apiKeyEnvCandidates,
        /**
         * Whether a request could be made. Distinct from `credentialConfigured`, because
         * an openai-compatible endpoint may need no credential at all.
         */
        usable: isUsable(provider),
        baseUrl: provider.baseURL ?? null,
        defaultModel: provider.defaultModel ?? null,
      })),
      models: rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        providerConfigured: row.configured,
        nativeToolCalling: row.capabilities.nativeToolCalling,
        vision: row.capabilities.vision,
        contextWindow: row.capabilities.contextWindow ?? null,
        degraded: row.capabilities.degraded,
        costKnown: !row.capabilities.costUnknown,
        prices: row.capabilities.prices ?? null,
      })),
    });
    return EXIT.Ok;
  }

  io.out(`${style.bold('adze models')}\n\n`);
  renderProviders(config.providers, io, style);
  renderRows(rows, io, style);

  io.out(`\n${field('default model', config.defaultModel ?? style.dim('none set'))}\n`);
  io.out(`${field('prices sourced on', catalog.sourcedOn)}\n`);
  if (config.sources.length > 0) {
    io.out(`${field('config read from', config.sources.join(', '))}\n`);
  }

  // The table's own stated gaps, surfaced rather than buried. A cost figure whose
  // limitations live only in a JSON file nobody opens is a figure without its caveats.
  if (catalog.notModelled.length > 0) {
    io.out(`\n${style.bold('Not modelled by the price table')}\n`);
    for (const item of catalog.notModelled) io.out(`  - ${item}\n`);
  }

  return EXIT.Ok;
}
