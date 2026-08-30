---
'@adze/plugin-sdk': minor
---

Add the plugin manifest, the loader, and the six extension surfaces.

A plugin is a directory containing `adze.plugin.json`. Tool contributions, context
providers, slash commands, and subagents are declaration, so the failure mode of a bad
plugin is a load-time diagnostic rather than a crash mid-turn. Hooks are the exception,
because a policy that cannot run code cannot express policy.

**Hooks can veto, and the veto lands on `@adze/core`'s real dispatch path with no change
to core.** `HookBus` already accepted a `RegisteredHook`, and `dispatchToolCall` — the
only place in the engine that calls a tool's `execute` — already fired `tool.pre` before
consulting the permission gate, so this package supplies an adapter rather than a new
seam. A `tool.pre` or `edit.pre` denial stops the call at the same point a gate refusal
would, and the tool body never runs. A rewrite from a hook goes back through the tool's
schema, because a plugin gets no more trust than the model.

A hook that times out is treated as `allow` and logged loudly, which is the opposite of
core's own bus: failing closed on a slow hook would let one plugin with a network call
deny every tool call in the session, and the symptom would look like an engine fault
rather than a plugin fault. An operator who prefers failing closed opts in explicitly.

`edit.pre` and `edit.post` are derived from `tool.pre` and `tool.post` because core's
edit tool applies and writes inside one `execute` with no interior hook point. The
consequence is reported rather than hidden: an `edit.pre` hook sees the edit the model
proposed, not the applier's resolved match locations, and `edit.post` cannot report
which tier applied it. `context.pre` and `session.compact` have no seam in core and do
not fire.

Subagents narrow and cannot widen. The requested tool allowlist is intersected with the
parent's, a requested tool the parent lacks is an error rather than a silent omission, a
step ceiling can only be lowered, and a subagent with no allowlist is refused rather than
inheriting everything.

The engine refuses UI contributions and throws if offered one, per ADR-0001. A manifest
may still declare UI: the contribution is parsed, dropped engine-side with a recorded
reason, and offered to whichever surface asks, so a plugin with a status-bar item does
not lose its policy hook.

Invisible-Unicode and bidi-control scanning is a load failure rather than a warning, and
runs on manifest bytes before JSON parsing as well as on every module and markdown file.
`engines.adze` is checked at load, and an incompatible range is refused with both the
range and the running engine version named.

**`wasm32-wasip2` is not implemented.** A plugin whose hook is a `.wasm` module fails to
load rather than loading without it, because a policy hook that silently does not run
leaves a team believing their rule is enforced. Running JavaScript instead requires a
host-supplied runtime and an explicit opt-in, since a `.mjs` hook is not sandboxed.

No surface consumes this package yet and there is no `adze plugin add` command; wiring
belongs in a surface. `packages/plugin-sdk/README.md` lists nine places where
`docs/plugins/spec.md` turns out to be wrong, ambiguous, or impossible.
