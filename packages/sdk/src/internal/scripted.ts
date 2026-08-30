/**
 * The offline provider.
 *
 * Wraps `@adze/core`'s `ScriptedProvider` so an example, a test, or a CI job can
 * drive a complete turn — tools, gate, budgets, cancellation, events — with **no API
 * key, no network, and no cost**. That matters beyond convenience: it is what lets
 * the runnable example in `examples/` be part of the test suite rather than a snippet
 * nobody executes, and it is why a contributor with no provider account can still
 * check that the engine works end to end.
 *
 * It is exposed as an SDK function rather than by re-exporting core's class, for the
 * usual reason: `ScriptedProvider` is a core type, and a consumer who named it would
 * be depending on a core internal through this package. The option types in
 * `src/types.ts` are this package's own and are expressed in protocol vocabulary.
 *
 * Swapping in a real provider is a one-line change — see README.md.
 */

import { ScriptedProvider } from '@adze/core';
import type { ModelProviderLike, ScriptedProviderOptions } from '../types.js';

export function scriptedProvider(options: ScriptedProviderOptions): ModelProviderLike {
  return new ScriptedProvider({
    name: options.name ?? 'scripted',
    nativeToolCalling: options.nativeToolCalling ?? true,
    ...(options.prices === undefined ? {} : { prices: options.prices }),
    script: options.script.map((step) => ({
      ...(step.text === undefined ? {} : { text: step.text }),
      ...(step.textDeltas === undefined ? {} : { textDeltas: step.textDeltas }),
      ...(step.toolCalls === undefined ? {} : { toolCalls: step.toolCalls }),
      ...(step.inputTokens === undefined ? {} : { inputTokens: step.inputTokens }),
      ...(step.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: step.cachedInputTokens }),
      ...(step.outputTokens === undefined ? {} : { outputTokens: step.outputTokens }),
      ...(step.delayMs === undefined ? {} : { delayMs: step.delayMs }),
      // Renamed on the way in: `throws` reads as a control-flow keyword at a call
      // site, and this option is data describing a step.
      ...(step.fails === undefined ? {} : { throws: step.fails }),
    })),
  });
}
