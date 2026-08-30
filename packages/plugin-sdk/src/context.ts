/**
 * Surface 2 — context providers.
 *
 * Two kinds, and the split is the point. A **glob** provider is pure declaration:
 * patterns, a trigger, and nothing to compile — which is how a non-programmer
 * contributes "pull in our ADRs when someone writes `@adr`". A **wasm** provider
 * exports one function and can do anything, at the cost of a toolchain.
 *
 * ## What is real here
 *
 * Glob providers work end to end. WASM providers call
 * `provide_context(query) -> Chunk[]` through the guest host, which means they work
 * on the JS-module runtime and are refused on the WASM runtime, because there is no
 * WASM runtime yet. `wasm.ts` explains why that is a refusal and not a skip.
 *
 * ## Filesystem access is a seam, deliberately
 *
 * {@link ContextFileSystem} exists rather than a direct `node:fs` dependency so a
 * provider can be tested without touching a disk, and so a host can hand this
 * module a reader that is already scoped to what the plugin's `permissions.filesystem`
 * allows. A provider declaring `filesystem: "none"` should not receive a reader that
 * can open files, and that is enforceable only if the reader is injected.
 */

import { compileGlobSet, toPosix } from './glob.js';
import type { ContextProviderContribution, PluginDiagnostic } from './manifest.js';
import { errorDiagnostic } from './manifest.js';
import { callGuest, type GuestModule } from './wasm.js';

/** One piece of retrieved content, as the spec's Rust example returns it. */
export interface ContextChunk {
  /** Where it came from, for a citation the model can repeat. */
  readonly source: string;
  readonly content: string;
  /** 0..1. Advisory: the assembler ranks, a provider does not get to jump a queue. */
  readonly relevance: number;
}

export interface ContextFileSystem {
  /** Workspace-relative POSIX paths. */
  list(root: string): Promise<readonly string[]>;
  read(path: string): Promise<string>;
}

export interface ResolvedContextProvider {
  readonly pluginId: string;
  readonly name: string;
  readonly trigger: string;
  readonly kind: 'glob' | 'wasm';
  /** Bytes this provider may contribute in one resolution. */
  readonly maxBytes: number;
  resolve(query: string): Promise<ContextResolution>;
}

export interface ContextResolution {
  readonly chunks: readonly ContextChunk[];
  readonly diagnostics: readonly PluginDiagnostic[];
  /** True when content was dropped to stay inside `maxBytes`. */
  readonly truncated: boolean;
}

/** 64 KiB. A provider that wants more should say so and justify it at review. */
export const DEFAULT_PROVIDER_MAX_BYTES = 64 * 1024;

export interface GlobProviderDeps {
  readonly workspaceRoot: string;
  readonly files: ContextFileSystem;
}

export type ProviderBuildOutcome =
  | { readonly ok: true; readonly provider: ResolvedContextProvider }
  | { readonly ok: false; readonly diagnostics: readonly PluginDiagnostic[] };

/**
 * Build a declarative glob provider.
 *
 * The pattern set is compiled at build time rather than per resolution, so a bad
 * pattern is a load-time diagnostic naming the pattern instead of a provider that
 * silently returns nothing during a turn — the failure mode that makes a plugin look
 * like it does nothing.
 */
export function buildGlobProvider(
  pluginId: string,
  contribution: Extract<ContextProviderContribution, { type: 'glob' }>,
  deps: GlobProviderDeps,
): ProviderBuildOutcome {
  const compiled = compileGlobSet(contribution.patterns);
  if (!compiled.ok) {
    return {
      ok: false,
      diagnostics: compiled.messages.map((message) =>
        errorDiagnostic(
          'manifest-schema',
          `plugin '${pluginId}' context provider '${contribution.name}': ${message}`,
          'contributes.contextProviders',
        ),
      ),
    };
  }

  const maxBytes = contribution.maxBytes ?? DEFAULT_PROVIDER_MAX_BYTES;
  const matches = compiled.matches;

  return {
    ok: true,
    provider: {
      pluginId,
      name: contribution.name,
      trigger: contribution.trigger,
      kind: 'glob',
      maxBytes,
      async resolve(): Promise<ContextResolution> {
        let listed: readonly string[];
        try {
          listed = await deps.files.list(deps.workspaceRoot);
        } catch (error) {
          return {
            chunks: [],
            truncated: false,
            diagnostics: [
              errorDiagnostic(
                'file-missing',
                `plugin '${pluginId}' provider '${contribution.name}' could not list the ` +
                  `workspace: ${error instanceof Error ? error.message : String(error)}`,
              ),
            ],
          };
        }

        // Sorted so the same workspace produces the same context every time. An
        // unstable order is a provider-cache miss on every turn, which is the same
        // failure core's epochs exist to prevent.
        const selected = listed.map(toPosix).filter(matches).sort();
        return await readWithinBudget(selected, maxBytes, deps, pluginId, contribution.name);
      },
    },
  };
}

/**
 * Read matched files until the byte budget runs out.
 *
 * The budget is enforced per chunk rather than by reading everything and cutting at
 * the end: a provider pointed at a large tree would otherwise load the whole thing
 * into memory to discard most of it.
 */
