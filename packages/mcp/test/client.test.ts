/**
 * The client half, end to end.
 *
 * The happy path runs against the SDK's real `McpServer` over the real in-memory
 * transport, so discovery and invocation are proven against a compliant server rather
 * than against a mock built to agree with us. The failure paths use the scripted
 * transport, because a compliant server will not hang, crash, or name an arbitrary
 * protocol revision on request — and those are the paths where the bugs are.
 */

import { describe, expect, it } from 'vitest';
import { connectServer, McpClientHost } from '../src/client.js';
import { mcpTools, mcpToolsFor } from '../src/tools.js';
import type { McpServerConfig } from '../src/types.js';
import { ADZE_PREFERRED_REVISION } from '../src/version.js';
import { initializeResult, linkedServer, ScriptedTransport } from './harness.js';

const stdioConfig: McpServerConfig = {
  name: 'demo',
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
};

describe('discovery against a real MCP server', () => {
  it('lists tools and namespaces their names', async () => {
    const linked = linkedServer([
      { name: 'echo', description: 'Echo the input', readOnly: true, run: ({ text }) => text },
      { name: 'shout', description: 'Uppercase the input', run: ({ text }) => text.toUpperCase() },
    ]);
    await linked.start();

    const outcome = await connectServer(stdioConfig, { transport: linked.clientTransport });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { discovery } = outcome.connection;
    expect(discovery.tools.map((tool) => tool.name)).toEqual([
      'mcp__demo__echo',
      'mcp__demo__shout',
    ]);
    // The remote name is kept separately: it is what goes back over the wire, and
    // sending the namespaced name would make every call fail with "unknown tool".
    expect(discovery.tools.map((tool) => tool.remoteName)).toEqual(['echo', 'shout']);
    expect(discovery.warnings).toEqual([]);

    await outcome.connection.close();
    await linked.server.close();
  });

  it('reports the server read-only hint rather than guessing', async () => {
    const linked = linkedServer([
      { name: 'echo', description: 'Echo', readOnly: true, run: ({ text }) => text },
      { name: 'write', description: 'Write', run: ({ text }) => text },
    ]);
    await linked.start();

    const outcome = await connectServer(stdioConfig, { transport: linked.clientTransport });
    if (!outcome.ok) throw new Error(outcome.message);

    const byName = new Map(outcome.connection.discovery.tools.map((t) => [t.remoteName, t]));
    expect(byName.get('echo')?.readOnly).toBe(true);
    expect(byName.get('write')?.readOnly).toBe(false);

    await outcome.connection.close();
    await linked.server.close();
  });

  it('skips a capability the server never advertised', async () => {
    // tools only. `resources/list` must not be attempted, or a tools-only server logs a
    // "method not found" error on every startup.
    const transport = new ScriptedTransport((request) =>
      request.method === 'initialize'
        ? initializeResult(ADZE_PREFERRED_REVISION, { tools: {} })
        : { result: { tools: [] } },
    );

    const outcome = await connectServer(stdioConfig, { transport });
    if (!outcome.ok) throw new Error(outcome.message);

    expect(transport.seen).toContain('tools/list');
    expect(transport.seen).not.toContain('resources/list');
    expect(transport.seen).not.toContain('prompts/list');

    await outcome.connection.close();
  });

  it('keeps the tools when another capability fails', async () => {
    const transport = new ScriptedTransport((request) => {
      if (request.method === 'initialize') {
        return initializeResult(ADZE_PREFERRED_REVISION, { tools: {}, resources: {} });
      }
      if (request.method === 'tools/list') {
        return { result: { tools: [{ name: 'ok', inputSchema: { type: 'object' } }] } };
      }
      return { error: { code: -32603, message: 'resources are broken' } };
    });

    const outcome = await connectServer(stdioConfig, { transport });
    if (!outcome.ok) throw new Error(outcome.message);

    expect(outcome.connection.discovery.tools).toHaveLength(1);
    expect(outcome.connection.discovery.resources).toEqual([]);
    expect(outcome.connection.discovery.warnings.join(' ')).toContain('resources/list failed');

    await outcome.connection.close();
  });
});

