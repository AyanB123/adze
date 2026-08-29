/**
 * The server half: Adze driven by another agent.
 *
 * Every test drives a real SDK `Client` over the real in-memory transport pair, so the
 * handshake, the tool list, and the call path are the ones a real peer would take.
 */

import type { JsonObject } from '@adze/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { AdzeMcpServer } from '../src/server.js';
import type { AdzeToolImplementation, AdzeToolOutcome } from '../src/types.js';

function tool(
  name: string,
  invoke: (args: JsonObject, signal: AbortSignal) => Promise<AdzeToolOutcome>,
  overrides: Partial<AdzeToolImplementation> = {},
): AdzeToolImplementation {
  return {
    name,
    description: `the ${name} tool`,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    invoke,
    ...overrides,
  };
}

async function connected(server: AdzeMcpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'peer', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('advertising injected tools', () => {
  it('lists them with the injected JSON Schema unchanged', async () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    };
    const server = new AdzeMcpServer({
      tools: [tool('read', async () => ({ ok: true, text: '' }), { inputSchema: schema })],
    });
    const client = await connected(server);

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(1);
    // Advertised verbatim. Converting to Zod so the SDK could convert back would publish
    // a reconstruction of the contract instead of the contract.
    expect(listed.tools[0]?.inputSchema).toEqual(schema);

    await client.close();
    await server.close();
  });

  it('advertises readOnlyHint only when the implementation claims it', async () => {
    const server = new AdzeMcpServer({
      tools: [
        tool('grep', async () => ({ ok: true, text: '' }), { readOnly: true }),
        tool('edit', async () => ({ ok: true, text: '' })),
      ],
    });
    const client = await connected(server);

    const byName = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
    expect(byName.get('grep')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('edit')?.annotations).toBeUndefined();

    await client.close();
    await server.close();
  });

  it('sorts the list, because a peer caches on it', async () => {
    const server = new AdzeMcpServer({
      tools: ['zeta', 'alpha', 'middle'].map((name) =>
        tool(name, async () => ({ ok: true, text: '' })),
      ),
    });
    const client = await connected(server);

    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      'alpha',
      'middle',
      'zeta',
    ]);
    expect(server.toolNames).toEqual(['alpha', 'middle', 'zeta']);

    await client.close();
    await server.close();
  });

  it('refuses two tools with the same name at construction', () => {
    // Mirrors `ToolRegistry.register`. Silent replacement means the peer's choice
    // resolves to whichever was registered last, with no way to discover that it did.
    expect(
      () =>
        new AdzeMcpServer({
          tools: [
            tool('read', async () => ({ ok: true, text: '' })),
            tool('read', async () => ({ ok: true, text: '' })),
          ],
        }),
    ).toThrow(/already registered/);
  });

  it('advertises instructions describing the permission gate', async () => {
    const server = new AdzeMcpServer({ tools: [] });
    const client = await connected(server);
    // A peer that does not know a call can be refused reads a refusal as a bug and
    // retries around it.
    expect(client.getInstructions()).toContain('permission gate');
    await client.close();
    await server.close();
  });
});

describe('invoking an injected tool', () => {
  it('passes arguments through and returns the text', async () => {
    const server = new AdzeMcpServer({
      tools: [tool('echo', async (args) => ({ ok: true, text: `got:${String(args.value)}` }))],
    });
    const client = await connected(server);

    const result = await client.callTool({ name: 'echo', arguments: { value: 'hi' } });
    expect(result.content).toEqual([{ type: 'text', text: 'got:hi' }]);
    expect(result.isError).toBeUndefined();

    await client.close();
    await server.close();
  });

  it('defaults absent arguments to an empty object', async () => {
    const server = new AdzeMcpServer({
      tools: [
        tool('count', async (args) => ({ ok: true, text: String(Object.keys(args).length) })),
      ],
    });
    const client = await connected(server);

    const result = await client.callTool({ name: 'count' });
    expect(result.content).toEqual([{ type: 'text', text: '0' }]);

    await client.close();
    await server.close();
  });

  it('reports a refusal as isError rather than a protocol error', async () => {
    // A refusal is an outcome the calling *model* should adapt to. A JSON-RPC error is
    // addressed to the calling *program*, which usually logs or retries it instead.
    const server = new AdzeMcpServer({
      tools: [tool('edit', async () => ({ ok: false, text: 'denied by the permission gate' }))],
    });
    const client = await connected(server);

    const result = await client.callTool({ name: 'edit', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('denied by the permission gate');

    await client.close();
    await server.close();
  });

  it('contains a throwing implementation instead of dropping the connection', async () => {
    const server = new AdzeMcpServer({
      tools: [
        tool('broken', async () => {
          throw new Error('implementation bug');
        }),
        tool('fine', async () => ({ ok: true, text: 'ok' })),
      ],
    });
    const client = await connected(server);

    const failed = await client.callTool({ name: 'broken', arguments: {} });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain('implementation bug');

    // The session is still usable, which is the point.
    const after = await client.callTool({ name: 'fine', arguments: {} });
    expect(after.isError).toBeUndefined();

    await client.close();
    await server.close();
  });

  it('answers an unknown tool with the names that exist', async () => {
    const server = new AdzeMcpServer({
      tools: [
        tool('read', async () => ({ ok: true, text: '' })),
        tool('write', async () => ({ ok: true, text: '' })),
      ],
    });
    const client = await connected(server);

    const result = await client.callTool({ name: 'raed', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('read, write');

    await client.close();
    await server.close();
  });

  it('hands the implementation an abort signal', async () => {
    let received: AbortSignal | undefined;
    const server = new AdzeMcpServer({
      tools: [
        tool('slow', async (_args, signal) => {
          received = signal;
          return { ok: true, text: 'done' };
        }),
      ],
    });
    const client = await connected(server);

    await client.callTool({ name: 'slow', arguments: {} });
    // Without a signal an injected tool cannot honour a cancelled request, and a
    // cancelled turn would leave work running.
    expect(received).toBeInstanceOf(AbortSignal);

    await client.close();
    await server.close();
  });
});

describe('teardown', () => {
  it('close is idempotent', async () => {
    const server = new AdzeMcpServer({ tools: [] });
    const client = await connected(server);
    await client.close();

    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
  });
});
