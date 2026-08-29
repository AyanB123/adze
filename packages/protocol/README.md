# @adze/protocol

The versioned wire contract between the Adze engine and every surface.

**Depends on nothing but `zod`.** A contract with dependencies is not a contract:
if this package imported the applier, every surface that reads a protocol type
would transitively depend on a specific applier implementation and the boundary
would be decorative.

## The rule this package exists to enforce

Surfaces reach the engine *only* through these messages
([ADR-0001](../../docs/architecture/adr/0001-engine-first-architecture.md), rule 2).

When the CLI can do something the extension cannot, **the protocol is missing a
message.** Add the message. Never add a private back channel. Every open-source AI
coding tool that died in the eighteen months before this project started was
single-surface, or became single-surface after its surfaces diverged into separate
products with separate bug surfaces. This rule is the thing standing between Adze
and that outcome.

## What is in here

| Area | Contents |
| --- | --- |
| Framing | JSON-RPC 2.0 requests, notifications, responses, and Adze error codes |
| Negotiation | `PROTOCOL_VERSION`, `negotiateProtocolVersion` |
| Messages | `initialize`, `session.create`/`close`, `turn.submit`/`cancel`, `approval.request`, `event` |
| Events | The streamed union: text deltas, tool lifecycle, edit proposed/applied/refused, todo, usage |
| Vocabulary | Sandbox modes, approval policies, attachments, tool calls and results, usage and cost |
| JSON Schema | `protocolJsonSchemas()`, plus committed documents in `src/generated/` |

```ts
import {
  METHOD,
  SUPPORTED_PROTOCOL_VERSIONS,
  jsonRpcRequest,
  negotiateProtocolVersion,
  parseParams,
} from '@adze/protocol';

const hello = jsonRpcRequest(1, METHOD.Initialize, {
  protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
  client: { name: 'my-surface', version: '1.0.0', platform: process.platform },
});

const parsed = parseParams(METHOD.Initialize, hello.params);
if (parsed.ok) {
  const agreed = negotiateProtocolVersion(parsed.value.protocolVersions);
  // { ok: true, version: '0.1' } | { ok: false, message: '…' }
}
```

## Three decisions worth knowing before you extend it

**Every object is closed.** An unknown key is rejected, not stripped. Stripping
would give free forward compatibility at the price of a surface silently
discarding a field the engine thought mattered — undiagnosable from the receiving
end. Rejecting is safe only because negotiation settles a single version before
anything else is sent. The cost we accept: adding a field is a minor-version
change.

**Cached input tokens are their own bucket, not a subset.** `inputTokens` counts
prompt tokens billed at the full rate and `cachedInputTokens` counts cache reads;
the prompt size is their sum. This shape makes the double-counting bug
unrepresentable rather than merely discouraged, and cache economics move effective
cost by more than 10×, so it is worth designing against. Build usage with
`makeUsage`.

**Cross-field invariants are predicates, not `.refine()`.** JSON Schema cannot
express them, and a Zod schema stricter than its published JSON Schema would make
the generated artifact a lie about what the wire accepts. See
`toolResultTruncationIsConsistent`.

## JSON Schema

The documents in `src/generated/` are committed, published in the package, and
importable as `@adze/protocol/schemas/InitializeParams.json`. They exist so a
consumer validating Adze messages from Python does not have to run our build.

```bash
pnpm --filter @adze/protocol build
pnpm --filter @adze/protocol schema:generate
```

`test/schema.test.ts` fails if they are stale, which is what makes committing them
safe.

## Stability

`0.x` carries no guarantee. Semver-strict from 0.2, per
[the architecture overview](../../docs/architecture/README.md#4-package-graph-and-dependency-rules).

Apache-2.0.