describe('invocation and result mapping', () => {
  it('calls through and maps the result', async () => {
    const linked = linkedServer([
      { name: 'shout', description: 'Uppercase', run: ({ text }) => text.toUpperCase() },
    ]);
    await linked.start();

    const outcome = await connectServer(stdioConfig, { transport: linked.clientTransport });
    if (!outcome.ok) throw new Error(outcome.message);

    const tools = mcpTools(outcome.connection);
    expect(tools).toHaveLength(1);

    const result = await outcome.connection.callTool('shout', { text: 'hello' }, undefined);
    expect(result.ok).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'HELLO' }]);

    await outcome.connection.close();
    await linked.server.close();
  });

  it('advertises the server own JSON Schema unchanged', async () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string', description: 'a path' } },
      required: ['path'],
    };
    const transport = new ScriptedTransport((request) =>
      request.method === 'initialize'
        ? initializeResult(ADZE_PREFERRED_REVISION)
        : { result: { tools: [{ name: 'read', inputSchema: schema }] } },
    );

    const outcome = await connectServer(stdioConfig, { transport });
    if (!outcome.ok) throw new Error(outcome.message);

    const tool = mcpTools(outcome.connection)[0];
    // Passed through rather than regenerated. A reconstruction of the contract is a
    // tool the model calls wrongly forever.
    expect(tool?.parameters).toEqual(schema);

    await outcome.connection.close();
  });

  it('rejects arguments missing a declared required property before the round trip', async () => {
    const transport = new ScriptedTransport((request) =>
      request.method === 'initialize'
        ? initializeResult(ADZE_PREFERRED_REVISION)
        : {
            result: {
              tools: [
                {
                  name: 'read',
                  inputSchema: { type: 'object', properties: {}, required: ['path'] },
                },
              ],
            },
          },
    );

    const outcome = await connectServer(stdioConfig, { transport });
    if (!outcome.ok) throw new Error(outcome.message);

    const tool = mcpTools(outcome.connection)[0];
    const prepared = tool?.prepare({});
    expect(prepared?.ok).toBe(false);
    if (prepared !== undefined && !prepared.ok) {
      expect(prepared.issues.join(' ')).toContain("missing required property 'path'");
    }

    await outcome.connection.close();
  });

  it('reports a tool error as a failed execution, not a throw', async () => {
    const transport = new ScriptedTransport((request) => {
      if (request.method === 'initialize') return initializeResult(ADZE_PREFERRED_REVISION);
      if (request.method === 'tools/list') {
        return { result: { tools: [{ name: 'boom', inputSchema: { type: 'object' } }] } };
      }
      return {
        result: { content: [{ type: 'text', text: 'the file was not found' }], isError: true },
      };
    });

    const outcome = await connectServer(stdioConfig, { transport });
    if (!outcome.ok) throw new Error(outcome.message);

    const result = await outcome.connection.callTool('boom', {}, undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('the file was not found');

    await outcome.connection.close();
  });
});

describe('protocol revision negotiation', () => {
  it('records an exact agreement on the preferred revision', async () => {
    const transport = new ScriptedTransport((request) =>
      request.method === 'initialize'
        ? initializeResult(ADZE_PREFERRED_REVISION)
        : { result: { tools: [] } },
    );

    const outcome = await connectServer(stdioConfig, { transport });
    if (!outcome.ok) throw new Error(outcome.message);

    expect(outcome.connection.agreedRevision).toBe(ADZE_PREFERRED_REVISION);
    await outcome.connection.close();
  });

  it('falls back to an older revision the server names', async () => {
    // The fallback the SDK actually implements: the server chooses, and a client that
    // can parse the choice accepts it. There is no downgrade-and-retry to test.
    const transport = new ScriptedTransport((request) =>
      request.method === 'initialize' ? initializeResult('2025-06-18') : { result: { tools: [] } },
    );

    const outcome = await connectServer(stdioConfig, { transport });
    if (!outcome.ok) throw new Error(outcome.message);

    expect(outcome.connection.agreedRevision).toBe('2025-06-18');
    expect(outcome.connection.alive).toBe(true);
    await outcome.connection.close();
  });

  it('refuses a revision it cannot parse, and closes rather than leaking the transport', async () => {
    const transport = new ScriptedTransport((request) =>
      request.method === 'initialize' ? initializeResult('2019-01-01') : { result: { tools: [] } },
    );

    const outcome = await connectServer(stdioConfig, { transport });
    expect(outcome.ok).toBe(false);
    // The transport is closed on the failure path. Without this a rejected handshake
    // leaves a running child nobody holds a reference to.
    expect(transport.closed).toBe(true);
  });
});

