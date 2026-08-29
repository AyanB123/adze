/**
 * The MCP server: making Adze drivable by other agents.
 *
 * Cheap to build and immediately useful to people who have no intention of switching
 * tools — Claude Code, Codex, or anything else that speaks MCP can drive Adze's
 * capabilities without adopting Adze's surfaces.
 *
 * ## Why the tools are injected
 *
 * Service packages do not import each other. `@adze/apply` and `@adze/retrieval` are
 * siblings of this package, and reaching into them to find something to expose would
 * couple three independently swappable packages into one. So this module declares
 * {@link AdzeToolImplementation} and exposes whatever it is handed.
 *
 * **Where the wiring belongs: a surface.** `packages/cli` already depends on
 * `@adze/core`, and a surface is the layer permitted to know about every service
 * package at once. Concretely, an `adze mcp serve` command constructs the engine the
 * same way `src/agent/setup.ts` does, adapts the engine's `RegisteredTool`s to
 * {@link AdzeToolImplementation}, and connects a `StdioServerTransport`. That
 * adapter is the natural place for the permission gate to stay in the path, because
 * it holds the engine and can route each incoming MCP call through
 * `dispatchToolCall` rather than around it.
 *
 * ## Why the low-level `Server` and not `McpServer`
 *
 * `McpServer.registerTool` takes a Zod raw shape and derives the advertised JSON
 * Schema from it. Injected tools arrive carrying JSON Schema already, and converting
 * it into Zod so the SDK can convert it back would advertise a reconstruction of the
 * contract instead of the contract. The low-level `Server` lets `tools/list` return
 * the schema untouched.
 */

import type { JsonObject } from '@adze/protocol';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, Implementation, Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AdzeToolImplementation } from './types.js';

const DEFAULT_SERVER_INFO: Implementation = { name: 'adze', version: '0.0.1' };

const DEFAULT_INSTRUCTIONS =
  'Adze exposes its coding tools over MCP. Every call is subject to the same ' +
  'permission gate and approval policy as a local Adze session, so a call may be ' +
  'refused; a refusal is a decision, not a failure to retry around.';

export interface AdzeMcpServerOptions {
  readonly tools: readonly AdzeToolImplementation[];
  readonly info?: Implementation;
  readonly instructions?: string;
}

/**
 * Adze, as an MCP server.
 *
 * One instance serves one transport. That matches the SDK's model and keeps session
 * state — which tools were advertised, which calls are in flight — attached to the
 * peer it belongs to.
 */
export class AdzeMcpServer {
  private readonly server: Server;
  private readonly tools: Map<string, AdzeToolImplementation>;

  constructor(options: AdzeMcpServerOptions) {
    this.tools = new Map();
    for (const tool of options.tools) {
      // Throwing mirrors `ToolRegistry.register`. Two tools with one name means the
      // peer's choice silently resolves to whichever was registered last, and the
      // peer has no way to discover that it did.
      if (this.tools.has(tool.name)) {
        throw new Error(`tool '${tool.name}' is already registered on the MCP server`);
      }
      this.tools.set(tool.name, tool);
    }

    this.server = new Server(options.info ?? DEFAULT_SERVER_INFO, {
      capabilities: { tools: {} },
      instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
    });

    this.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.advertise() }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      return await this.invoke(request.params.name, request.params.arguments, extra.signal);
    });
  }

  /**
   * The tool list, sorted by name.
   *
   * Sorted for the same reason `ToolRegistry.catalog` is: the list is part of what a
   * peer caches on, and `Map` iteration order is stable in practice without being
   * guaranteed by anything a reader can check.
   */
  private advertise(): Tool[] {
    return [...this.tools.values()]
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Tool['inputSchema'],
        ...(tool.readOnly === true ? { annotations: { readOnlyHint: true } } : {}),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * Run one tool for the peer.
   *
   * Every failure comes back as a result with `isError: true` rather than a JSON-RPC
   * error, which is what the specification asks for: a tool that failed is an outcome
   * the calling *model* should see and adapt to, whereas a protocol error is addressed
   * to the calling *program* and is usually retried or logged rather than reasoned
   * about. An unknown tool is the one case where the useful reply is the list of names
   * that do exist.
   */
  private async invoke(
    name: string,
    args: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return errorResult(
        `unknown tool '${name}'. Available tools: ${[...this.tools.keys()].sort().join(', ')}.`,
      );
    }

    try {
      const outcome = await tool.invoke((args ?? {}) as JsonObject, signal);
      return {
        content: [{ type: 'text', text: outcome.text }],
        ...(outcome.ok ? {} : { isError: true }),
      };
    } catch (error) {
      // A throwing implementation is a bug in the injected tool, not a reason to drop
      // the peer's connection. Reporting it as a tool error keeps the session usable.
      return errorResult(
        `'${name}' failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Serve one peer over `transport`. */
  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  /** Stop serving. Non-throwing, so a shutdown path can close several things in turn. */
  async close(): Promise<void> {
    try {
      await this.server.close();
    } catch {
      // Already closed, or the transport objected on the way out. Nothing further to do.
    }
  }

  /** Names currently advertised. For a surface's diagnostics and for tests. */
  get toolNames(): readonly string[] {
    return [...this.tools.keys()].sort();
  }
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
