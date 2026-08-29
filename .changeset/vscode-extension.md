---
'adze-vscode': minor
---

Add the Adze VS Code extension: chat sidebar, inline edit review, ghost text, and an
approval gate.

The engine runs in-process in the extension host, so there is no transport and no
sidecar. A chat webview in the primary sidebar streams the engine's event stream under a
strict CSP (`default-src 'none'`, no `connect-src`, nonce-loaded scripts, no remote
content). Applied edits are highlighted in the editor with their tier, match strategy,
and validator level on hover; `Adze: Revert Edits in This File` computes the inverse edit
and refuses rather than guessing when the inverse is not derivable. Ghost text is
available through `InlineCompletionItemProvider` and is **off by default**, because the
protocol has no cheap-completion message and each suggestion costs a full turn. The
status bar reports the model, the input/cached/output token split, the cache hit rate,
and cost — reported as `unknown` for an unpriced model, never as `$0.00`.

Approval requests appear as a modal with four decisions; dismissing it is a denial.
`adze.approvals.policy: never` refuses rather than escalating. An unrecognised value for
`adze.sandbox.mode` or `adze.approvals.policy` narrows to the most restrictive option
instead of falling back to the default, and any invalid setting blocks the run with a
message naming the key. With no API key configured, the first prompt names the exact
environment variable to set.

No telemetry and no network calls beyond the model provider you configure. Activation is
lazy, so an installed extension costs nothing at startup.
