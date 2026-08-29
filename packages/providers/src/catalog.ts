/**
 * The model catalog: prices and capabilities, loaded from data.
 *
 * `catalog.json` is the table; this file is the loader. That split is the point.
 * Prices change on a vendor's schedule, not ours, and a table compiled into
 * TypeScript makes updating a price an engineering change with a review, a build,
 * and a release — which is how a project ends up quoting a number that was right
 * six months ago. A contributor correcting a rate edits one JSON file and touches
 * no code.
 *
 * The table is parsed with Zod at module load rather than trusted. It is data
 * under version control, so it can be wrong in exactly the ways data is wrong: a
 * duplicated id, a price typed as a string, a field renamed by a careless edit. A
 * malformed catalog fails at import with a message naming the entry, because the
 * alternative is `undefined` arithmetic producing a cost of `NaN` and a spend
 * budget that never triggers.
 *
 * **An unpriced model reports `undefined`, never zero.** That is the whole reason
 * {@link ModelProvider.priceFor} is nullable: core refuses a `maxSpendUsd` budget
 * it cannot enforce, and reporting `0` for a model we have no rate for would turn
 * that refusal into a budget that silently never fires.
 */

import type { PriceSheet } from '@adze/core';
import { z } from 'zod';
import catalogData from './catalog.json' with { type: 'json' };

const PriceSheetSchema = z.strictObject({
  currency: z.string().length(3),
  inputPerMTok: z.number().nonnegative(),
  cachedInputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
});

const CatalogEntrySchema = z.strictObject({
  provider: z.string().min(1),
  id: z.string().min(1),
  /** Dated snapshots and vendor aliases that bill at the same rate. */
  aliases: z.array(z.string().min(1)).default([]),
  nativeToolCalling: z.boolean(),
  vision: z.boolean(),
  /**
   * Absent means unverified.
   *
   * Not "unlimited" and not a default: a number here is a capability claim, and
   * the honest answer when no first-party page states one is to say so. See
   * `notModelled` in the JSON.
   */
  contextWindow: z.number().int().positive().optional(),
  prices: PriceSheetSchema,
});

const CatalogSchema = z.strictObject({
  version: z.literal(1),
  /** When the rates were last read off a first-party page. Rendered by `adze models`. */
  sourcedOn: z.string().min(1),
  sources: z.record(z.string(), z.string().url()),
  /** Stated limitations of the table itself, surfaced rather than buried. */
  notModelled: z.array(z.string().min(1)),
  models: z.array(CatalogEntrySchema).min(1),
});

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type Catalog = z.infer<typeof CatalogSchema>;

/**
 * What a surface may say about a model.
 *
 * `degraded` is derived rather than stored, so the two facts cannot drift apart:
 * ADR-0004 defines a degraded provider as one without native tool calling, and
 * duplicating that as its own boolean would let a catalog entry claim both.
 */
export interface ModelCapabilities {
  readonly provider: string;
  readonly model: string;
  readonly nativeToolCalling: boolean;
  readonly vision: boolean;
  /** `undefined` when no first-party source states one. Never guessed. */
  readonly contextWindow: number | undefined;
  /** True when the model has no native tool calling, so turns run without tools. */
  readonly degraded: boolean;
  /** `undefined` for a model the table has no rates for. Never zero. */
  readonly prices: PriceSheet | undefined;
  /** True when this model is absent from the table, so cost cannot be reported. */
  readonly costUnknown: boolean;
}

function parseCatalog(): Catalog {
  const parsed = CatalogSchema.safeParse(catalogData);
  if (!parsed.success) {
    // Thrown at import. A catalog that does not parse cannot produce a cost, and a
    // cost of NaN is worse than a startup failure because it is quoted.
    throw new Error(
      `packages/providers/src/catalog.json is malformed: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

const catalog = parseCatalog();

function keyOf(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

/**
 * Index every id and alias.
 *
 * A duplicate key throws rather than letting the later entry win. Two entries for
 * one model means someone edited the table twice and the rate that applies depends
 * on array order, which nobody reviewing a JSON diff would notice.
 */
function buildIndex(entries: readonly CatalogEntry[]): ReadonlyMap<string, CatalogEntry> {
  const index = new Map<string, CatalogEntry>();
  for (const entry of entries) {
    for (const name of [entry.id, ...entry.aliases]) {
      const key = keyOf(entry.provider, name);
      const existing = index.get(key);
      if (existing !== undefined) {
        throw new Error(
          `packages/providers/src/catalog.json lists '${entry.provider}/${name}' twice ` +
            `(as '${existing.id}' and '${entry.id}'), so which price applies depends on ` +
            `array order`,
        );
      }
      index.set(key, entry);
    }
  }
  return index;
}

const index = buildIndex(catalog.models);

/** The table as loaded. For `adze models` and for tests. */
export function loadCatalog(): Catalog {
  return catalog;
}

/** The entry for a model id or alias, or `undefined` when the table has none. */
export function findEntry(provider: string, model: string): CatalogEntry | undefined {
  return index.get(keyOf(provider, model));
}

/**
 * Prices for a model, or `undefined`.
 *
 * The nullable return is load-bearing; see the file comment.
 */
export function priceFor(provider: string, model: string): PriceSheet | undefined {
  return findEntry(provider, model)?.prices;
}

/**
 * What we know about a model, including that we know nothing.
 *
 * An id absent from the table is assumed to have native tool calling and no vision,
 * with cost reported as unknown. That asymmetry is deliberate: a user pointing
 * `openai-compatible` at a local llama.cpp server has a model we have never heard
 * of, and refusing to run it would make the compatible transport useless. Assuming
 * tool calling is safe because a model that lacks it fails loudly on the first
 * request rather than silently producing worse output, whereas assuming vision or a
 * price would produce a claim with nothing behind it.
 */
export function capabilitiesFor(provider: string, model: string): ModelCapabilities {
  const entry = findEntry(provider, model);
  if (entry === undefined) {
    return {
      provider,
      model,
      nativeToolCalling: true,
      vision: false,
      contextWindow: undefined,
      degraded: false,
      prices: undefined,
      costUnknown: true,
    };
  }
  return {
    provider,
    model,
    nativeToolCalling: entry.nativeToolCalling,
    vision: entry.vision,
    contextWindow: entry.contextWindow,
    degraded: !entry.nativeToolCalling,
    prices: entry.prices,
    costUnknown: false,
  };
}

/** Catalog entries for one provider id, in table order. */
export function modelsOf(provider: string): readonly CatalogEntry[] {
  return catalog.models.filter((entry) => entry.provider === provider);
}