describe('robustness', () => {
  it('times out a handshake that never answers', async () => {
    const transport = new ScriptedTransport(() => undefined);

    const started = Date.now();
    const outcome = await connectServer({ ...stdioConfig, connectTimeoutMs: 150 }, { transport });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("could not connect to MCP server 'demo'");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(transport.closed).toBe(true);
  });

  it('times out a tool call that never answers', async () => {
    const transport = new ScriptedTransport((request) => {
      if (request.method === 'initialize') return initializeResult(ADZE_PREFERRED_REVISION);
      if (request.method === 'tools/list') {
        return { result: { tools: [{ name: 'slow', inputSchema: { type: 'object' } }] } };
      }
      return undefined; // never replies
    });

    const outcome = await connectServer({ ...stdioConfig, requestTimeoutMs: 150 }, { transport });
    if (!outcome.ok) throw new Error(outcome.message);

    const result = await outcome.connection.callTool('slow', {}, undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed to run 'slow'");

    await outcome.connection.close();
  });

  it('survives a crashed server and keeps other servers usable', async () => {
    const crashingTransport = new ScriptedTransport((request) =>
      request.method === 'initialize'
        ? initializeResult(ADZE_PREFERRED_REVISION)
        : { result: { tools: [{ name: 'a', inputSchema: { type: 'object' } }] } },
    );
    const healthy = linkedServer([{ name: 'echo', description: 'Echo', run: ({ text }) => text }]);
    await healthy.start();

    const crashing = await connectServer(
      { ...stdioConfig, name: 'crashy' },
      {
        transport: crashingTransport,
      },
    );
    const working = await connectServer(
      { ...stdioConfig, name: 'healthy' },
      {
        transport: healthy.clientTransport,
      },
    );
    if (!crashing.ok || !working.ok) throw new Error('setup failed');

    const host = new McpClientHost();
    host.adopt(crashing.connection);
    host.adopt(working.connection);
    expect(mcpToolsFor(host)).toHaveLength(2);

    crashingTransport.crash('server segfaulted');

    // The crash is observed, not discovered on the next request that never settles.
    expect(crashing.connection.alive).toBe(false);
    expect(crashing.connection.deathReason).toContain('server segfaulted');

    // A call against the dead server fails with an explanation instead of throwing.
    const dead = await crashing.connection.callTool('a', {}, undefined);
    expect(dead.ok).toBe(false);
    expect(dead.error).toContain('no longer running');

    // The healthy server is untouched, and the dead one is out of the catalog.
    expect(working.connection.alive).toBe(true);
    expect(mcpToolsFor(host).map((tool) => tool.name)).toEqual(['mcp__healthy__echo']);
    const alive = await working.connection.callTool('echo', { text: 'still here' }, undefined);
    expect(alive.ok).toBe(true);

    await host.close();
    await healthy.server.close();
  });

  it('records every misconfigured server rather than stopping at the first', async () => {
    // No transport override here on purpose: an override bypasses config construction,
    // which is exactly the code path being tested.
    const host = new McpClientHost();
    const outcomes = await host.connectAll([
      { name: 'no-command', transport: 'stdio' },
      { name: 'no-url', transport: 'http' },
    ]);

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([false, false]);
    // The loop reached the second config, which is the property that matters: one broken
    // entry in a config file must not cost the user every server after it.
    expect(host.connectFailures.map((failure) => failure.serverName)).toEqual([
      'no-command',
      'no-url',
    ]);
    expect(host.connectFailures[0]?.message).toContain('declares no command');
    expect(host.connectFailures[1]?.message).toContain('declares no url');
    expect(host.live).toHaveLength(0);

    await expect(host.close()).resolves.toBeUndefined();
  });

  it('serves a working server alongside a failed connection', async () => {
    const healthy = linkedServer([{ name: 'echo', description: 'Echo', run: ({ text }) => text }]);
    await healthy.start();

    const host = new McpClientHost();
    await host.connectAll([{ name: 'broken', transport: 'stdio' }]);

    const working = await connectServer(
      { ...stdioConfig, name: 'healthy' },
      { transport: healthy.clientTransport },
    );
    if (!working.ok) throw new Error(working.message);
    host.adopt(working.connection);

    expect(host.connectFailures).toHaveLength(1);
    expect(host.live).toHaveLength(1);
    expect(mcpToolsFor(host).map((tool) => tool.name)).toEqual(['mcp__healthy__echo']);

    await host.close();
    await healthy.server.close();
  });

  it('refuses an http server with no url, and one with an unparseable url', async () => {
    const noUrl = await connectServer({ name: 'h', transport: 'http' });
    expect(noUrl.ok).toBe(false);
    if (!noUrl.ok) expect(noUrl.message).toContain('declares no url');

    const badUrl = await connectServer({ name: 'h', transport: 'http', url: 'not a url' });
    expect(badUrl.ok).toBe(false);
    if (!badUrl.ok) expect(badUrl.message).toContain('unparseable url');
  });
});

describe('teardown', () => {
  it('closes every connection and empties the host', async () => {
    const first = new ScriptedTransport((request) =>
      request.method === 'initialize'
        ? initializeResult(ADZE_PREFERRED_REVISION)
        : { result: { tools: [] } },
    );
    const second = new ScriptedTransport((request) =>
      request.method === 'initialize'
        ? initializeResult(ADZE_PREFERRED_REVISION)
        : { result: { tools: [] } },
    );

    const host = new McpClientHost();
    for (const transport of [first, second]) {
      const outcome = await connectServer(stdioConfig, { transport });
      if (!outcome.ok) throw new Error(outcome.message);
      host.adopt(outcome.connection);
    }

    await host.close();

    expect(first.closed).toBe(true);
    expect(second.closed).toBe(true);
    expect(host.all).toHaveLength(0);
  });

  it('keeps closing after one connection refuses to close', async () => {
    // One bad close must not leave the rest running: that is the difference between a
    // clean exit and an orphaned subprocess holding the process open.
    const stubborn = new ScriptedTransport((request) =>
      request.method === 'initialize'
        ? initializeResult(ADZE_PREFERRED_REVISION)
        : { result: { tools: [] } },
    );
    stubborn.close = async () => {
      throw new Error('refusing to close');
    };
    const cooperative = new ScriptedTransport((request) =>
      request.method === 'initialize'
        ? initializeResult(ADZE_PREFERRED_REVISION)
        : { result: { tools: [] } },
    );

    const host = new McpClientHost();
    for (const transport of [stubborn, cooperative]) {
      const outcome = await connectServer(stdioConfig, { transport });
      if (!outcome.ok) throw new Error(outcome.message);
      host.adopt(outcome.connection);
    }

    await expect(host.close()).resolves.toBeUndefined();
    expect(cooperative.closed).toBe(true);
  });

  it('close is idempotent', async () => {
    const transport = new ScriptedTransport((request) =>
      request.method === 'initialize'
        ? initializeResult(ADZE_PREFERRED_REVISION)
        : { result: { tools: [] } },
    );
    const outcome = await connectServer(stdioConfig, { transport });
    if (!outcome.ok) throw new Error(outcome.message);

    await outcome.connection.close();
    await expect(outcome.connection.close()).resolves.toBeUndefined();
    expect(outcome.connection.alive).toBe(false);
  });
});
