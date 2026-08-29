/**
 * Test harness: two ways to stand up a server, both free.
 *
 * Nothing in this suite starts a subprocess, opens a socket, or costs money. That is
 * not only a speed choice — a test that spawns `npx` measures the network and the
 * registry, and it fails for reasons that have nothing to do with this package.
 *
 * **{@link linkedServer}** runs the SDK's real `McpServer` against the SDK's real
 * `Client` over `InMemoryTransport.createLinkedPair()`. Everything is genuine except
 * the wire: a real `initialize` handshake, real `tools/list`, real `tools/call`, real
 * schema validation on both ends. This is what proves the happy path actually works
 * rather than matching a mock we wrote to agree with us.
 *
 * **{@link ScriptedTransport}** answers JSON-RPC by hand. It exists for the states a
 * well-behaved server will not produce on demand: a handshake that names a revision
 * of our choosing, a request that never gets a reply, a process that dies mid-session,
 * a result far too large to return. Those are exactly the paths where the interesting
 * bugs live, and a compliant server cannot be asked to exhibit them.
 */

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { InnerTransport } from '../src/version.js';

/** A JSON-RPC request, once we know it is one. */
export interface ScriptedRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * What a scripted handler may do about a request.
 *
 * `undefined` means "say nothing at all", which is the only way to exercise a timeout
 * without waiting on a real network.
 */
export type ScriptedReply =
  | { readonly result: Record<string, unknown> }
  | { readonly error: { readonly code: number; readonly message: string } }
  | undefined;

export type ScriptedHandler = (request: ScriptedRequest) => ScriptedReply | Promise<ScriptedReply>;

/** A default `initialize` result, so each test only overrides what it cares about. */
export function initializeResult(
  protocolVersion: string,
  capabilities: Record<string, Record<string, unknown>> = { tools: {} },
): { readonly result: Record<string, unknown> } {
  return {
    result: {
      protocolVersion,
      capabilities,
      serverInfo: { name: 'scripted', version: '0.0.0' },
    },
  };
}

/**
 * A transport that fabricates the other end.
 *
 * Implements {@link InnerTransport} rather than the SDK's `Transport` for the reason
 * documented on that interface: the SDK's own transports are not assignable to the
 * SDK's `Transport` under `exactOptionalPropertyTypes`, so the wrapper accepts the
 * looser shape and this test double matches it.
 */
export class ScriptedTransport implements InnerTransport {
  onmessage?: InnerTransport['onmessage'];
  onerror?: InnerTransport['onerror'];
  onclose?: InnerTransport['onclose'];

  started = false;
  closed = false;
  /** Every method the client asked for, in order. Lets a test assert on discovery. */
  readonly seen: string[] = [];

  constructor(private readonly handler: ScriptedHandler) {}

  async start(): Promise<void> {
    this.started = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!('method' in message) || !('id' in message)) return; // a notification
    const request: ScriptedRequest = {
      id: message.id,
      method: message.method,
      params: (message.params ?? {}) as Record<string, unknown>,
    };
    this.seen.push(request.method);

    const reply = await this.handler(request);
    if (reply === undefined) return; // deliberate silence

    // Delivered on a later tick, like a real transport. Replying synchronously inside
    // `send` would let a bug that depends on the request being registered first pass here
    // and fail against a real server.
    setTimeout(() => {
      if (this.closed) return;
      this.onmessage?.(
        'result' in reply
          ? { jsonrpc: '2.0', id: request.id, result: reply.result }
          : { jsonrpc: '2.0', id: request.id, error: reply.error },
      );
    }, 0);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.onclose?.();
  }

  /** Simulate the server process dying underneath a live session. */
  crash(reason: string): void {
    this.onerror?.(new Error(reason));
    this.closed = true;
    this.onclose?.();
  }
}

export interface LinkedServerTool {
  readonly name: string;
  readonly description: string;
  readonly readOnly?: boolean;
  readonly run: (args: { readonly text: string }) => string;
}

/**
 * A real `McpServer` on one end of a real in-memory transport pair.
 *
 * Returns the client-side transport to hand to `connectServer`, plus the server so a
 * test can close it and observe the client noticing.
 */
export function linkedServer(tools: readonly LinkedServerTool[]): {
  readonly clientTransport: InMemoryTransport;
  readonly server: McpServer;
  readonly start: () => Promise<void>;
} {
  const server = new McpServer({ name: 'linked', version: '1.0.0' });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: { text: z.string() },
        ...(tool.readOnly === true ? { annotations: { readOnlyHint: true } } : {}),
      },
      ({ text }) => ({ content: [{ type: 'text' as const, text: tool.run({ text }) }] }),
    );
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  return {
    clientTransport,
    server,
    start: async () => {
      await server.connect(serverTransport);
    },
  };
}
