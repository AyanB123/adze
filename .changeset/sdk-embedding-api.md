---
'@adze/sdk': minor
---

Add the public embedding API, so a third party can build a surface on Adze.

`createClient()` configures providers, model selection, sandbox mode and approval
policy, budgets, extra tools, plugin hooks, retrieval, and the working directory, then
returns a client that reports the negotiated protocol version, the engine's real
capabilities, and the limitations in force. Sessions submit turns, cancel them, expose
typed `AdzeEvent` subscriptions at client or session scope, and report usage with the
input / cached-input / output split and the cache hit rate intact. `dispose()` closes
every session, cancels every turn in flight and waits for it to unwind, and drops every
listener.

Approvals arrive through an injected callback. The SDK never prompts, reads stdin, or
writes to a stream — deciding belongs to the surface, and a library that prompted would
be unusable from a GUI, a daemon, or CI. Anything that is not an explicit allow is a
denial, including a handler that throws, returns a malformed response, or answers a
different request. Under `approvals: 'never'` the callback is not consulted at all,
because that policy refuses rather than escalating. There is no way to bypass the
permission gate and no `trustEverything` flag.

No `@adze/core` type is reachable through the public API: everything a consumer can
name comes from this package or from `@adze/protocol`, which is what makes the
semver-strict-from-1.0 guarantee mean something. Four configuration seams —
`provider`, `tools`, `plugins`, `retrieval` — are consequently typed as opaque handles
validated at construction rather than by the compiler; README.md records which types
would have to move into `@adze/protocol` to close that gap.

`scriptedProvider()` is an offline model provider that plays a script with no network
call and no cost, so `examples/minimal-surface` and this package's own suite run on a
fresh clone with no API key. Swapping in `@adze/providers` is a one-line change.
