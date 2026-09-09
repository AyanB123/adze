# WIP Guard

Keeps temporary work out of the shared history.

Denied: commit messages containing `WIP`, `fixup!`, `squash!`, `TMP`, `DO NOT COMMIT`,
or `DO NOT MERGE`, and pushes straight to `main` or `master`. Work lands through a
feature branch and a review.

Intentionally disjoint from `adze.commit-conventions`, which owns the message format,
the DCO sign-off, and history rewrites. Each refusal names exactly one policy.

The hook registers `tool.pre` with a host-side `tools: ["bash"]` filter. The module is
a `.mjs` dev module: `runtime: "js"` runs unsandboxed and needs `allowUnsandboxedJs`.
A published build would compile to `wasm32-wasip2`.
