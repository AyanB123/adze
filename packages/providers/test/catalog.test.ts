import { computeCost } from '@adze/core';
import { describe, expect, it } from 'vitest';
import { capabilitiesFor, findEntry, loadCatalog, modelsOf, priceFor } from '../src/catalog.js';

describe('catalog data', () => {
  it('parses at import and states its own limitations', () => {
    const catalog = loadCatalog();

    expect(catalog.version).toBe(1);
    expect(catalog.models.length).toBeGreaterThan(0);
    // The table is required to say what it does not model — cache-write premiums,
    // long-context tiers, batch pricing. A price table that looks complete and is not is
    // worse than one that says where it stops.
    expect(catalog.notModelled.length).toBeGreaterThan(0);
  });

  it('cites a first-party source per provider', () => {
    const catalog = loadCatalog();

    for (const provider of new Set(catalog.models.map((entry) => entry.provider))) {
      expect(catalog.sources[provider], `no source recorded for '${provider}'`).toBeDefined();
    }
  });

  it('prices cache reads below full input on every entry', () => {
    // The relation the whole epoch design depends on. An entry where they are equal is a
    // transcription error, and it would silently make caching look worthless.
    for (const entry of loadCatalog().models) {
      expect(
        entry.prices.cachedInputPerMTok,
        `${entry.provider}/${entry.id} prices cache reads at or above full input`,
      ).toBeLessThan(entry.prices.inputPerMTok);
    }
  });

  it('never records a zero rate, which would read as free', () => {
    for (const entry of loadCatalog().models) {
      expect(entry.prices.inputPerMTok, `${entry.id} input`).toBeGreaterThan(0);
      expect(entry.prices.outputPerMTok, `${entry.id} output`).toBeGreaterThan(0);
    }
  });
});

describe('lookup', () => {
  it('resolves a model by its id', () => {
    expect(findEntry('anthropic', 'claude-sonnet-4-5')?.id).toBe('claude-sonnet-4-5');
  });

  it('resolves a dated snapshot through its alias', () => {
    // Benchmark reports are required to pin a dated snapshot, so the dated form has to
    // price identically to the alias rather than falling into the unknown path.
    expect(findEntry('anthropic', 'claude-sonnet-4-5-20250929')?.id).toBe('claude-sonnet-4-5');
    expect(priceFor('anthropic', 'claude-sonnet-4-5-20250929')).toEqual(
      priceFor('anthropic', 'claude-sonnet-4-5'),
    );
  });

  it('does not resolve a model id across providers', () => {
    // `gpt-5.4` through OpenAI and through a proxy are different endpoints, different
    // keys, and different prices.
    expect(findEntry('anthropic', 'gpt-5.4')).toBeUndefined();
  });

  it('lists the models of one provider', () => {
    expect(modelsOf('openai').every((entry) => entry.provider === 'openai')).toBe(true);
    expect(modelsOf('nonexistent')).toHaveLength(0);
  });
});

describe('the unknown-cost path', () => {
  it('reports undefined rather than zero for a model it has never seen', () => {
    // Load-bearing. Core refuses a `maxSpendUsd` budget when prices are undefined; a
    // zero here would turn that refusal into a ceiling that never fires.
    expect(priceFor('local', 'qwen2.5-coder')).toBeUndefined();
  });

  it('marks the cost unknown and says so on the capability record', () => {
    const capabilities = capabilitiesFor('local', 'qwen2.5-coder');

    expect(capabilities.costUnknown).toBe(true);
    expect(capabilities.prices).toBeUndefined();
  });

  it('assumes tool calling but not vision or a context window for an unknown model', () => {
    const capabilities = capabilitiesFor('local', 'qwen2.5-coder');

    // Assuming tool calling keeps the compatible transport usable, and a model that
    // lacks it fails loudly on the first request. Assuming vision or a context window
    // would be a claim with no evidence behind it.
    expect(capabilities.nativeToolCalling).toBe(true);
    expect(capabilities.degraded).toBe(false);
    expect(capabilities.vision).toBe(false);
    expect(capabilities.contextWindow).toBeUndefined();
  });
});

describe('capabilities', () => {
  it('derives degraded from native tool calling rather than storing it twice', () => {
    for (const entry of loadCatalog().models) {
      const capabilities = capabilitiesFor(entry.provider, entry.id);
      expect(capabilities.degraded).toBe(!capabilities.nativeToolCalling);
    }
  });

  it('leaves an unverified context window undefined instead of guessing', () => {
    // A number here is a capability claim. `undefined` means no first-party page states
    // one, which is a different answer from "unlimited".
    const entries = loadCatalog().models;
    const stated = entries.filter((entry) => entry.contextWindow !== undefined);

    expect(stated.length).toBeGreaterThan(0);
    for (const entry of stated) {
      expect(entry.contextWindow).toBeGreaterThan(1000);
    }
  });
});

describe('cost, through core', () => {
  it('charges cached tokens at the cache rate, not the input rate', () => {
    const prices = priceFor('anthropic', 'claude-sonnet-4-5');
    expect(prices).toBeDefined();
    if (prices === undefined) return;

    const cost = computeCost(
      { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0, cacheHitRate: 0.5 },
      prices,
    );

    expect(cost.inputUsd).toBeCloseTo(prices.inputPerMTok, 10);
    expect(cost.cachedInputUsd).toBeCloseTo(prices.cachedInputPerMTok, 10);
    // The whole reason the split exists: the cached million costs a tenth of the
    // uncached one on this model.
    expect(cost.cachedInputUsd).toBeLessThan(cost.inputUsd);
    expect(cost.totalUsd).toBeCloseTo(cost.inputUsd + cost.cachedInputUsd, 10);
  });
});
