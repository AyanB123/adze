# @adze/mcp

MCP client and server for Adze. Extension surface 1 of 6 in
[ADR-0008](../../docs/architecture/adr/0008-plugin-architecture.md), and the only one
built on a settled external standard.

Adze is deliberately on **both** ends of MCP.

## Client — every existing MCP server becomes an Adze tool

Thousands of MCP servers already exist. Consuming them is worth more than any tool we
could write, which is why Adze has no tool protocol of its own.

```ts
import { McpClientHost, mcpToolsFor } from '@adze/mcp';

const host = new McpClientHost();
await host.connectAll([
  {
    name: 'github',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? '' },
    autoApprove: ['search_repositories'],
  },
]);

// Hand straight to the engine.
const engine = new Engine({ ...rest, extraTools: mcpToolsFor(host) });

// One thing to close. Closing the host stops every subprocess.
await host.close();
```

**Transports: stdio and Streamable HTTP only.** The standalone HTTP+SSE transport was
removed from the specification and is not offered. SSE survives only as a
request-scoped response stream inside Streamable HTTP, which the transport handles
internally.

### What the installed SDK actually does

Verified against `@modelcontextprotocol/sdk@1.30.0` rather than assumed:

| Claim | Reality in 1.30.0 |
| --- | --- |
| Newest protocol revision | `2025-11-25`. There is no `2026-07-28`. |
| Fallback ladder | `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07` |
| Where negotiation happens | the `initialize` handshake, server-chosen |
| `_meta` key `io.modelcontextprotocol/protocolVersion` | does not exist |
| `server/discover` RPC | does not exist; discovery is the three list calls |
| `MCP-Protocol-Version` header | real, set by the transport from the agreed revision |

`ADZE_PREFERRED_REVISION` is derived from the SDK rather than written down, so the
revision Adze advertises cannot drift away from the schemas it parses with.

### Robustness

- **Connection timeouts**, and a failed handshake closes its transport before
  returning — otherwise a server that started but never answered `initialize` is an
  orphan that keeps the process alive.
- **A crashed server cannot take down the engine.** Liveness is observed from the
  client's own hooks; a call against a dead connection returns a failed result naming
  the cause, and every other server keeps working.
- **Results are bounded with an explicit marker** and the full text is retained as a
  continuation, so the cut is recoverable rather than silent data loss.
- **Teardown leaves nothing running.** One connection refusing to close does not stop
  the rest.

### Security

- **An argument array, never a shell string.** `command` and `args` stay separate
  fields all the way into `spawn`, which the SDK calls with `shell: false`. A server
  name or argument containing `;`, `&&`, `$(...)`, or a backtick is one literal argv
  element and is never parsed.
- **Every call still passes the permission gate.** A discovered tool is a
  `RegisteredTool` whose `execute` requires a `Grant`, and only
  `PermissionGate.authorize` can mint one. There is no path around it to write here.
  stdio servers declare a `command` effect and HTTP servers a `network` effect.
- **`autoApprove` is advice, not a bypass.** It is honoured only when the *server*
  declares the tool read-only. A config file claiming a mutating tool is safe is
  reported and ignored.
- **Credentials never appear** in a log, a descriptor, a tool argument, or a
  trajectory artifact. Environment blocks are described by key name only.

## Server — Adze drivable by other agents

Claude Code, Codex, and anything else that speaks MCP can drive Adze's capabilities.

Tools arrive by **injection**, because service packages do not import each other:
`@adze/mcp` cannot reach into `@adze/apply` or `@adze/retrieval` to find something to
expose.

```ts
import { AdzeMcpServer } from '@adze/mcp';

const server = new AdzeMcpServer({
  tools: [
    {
      name: 'edit',
      description: 'Apply a search/replace edit to a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      invoke: async (args, signal) => ({ ok: true, text: '…' }),
    },
  ],
});
await server.connect(new StdioServerTransport());
```

**Where the wiring belongs: a surface.** `packages/cli` already depends on
`@adze/core` and is the layer permitted to know about every service package at once.
An `adze mcp serve` command builds the engine the way `src/agent/setup.ts` does, adapts
the engine's `RegisteredTool`s to `AdzeToolImplementation`, and routes each incoming
call through `dispatchToolCall` so the permission gate stays in the path.

## Status

The client and server halves both work and are covered end to end. What is **not**
here: the config file format and its loader, the `adze mcp serve` command, and OAuth
for authenticated HTTP servers. See [docs/roadmap.md](../../docs/roadmap.md).

## Tests

No network, no subprocesses, no cost. The happy paths run against the SDK's real
`McpServer` and `Client` over `InMemoryTransport`; the failure paths use a scripted
transport, because a compliant server will not hang, crash, or name an arbitrary
protocol revision on request.

```
node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node ../../node_modules/vitest/vitest.mjs run
node ../../node_modules/typescript/bin/tsc -p tsconfig.build.json
node ../../node_modules/@biomejs/biome/bin/biome check .
```
