---
name: split-commit
description: Split the staged change into narrow commits with one concern each
tools: [read, grep, bash]
model: { prefer: reasoning }
---

Split the staged change into narrow commits. Stage nothing new and unstage nothing
yourself: what is staged is the author's decision, and your job is to propose the split,
not to apply it.

What is staged:

!`git --no-pager diff --cached --stat`

The change itself:

!`git --no-pager diff --cached`

Propose the split as a sequence of commits, each one reviewable on its own and
revertable on its own:

- Group by concern: a behaviour change, a refactor, a test-only change, and a docs
  change are four commits, never one. Do not bundle a refactor into a behaviour change.
- For each commit, give the paths, the Conventional Commit subject in the imperative,
  lowercase, no trailing period, and one sentence on why the change is correct.
- If a group is empty — no tests, no docs — say so rather than inventing one.
- Never propose `--amend` or a force-push to split what is already under review. Push a
  follow-up commit instead, so a reviewer's view of a branch never changes underneath
  them.

Show the exact `git reset -p` and `git commit -s -F <file>` steps to produce the split,
with the message written to a file first: on Windows, PowerShell mis-parses a message
containing backticks or `${`. Do not run the split yourself. Print it for the author to
run: the sign-off is a Developer Certificate of Origin assertion and is not yours to
make.
