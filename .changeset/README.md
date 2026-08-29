# Changesets

A changeset is a short note saying which packages a change affects, how the
version should move, and what to tell users. `changeset version` turns the
accumulated notes into version bumps and changelog entries.

```bash
pnpm changeset
```

## When one is needed

Anything user-visible: a protocol change, a CLI flag, tool behaviour, a public
type, a bug fix someone would notice. Internal refactors and test-only changes do
not need one.

The rule and the reasoning are in
[CONTRIBUTING.md](../CONTRIBUTING.md#commit-messages).

## Which bump

Adze is pre-1.0, so `major` is reserved and `minor` is the effective breaking
bump. `@adze/protocol` becomes semver-strict at 0.2 and `@adze/core` at 1.0 — see
[the package table](../docs/architecture/README.md#4-package-graph-and-dependency-rules).
Until a package reaches its stability point, prefer `patch` for fixes and `minor`
for anything that changes a signature.

`@adze/bench-harness` is private and is never published. Benchmark code must not
influence what ships, and not publishing it is part of that.

## Writing the summary

It is release notes, not a commit message. Say what changed for someone using the
package, in one or two sentences. The commit body is where the reasoning goes.
