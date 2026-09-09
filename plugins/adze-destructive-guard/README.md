# Destructive Guard

Refuses shell commands that are hard to undo, before they run.

Denied: recursive deletes aimed at broad roots (`rm -rf /`, `~`, `.`), `git reset
--hard` and `git clean -fdx`, database drops and unscoped deletes, `kubectl delete
--all` or against a namespace, raw disk writes, and fork bombs. Each denial names the
safe alternative.

Not denied: anything reversible, anything scoped to one file, and anything the hook is
unsure about. Where it is unsure it allows and a human decides.

The hook registers `tool.pre` with a host-side `tools: ["bash"]` filter, so the guest
is never entered for calls it would ignore. The module is a `.mjs` dev module:
`runtime: "js"` runs unsandboxed in the Adze process and needs `allowUnsandboxedJs`.
A published build would compile the same policy to `wasm32-wasip2`.
