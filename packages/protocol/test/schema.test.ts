import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AdzeEventSchema } from '../src/events.js';
import { METHOD } from '../src/messages.js';
import { UsageSchema } from '../src/primitives.js';
import { protocolJsonSchemaNames, protocolJsonSchemas, toJsonSchema } from '../src/schema.js';

const generatedDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'generated');

describe('JSON Schema generation', () => {
  it('emits draft 2020-12', () => {
    const doc = toJsonSchema(UsageSchema);
    expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('describes the input shape, not the parsed shape', () => {
    // A field with a default is required in the parsed output but optional for a
    // *sender*, and validating senders is what these documents are for.
    const doc = toJsonSchema(UsageSchema);
    expect(doc.type).toBe('object');
    const required = doc.required;
    expect(Array.isArray(required)).toBe(true);
    if (!Array.isArray(required)) return;
    expect(required).toContain('inputTokens');
  });

  it('closes objects, matching the strictObject rule', () => {
    const doc = toJsonSchema(UsageSchema);
    expect(doc.additionalProperties).toBe(false);
  });

  it('renders the event union as a choice of variants', () => {
    const doc = toJsonSchema(AdzeEventSchema);
    const variants = doc.anyOf ?? doc.oneOf;
    expect(Array.isArray(variants)).toBe(true);
    if (!Array.isArray(variants)) return;
    expect(variants.length).toBe(11);
  });

  it('includes params for every method, and results for requests only', () => {
    const names = protocolJsonSchemaNames();
    expect(names).toContain('InitializeParams');
    expect(names).toContain('InitializeResult');
    expect(names).toContain('SessionCreateParams');
    expect(names).toContain('TurnSubmitParams');
    expect(names).toContain('ApprovalRequestParams');
    expect(names).toContain('EventParams');
    // `event` is a notification: a result schema would imply a reply is allowed.
    expect(names).not.toContain('EventResult');
  });

  it('covers every declared method', () => {
    const names = new Set(protocolJsonSchemaNames());
    for (const method of Object.values(METHOD)) {
      const pascal = method
        .split('.')
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join('');
      expect(names.has(`${pascal}Params`)).toBe(true);
    }
  });

  it('produces standalone documents with no unresolved external refs', () => {
    // Each document is handed to a validator on its own, so a `$ref` pointing
    // outside it would make the artifact unusable without a resolver.
    for (const [name, doc] of Object.entries(protocolJsonSchemas())) {
      const text = JSON.stringify(doc);
      for (const ref of text.matchAll(/"\$ref":"([^"]+)"/g)) {
        const target = ref[1] ?? '';
        expect(target.startsWith('#'), `${name} has external $ref ${target}`).toBe(true);
      }
    }
  });

  it('matches the committed artifacts in src/generated', () => {
    // The generated documents are committed because package.json ships them and a
    // consumer validating from Python should not have to run our build. That is
    // only safe if drift is a test failure, so this is that test.
    //
    // If this fails: pnpm --filter @adze/protocol build && pnpm --filter @adze/protocol schema:generate
    const schemas = protocolJsonSchemas();
    for (const [name, doc] of Object.entries(schemas)) {
      const file = join(generatedDir, `${name}.json`);
      const committed = readFileSync(file, 'utf8');
      expect(committed, `${name}.json is stale`).toBe(`${JSON.stringify(doc, null, 2)}\n`);
    }
  });
});
