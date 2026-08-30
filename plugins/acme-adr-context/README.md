# ADR Context

A **purely declarative** plugin. It contains no executable code at all — three
markdown-and-JSON files and nothing to compile, which is the path ADR-0008 wants most
plugins to take.

| File | Surface |
| --- | --- |
| `adze.plugin.json` | the manifest, and the whole requirement for being a plugin |
| `commands/review.md` | surface 3, a slash command |
| `agents/security.md` | surface 5, a subagent |
| the `contextProviders` block | surface 2, a glob provider on `@adr` |

It is also a fixture: `packages/plugin-sdk/test/fixtures.test.ts` loads this directory
from disk, so the example cannot drift away from what the loader accepts.

## What writing it found

Three things, all recorded in `packages/plugin-sdk/README.md` under the spec review.

**`/review` cannot run without a host that supplies a command runner.** The template
inlines `` !`git diff --cached` ``, and `@adze/plugin-sdk` has no way to spawn a
process — by design, so that the permission gate cannot be bypassed. Interpolation is
*refused* rather than expanded with the diff missing, because a prompt that says
"review the staged diff" followed by nothing gets a confident report about nothing.

**`@adr` resolves against the workspace, not the plugin.** The provider's patterns
point at `docs/architecture/adr/**/*.md`, which are files in the *user's* repository.
A plugin shipping its own reference documents would need patterns relative to the
plugin directory, and the spec does not distinguish the two roots.

**`engines.adze` in the spec's own example would refuse to load.** The spec shows
`">=0.4.0 <2.0.0"`; the engine is at `0.0.1`, so that range is unsatisfied and a
plugin copying the example verbatim gets a compatibility error. This manifest uses
`">=0.0.1 <1.0.0"`.
