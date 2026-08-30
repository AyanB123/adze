/**
 * Surface 6 — UI, and the engine's refusal to accept it.
 *
 * This module exists mostly to make one rule mechanical. ADR-0001 rule 3: **plugins
 * may not inject UI into the engine.** The reasoning is not aesthetic. If a plugin
 * could contribute UI to `@adze/core`, then the CLI, the VS Code extension, and the
 * IDE would each have to render whatever a plugin sent, each would render it
 * differently, and the three surfaces would immediately begin diverging into three
 * products with three bug surfaces — which is the observed failure mode that killed
 * every single-surface project in this category.
 *
 * So the engine-side plugin host has **no UI collection at all**. Not an empty one,
 * not one guarded by a flag: {@link EngineUiRefusal} is what an engine host produces
 * when it encounters a UI contribution, and {@link assertNoEngineUi} throws if
 * anything tries to hand one to the engine anyway.
 *
 * ## A manifest may still declare UI
 *
 * Refusing to *parse* `contributes.ui` would be the wrong enforcement point: a
 * plugin with a deny-capable hook and a status-bar item would become unloadable
 * engine-side, so its policy would stop working in order to protect the engine from
 * a panel it was never going to render. Instead the manifest is valid, the engine
 * host drops UI with a recorded reason, and {@link surfaceUiContributions} hands
 * them to whichever surface asked.
 *
 * ## What the spec leaves open, and what is deliberately not answered
 *
 * The spec has no example UI contribution — surface 6 is "surface-specific and
 * deliberately last". {@link SurfaceUiContribution} is therefore an intentionally
 * thin envelope: which surface, an id, a kind, and an optional entry point. It does
 * not describe a widget, a layout, or a component tree, because inventing a
 * cross-surface UI vocabulary here is exactly the divergence risk this rule exists
 * to prevent. Spec open question 4 asks whether a declarative cross-surface subset
 * could work; nothing in this file assumes it can.
 */

import { errorDiagnostic, type PluginDiagnostic, type UiContribution } from './manifest.js';

/** A UI contribution, addressed to one named surface. */
export interface SurfaceUiContribution extends UiContribution {
  readonly pluginId: string;
}

export interface EngineUiRefusal {
  readonly pluginId: string;
  readonly contributionId: string;
  readonly surface: UiContribution['surface'];
  readonly diagnostic: PluginDiagnostic;
}

/**
 * Thrown when code attempts to give the engine a UI contribution.
 *
 * A thrown error rather than a logged warning. This is an architecture invariant,
 * and an invariant that degrades to a warning under pressure is a convention.
 */
export class EngineUiRefusedError extends Error {
  readonly pluginId: string;
  readonly contributionId: string;

  constructor(pluginId: string, contributionId: string) {
    super(
      `plugin '${pluginId}' offered the UI contribution '${contributionId}' to the engine. ` +
        `The engine renders nothing and accepts no UI contributions (ADR-0001 rule 3): a ` +
        `plugin that could inject UI into the engine would split the CLI, the extension, and ` +
        `the IDE into three products. Contribute it to a surface instead.`,
    );
    this.name = 'EngineUiRefusedError';
    this.pluginId = pluginId;
    this.contributionId = contributionId;
  }
}

/**
 * The engine-side guard.
 *
 * Called on the engine binding path. It throws rather than filtering, because by
 * the time something is *being registered* with the engine the mistake is in code,
 * not in a manifest, and a silent filter would leave the author thinking it worked.
 */
export function assertNoEngineUi(contributions: readonly SurfaceUiContribution[]): void {
  const first = contributions[0];
  if (first !== undefined) throw new EngineUiRefusedError(first.pluginId, first.id);
}

/**
 * Split UI contributions out of a plugin, recording a refusal for each.
 *
 * Used by the loader. The refusal is a `warning`, not an `error`: the plugin loads
 * and its other surfaces work. Making it an error would mean a plugin author who
 * added a status-bar item discovered it by losing their hook.
 */
export function partitionUi(
  pluginId: string,
  contributions: readonly UiContribution[],
): {
  readonly forSurfaces: readonly SurfaceUiContribution[];
  readonly refusals: readonly EngineUiRefusal[];
} {
  const forSurfaces = contributions.map((contribution) => ({ ...contribution, pluginId }));
  const refusals = contributions.map((contribution) => ({
    pluginId,
    contributionId: contribution.id,
    surface: contribution.surface,
    diagnostic: errorDiagnostic(
      'ui-refused-by-engine',
      `plugin '${pluginId}' contributes the UI element '${contribution.id}' for the ` +
        `'${contribution.surface}' surface. The engine does not accept it and never will; it ` +
        `is available to that surface only. Nothing is broken — this is recorded so the ` +
        `boundary is visible rather than assumed.`,
      'contributes.ui',
    ),
  }));
  return { forSurfaces, refusals };
}

/** UI contributions for one named surface. */
export function surfaceUiContributions(
  contributions: readonly SurfaceUiContribution[],
  surface: UiContribution['surface'],
): readonly SurfaceUiContribution[] {
  return contributions.filter((contribution) => contribution.surface === surface);
}