async function readWithinBudget(
  selected: readonly string[],
  maxBytes: number,
  deps: GlobProviderDeps,
  pluginId: string,
  providerName: string,
): Promise<ContextResolution> {
  const diagnostics: PluginDiagnostic[] = [];
  const chunks: ContextChunk[] = [];
  let used = 0;
  let truncated = false;

  for (const path of selected) {
    if (used >= maxBytes) {
      truncated = true;
      break;
    }

    let content: string;
    try {
      content = await deps.files.read(path);
    } catch (error) {
      diagnostics.push(
        errorDiagnostic(
          'file-missing',
          `plugin '${pluginId}' provider '${providerName}' matched '${path}' but ` +
            `could not read it: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      continue;
    }

    const remaining = maxBytes - used;
    const clipped = content.length > remaining ? content.slice(0, remaining) : content;
    if (clipped.length < content.length) truncated = true;
    used += clipped.length;
    // A declarative provider has no basis for ranking, so it does not pretend to:
    // every chunk carries the same relevance and the assembler decides.
    chunks.push({ source: path, content: clipped, relevance: 0.5 });
  }

  return { chunks, diagnostics, truncated };
}

export interface WasmProviderDeps {
  readonly guest: GuestModule;
  readonly timeoutMs: number;
}

/** The exported function name a WASM context provider must offer. */
export const PROVIDE_CONTEXT_EXPORT = 'provide_context';

/**
 * Build a WASM (or JS-module) context provider.
 *
 * A provider that times out or faults contributes **nothing** and says so. That is
 * the opposite of the hook timeout rule, and correctly so: a hook's non-answer is a
 * question about permission, while a provider's non-answer is just missing context.
 * Substituting stale or partial content would be worse than an empty result, because
 * the model would cite it.
 */
export function buildWasmProvider(
  pluginId: string,
  contribution: Extract<ContextProviderContribution, { type: 'wasm' }>,
  deps: WasmProviderDeps,
): ResolvedContextProvider {
  const maxBytes = contribution.maxBytes ?? DEFAULT_PROVIDER_MAX_BYTES;
  return {
    pluginId,
    name: contribution.name,
    trigger: contribution.trigger,
    kind: 'wasm',
    maxBytes,
    async resolve(query: string): Promise<ContextResolution> {
      const outcome = await callGuest(
        deps.guest,
        PROVIDE_CONTEXT_EXPORT,
        { query },
        deps.timeoutMs,
      );

      if (outcome.kind === 'timeout') {
        return {
          chunks: [],
          truncated: false,
          diagnostics: [
            errorDiagnostic(
              'hook-timeout',
              `plugin '${pluginId}' provider '${contribution.name}' did not answer within ` +
                `${deps.timeoutMs} ms. No context was contributed for '${query}'.`,
            ),
          ],
        };
      }
      if (outcome.kind === 'error') {
        return {
          chunks: [],
          truncated: false,
          diagnostics: [
            errorDiagnostic(
              'hook-error',
              `plugin '${pluginId}' provider '${contribution.name}' failed: ${outcome.message}`,
            ),
          ],
        };
      }

      const decoded = decodeChunks(outcome.value);
      if (!decoded.ok) {
        return {
          chunks: [],
          truncated: false,
          diagnostics: [
            errorDiagnostic(
              'hook-error',
              `plugin '${pluginId}' provider '${contribution.name}' returned an unusable ` +
                `value: ${decoded.message}`,
            ),
          ],
        };
      }

      let used = 0;
      let truncated = false;
      const chunks: ContextChunk[] = [];
      for (const chunk of decoded.chunks) {
        if (used >= maxBytes) {
          truncated = true;
          break;
        }
        const remaining = maxBytes - used;
        const content =
          chunk.content.length > remaining ? chunk.content.slice(0, remaining) : chunk.content;
        if (content.length < chunk.content.length) truncated = true;
        used += content.length;
        chunks.push({ ...chunk, content });
      }

      return { chunks, diagnostics: [], truncated };
    },
  };
}

type ChunkDecode =
  | { readonly ok: true; readonly chunks: readonly ContextChunk[] }
  | { readonly ok: false; readonly message: string };

function decodeChunks(value: unknown): ChunkDecode {
  if (!Array.isArray(value)) {
    return { ok: false, message: 'provide_context must return an array of chunks' };
  }
  const chunks: ContextChunk[] = [];
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, message: `chunk ${index} is not an object` };
    }
    const record = entry as { source?: unknown; content?: unknown; relevance?: unknown };
    if (typeof record.source !== 'string' || record.source.length === 0) {
      return { ok: false, message: `chunk ${index} has no 'source'` };
    }
    if (typeof record.content !== 'string') {
      return { ok: false, message: `chunk ${index} has no 'content'` };
    }
    const relevance = typeof record.relevance === 'number' ? record.relevance : 0.5;
    chunks.push({
      source: record.source,
      content: record.content,
      relevance: Math.min(1, Math.max(0, relevance)),
    });
  }
  return { ok: true, chunks };
}
