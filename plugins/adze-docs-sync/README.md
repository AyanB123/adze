# Docs Sync

**Finds public API changes and status claims that documentation has not caught up with, in both
directions.**

Surfaces used: **slash commands** (`/docs-sync`), **subagents** (`docs-auditor`).

## What it does

`/docs-sync` reads the staged diff, decides whether the change is documentation-visible, and
delegates to `docs-auditor` — a read-only subagent that compares documents against code.

Both check **both directions**, and the second one is the point:

- **Overstated** — a document claims a capability the code does not have. This is the case
  everyone looks for.
- **Understated** — a document says something does not exist and it now does. This is the case
  that gets missed, and it is arguably worse. When a package lands, every status row that
  listed it among the unbuilt ones becomes false, and the authoritative status document stops
  being authoritative: the next reader cannot tell which rows they can still trust.

## This plugin is not the plugin this repository wants

The useful version is automatic. It notices that a public API file changed and reminds the
model to update the documentation, with nobody typing a command.

**That is not expressible with the extension points as specified**, and the reason is worth
reading because it is the clearest gap this set of plugins found.

The reminder has to reach the model. The event that knows an edit happened is `edit.post`, and
the spec's table gives it a `May return` column of "—". The SDK implements exactly that:
`fireNotification` invokes the hook and discards whatever it returns. No post-event has an
output shape that reaches the model. `inject` exists, but only `session.start`,
`session.turnStart`, `context.pre`, and `session.compact` honour it, and all four fire *before*
the edit that would trigger the reminder.

Every workaround is wrong in a specific way:

| Workaround | Why it is wrong |
| --- | --- |
| `session.turnStart` `inject` | fires before the edit, so it cannot know about it |
| `edit.pre` `deny` | blocks the edit rather than annotating it — turns a reminder into a refusal |
| `tool.post` `replace` on the edit tool | rewrites the tool result the model is reading, which means lying to the model about what the tool said in order to append a note |

So this shipped as a command and a subagent. Both work, and neither is automatic.

The suggested fix, recorded in [FINDINGS.md](../FINDINGS.md#4-editpost-cannot-inject-anything-which-rules-out-a-whole-class-of-plugin):
let `edit.post` and `session.turnEnd` return `inject`. A post-event that can add context but
cannot veto is not a permission boundary, so it does not reintroduce the fail-open versus
fail-closed argument that governs the `pre` events.

## Zero executable code

A manifest, one command, one subagent. Nothing to compile and nothing to sandbox.

## Installing

```bash
adze plugin dev ./plugins/adze-docs-sync
```

## Tests

`plugins/test/declarative.test.ts` loads the plugin and asserts the subagent's allowlist
excludes every writing tool — an auditor that could edit the documents it audits could report
a clean result it had produced itself.
