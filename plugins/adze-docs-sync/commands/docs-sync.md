---
name: docs-sync
description: Check whether the staged change leaves documentation stating something untrue
tools: [read, grep, glob, symbols, bash, task]
model: { prefer: reasoning }
---

Check whether this change leaves any documentation stating something untrue.

What is staged:

!`git --no-pager diff --cached --stat`

The change:

!`git --no-pager diff --cached`

## First, decide whether this change is documentation-visible at all

It is, if any of the following changed:

- a package's `src/index.ts` — its public surface;
- an exported type, a function signature, or a default value;
- a `zod` schema in `@adze/protocol`, which every surface parses against;
- a CLI flag, a command's output, or an error message a user reads;
- **whether a package has code at all**, which invalidates every status row that said it did
  not.

If none of those changed, say so and stop. Manufacturing a documentation task for an internal
refactor trains the reader to ignore this check.

## Then delegate the audit

Run the `docs-auditor` subagent. It is read-only by construction — `read`, `grep`, `glob`,
`symbols` — which is what makes its findings trustworthy: it cannot have quietly fixed
something and then reported it as fine.

Check @invariants for what the architecture documents currently claim.

## Report

List each document that is now wrong, quoting what it says and what the code now does, and say
which one should change.

Check **both directions**, and say so explicitly even when one side is empty:

- **Overstated** — the document claims a capability the code does not have. The obvious case.
- **Understated** — the document says something does not exist and it now does. The case that
  gets missed, and the one that quietly destroys the value of a status document: a reader who
  finds one stale row cannot tell which of the others to trust.

Do not edit the documents. Report, and I will decide what changes.

## Why this is a command rather than automatic

It should not be. The plugin this repository actually wants is one that notices a public API
file changed and reminds the model to update the docs, without anyone typing a command.

That is not expressible today. `edit.post` is notify-only — the SDK invokes the hook and
discards whatever it returns — and no post-event has an output shape that reaches the model.
`inject` exists but is honoured only on `session.start`, `session.turnStart`, `context.pre`, and
`session.compact`, all of which fire *before* the edit that would trigger the reminder. So the
automatic version would have to either deny the edit, turning a reminder into a refusal, or
rewrite the edit tool's own result text, which means lying to the model about what the tool
said in order to append a note.

Recorded as finding 4 in `plugins/FINDINGS.md`.
