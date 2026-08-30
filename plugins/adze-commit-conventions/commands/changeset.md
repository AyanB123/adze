---
name: changeset
description: Decide whether the staged change needs a changeset, and write it if so
tools: [read, grep, bash]
---

Decide whether this change needs a changeset, then write it.

What is staged:

!`git --no-pager diff --cached --stat`

A changeset is required for anything **user-visible**: a protocol change, a CLI flag, tool
behaviour, a public exported type, or a default that changes. It is not required for an
internal refactor or a test-only change.

Apply that test to the staged files specifically:

- Did anything in a package's `src/index.ts` — its public surface — change shape?
- Did a default value, an error message a user reads, or a command's output change?
- Did a `zod` schema in `@adze/protocol` change? That is always user-visible, because
  every surface parses against it.

If none of those hold, say so and stop. A changeset for an internal refactor adds a
release note that tells a reader nothing and trains them to skip the changelog.

If one holds, tell me the bump for each affected package and draft the note:

- **patch** — a fix with no API change.
- **minor** — new capability, backwards compatible.
- **major** — a breaking change. Say what breaks and what a caller does about it.

Write the note for someone upgrading who did not read the PR. One or two sentences, what
changed and what they need to do. Then show me:

```
pnpm changeset
```

with the answers to type into it. Do not run it — the interactive prompt writes a file
whose name is a random word pair, and choosing that unattended makes the changeset hard to
find and review.
