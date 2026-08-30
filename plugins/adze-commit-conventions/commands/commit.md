---
name: commit
description: Stage nothing new, then write a Conventional Commit message with a DCO sign-off
tools: [read, grep, bash]
model: { prefer: reasoning }
---

Write the commit for the work that is already staged. Do not stage anything yourself:
what is staged is the author's decision about what belongs in this commit, and widening
it is how a refactor ends up bundled into a behaviour change.

Here is what is staged:

!`git --no-pager diff --cached --stat`

And the change itself:

!`git --no-pager diff --cached`

Recent commits, for the message style this repository actually uses — match it rather
than a generic Conventional Commits template:

!`git --no-pager log --format=%B -3`

Write the message as:

```
<type>(<scope>): <summary in the imperative, lowercase, no trailing period>

<body: why this change is correct. The diff already says what changed.>

Refs ADR-00NN.
```

Types: `feat`, `fix`, `docs`, `perf`, `test`, `refactor`, `build`, `ci`, `chore`,
`revert`. Scopes are package directory names plus `protocol`, `docs`, `adr`, `ci`, `deps`.

Rules for the body, which is the part that carries the value:

- Explain **why the change is correct**, not what it does.
- If you found a bug while writing tests, spend a paragraph on it. That paragraph is the
  only place the reasoning survives — the diff cannot express it and the issue tracker
  will not remember it.
- If the change follows an existing decision record, reference it (`Refs ADR-0008.`). If
  it reverses one, say so and note that a reversal needs its own ADR superseding the old
  one.
- Do not claim a capability works if it is scaffolded. Name the roadmap milestone instead.

Then show me the exact command to run, using `-s`:

```
git commit -s -F <path-to-message-file>
```

On Windows, write the message to a file first. PowerShell mis-parses a message containing
backticks or `${`, and the failure is a partially-applied commit rather than an error.

Do not run the commit yourself. Print it for me to run: the sign-off is a Developer
Certificate of Origin assertion that the author has the right to submit the code, and it
is not yours to make.
