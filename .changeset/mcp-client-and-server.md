---
'@adze/mcp': minor
---

Add the MCP client and server.

The client connects to configured MCP servers over **stdio** or **Streamable HTTP**,
discovers their tools, resources, and prompts, and surfaces the tools as Adze tool
descriptors ready for `EngineOptions.extraTools`. Thousands of MCP servers already
exist, so this is what makes them work as Adze tools without Adze inventing a tool
protocol. The standalone HTTP+SSE transport was removed from the specification and is
not implemented.

The server half exposes Adze over MCP so Claude Code, Codex, and anything else that
speaks the protocol can drive it. Tool implementations arrive by injection through
`AdzeToolImplementation`, because service packages do not import each other; a surface
does the wiring.

Every MCP tool call still passes the permission gate. A discovered tool becomes a
`RegisteredTool` whose `execute` requires a `Grant`, which only
`PermissionGate.authorize` can mint, so there is no path around the gate. stdio servers
declare a `command` effect and HTTP servers a `network` effect, which makes the existing
`commandRules` and `allowedNetworkHosts` policy hooks work for MCP with no new
machinery. An `autoApprove` list is honoured only when the server itself declares the
tool read-only; a config file asserting that a mutating tool is safe is reported and
ignored.

Servers are spawned with an argument array and never a shell string, so a server name or
argument containing shell metacharacters is inert. Tool results are truncated with an
explicit marker and the full text retained as a continuation, because unbounded output
from a third-party program is a context-window denial-of-service. Credentials supplied
through `env` or `headers` never appear in a log, a tool descriptor, an error message, or
a trajectory artifact.

Protocol revision handling targets `2025-11-25`, which is the newest revision
`@modelcontextprotocol/sdk@1.30.0` knows, and accepts the older revisions the SDK can
parse when a server names one. The preferred revision is derived from the SDK rather
than hard-coded, so what Adze advertises cannot drift from the schemas it parses with.
