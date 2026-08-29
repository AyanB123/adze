import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sequentialIdFactory } from '../src/ids.js';
import { defineTool, ToolRegistry } from '../src/registry.js';
import { builtinTools } from '../src/tools/index.js';

function tool(name: string) {
  return defineTool({
    name,
    description: `the ${name} tool`,
    schema: z.object({ value: z.string().optional() }),
    effects: () => [],
    execute: async () => await Promise.resolve({ ok: true, content: [] }),
  });
}

describe('ToolRegistry', () => {
  it('registers, looks up, and lists', () => {
    const registry = new ToolRegistry([tool('a'), tool('b')]);
    expect(registry.names()).toEqual(['a', 'b']);
    expect(registry.has('a')).toBe(true);
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.all()).toHaveLength(2);
  });

  it('refuses a duplicate rather than replacing', () => {
    // Silent replacement would let a plugin shadow `bash` or `edit` with something that
    // looks identical to the model, which the plugin architecture does not grant.
    const registry = new ToolRegistry([tool('a')]);
    expect(() => registry.register(tool('a'))).toThrow(/already registered/);
  });

  it('sorts the provider catalog by name', () => {
    // Part of the request the provider caches on: a reordered tool list is a cache miss
    // on every step, which is the failure epochs exist to prevent.
    const registry = new ToolRegistry([tool('z'), tool('m'), tool('a')]);
    expect(registry.catalog().map((spec) => spec.name)).toEqual(['a', 'm', 'z']);
  });

  it('produces JSON Schema parameters for each tool', () => {
    const spec = new ToolRegistry([tool('a')]).catalog()[0];
    expect(spec?.parameters).toMatchObject({ type: 'object' });
  });

  it('narrow returns a strict subset', () => {
    const registry = new ToolRegistry([tool('a'), tool('b'), tool('c')]);
    const narrowed = registry.narrow(['a', 'c']);
    expect(narrowed.ok).toBe(true);
    if (!narrowed.ok) return;
    expect(narrowed.registry.names()).toEqual(['a', 'c']);
    expect(narrowed.registry.has('b')).toBe(false);
  });

  it('narrow cannot widen', () => {
    // Filters rather than looks up, so a subset is structural rather than checked.
    const registry = new ToolRegistry([tool('a')]);
    const narrowed = registry.narrow(['a', 'nonexistent']);
    expect(narrowed.ok).toBe(false);
    if (narrowed.ok) return;
    expect(narrowed.unknown).toEqual(['nonexistent']);
  });
});

describe('defineTool', () => {
  it('validates before exposing execute', () => {
    const prepared = tool('a').prepare({ value: 42 });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.issues[0]).toContain('value');
  });

  it('exposes effects and execute only after validation succeeds', () => {
    // The shape is the mechanism: there is no signature that accepts unvalidated
    // arguments, so "remember to validate" is not a rule anyone can forget.
    const prepared = tool('a').prepare({ value: 'ok' });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(typeof prepared.call.effects).toBe('function');
    expect(typeof prepared.call.execute).toBe('function');
  });

  it('every built-in advertises a description and parameters', () => {
    for (const spec of new ToolRegistry(
      builtinTools({ nextId: sequentialIdFactory() }),
    ).catalog()) {
      expect(spec.description.length).toBeGreaterThan(20);
      expect(spec.parameters).toMatchObject({ type: 'object' });
    }
  });

  it('registers exactly the built-ins ADR-0004 lists as implemented', () => {
    // `fetch` is named in ADR-0004 and is deliberately absent: it is the one tool that
    // makes an outbound network call, and it needs host policy the broker cannot yet
    // enforce. A test rather than a comment, so adding it is a deliberate act.
    const names = builtinTools({ nextId: sequentialIdFactory() }).map((t) => t.name);
    expect([...names].sort()).toEqual([
      'bash',
      'edit',
      'glob',
      'grep',
      'read',
      'symbols',
      'task',
      'todo',
      'write',
    ]);
  });
});
