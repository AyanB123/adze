# Review

**Read-only subagents that audit a diff and report findings by severity, and a command that
runs the audit against staged changes.**

Surfaces used: **subagents** (three), **slash commands** (`/review-diff`), **UI** (one
contribution, which the engine refuses — see below).

## What it does

| Subagent | Audits | Allowlist |
| --- | --- | --- |
| `code-review` | a diff against the architecture rules, honesty rules, error handling, missing tests, and whether an ADR is required | `read`, `grep`, `glob`, `symbols` |
| `apply-forensics` | an edit-application failure, and specifies the regression case that must exist afterwards | `read`, `grep`, `symbols` |
| `bench-claims` | a benchmark report against `docs/benchmarks/strategy.md` before it can be cited | `read`, `grep`, `glob` |

`/review-diff` reads the staged diff and delegates to `code-review`.

## Why the allowlists are the point

Every subagent here excludes `bash`, `write`, `edit`, and `task`. That is not a convention
this plugin follows — it is enforced by the SDK in a way that cannot be worked around, and
this plugin exists partly to demonstrate it.

`narrowSubagent` in `@adze/plugin-sdk` takes the parent session's grant as an argument and
can only return something equal to or smaller than it. Tools narrow by set intersection.
Permissions intersect on a lattice: `filesystem` is ordered `none < read < workspace-write`,
so a subagent asking for `workspace-write` under a `read` parent is **clamped to `read` and
told** rather than refused, because it still has a useful job to do with less. A tool name
the parent does not have is an error rather than a silent omission, because a subagent
quietly missing the tool it was told to use fails in a way that looks like model
incompetence.

There is deliberately no code path that widens, and `plugins/test/review.test.ts` asserts the
property from the widening direction: it hands `code-review` a parent grant with `write` and
`bash` available and `filesystem: workspace-write`, and checks the subagent still comes back
with neither and with `read`.

A reviewer that cannot write is the only kind whose findings you can trust not to have been
quietly fixed mid-review.

## The `permissions:` block in front matter

Each agent declares `permissions: { filesystem: read }`. It is honoured, and it used not to
be — this was hardcoded to `undefined` in an earlier version of the SDK, which meant an
author writing that line got the parent's level instead and nothing said so.

Only `filesystem` can be narrowed there, and the reason is a real limit of the front-matter
grammar rather than a choice: an inline mapping's values are scalars, and `network` and `env`
are lists, so `permissions: { network: [a, b] }` would parse the value as the *string*
`'[a, b]'`. That is rejected with the reason named rather than accepted and dropped. Narrow
those in the manifest, which is JSON.

## The UI contribution the engine refuses

The manifest contributes one `tree-view` for the `vscode` surface. **The engine drops it and
records why**, which is exactly the intended behaviour and the reason it is here.

ADR-0001 rule 3 and ADR-0008 both state that plugins may not inject UI into the engine. If
they could, the CLI, the extension, and the IDE would each have to render whatever a plugin
sent, each would render it differently, and the three surfaces would begin diverging into
three products with three bug surfaces. So `partitionUi` splits UI contributions out at load,
`assertNoEngineUi` throws if anything tries to hand one to the engine anyway, and the
contribution is available to the named surface only.

The refusal is recorded as a **notice**, not an error: the plugin loads and its subagents and
command work. Making it fatal would mean an author who added a status-bar item discovered it
by losing their subagents.

`plugins/test/review.test.ts` asserts all three halves of this: the contribution survives
into `plugin.ui` for the surface, a `ui-refused-by-engine` notice is recorded, and
`assertNoEngineUi` throws when handed it.

## Zero executable code

Three subagents, one slash command, one UI declaration, no build step. The `tools` and
`permissions` in each agent's front matter are the entire security surface, and they are
readable by someone who does not program — which is the case ADR-0008 makes for declarative
plugins and the reason surfaces 3 and 5 need no sandbox.

## Command name

`/review-diff`, not `/review`. The spec's own example fixture at
`plugins/acme-adr-context` contributes a command called `review`, and nothing in the SDK
detects a collision between command names across plugins — both would load, with no
diagnostic, and which one `/review` invoked would depend on load order. See
[FINDINGS.md](../FINDINGS.md#5-only-context-provider-triggers-are-checked-for-collisions).

## Installing

```bash
adze plugin dev ./plugins/adze-review
```

No flags: nothing here is procedural.

## Tests

`plugins/test/review.test.ts` loads the plugin, asserts each agent's allowlist excludes the
writing tools, drives `narrowSubagent` from the widening direction, and covers the UI
refusal.
