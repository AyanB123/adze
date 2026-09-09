---
name: rollback-plan
description: Draft the fastest way back from the staged change going wrong
tools: [read, grep, bash]
model: { prefer: reasoning }
---

Draft the rollback plan for the change that is staged. Do not execute any step of it:
a rollback touches live state, and every step below needs a human to run it.

What is staged:

!`git --no-pager diff --cached --stat`

The change itself:

!`git --no-pager diff --cached`

Recent history, so the previous release is identified exactly:

!`git --no-pager log --format=%h\ %s -5`

Write the plan as numbered steps a human can run in order, with the exact command for
each step. Distinguish the three cases and say which one applies:

- **Redeploy the previous release** — the change is stateless. Name the release or commit
  to redeploy.
- **Run the down migration first** — the change migrated stored state. Name the migration
  and confirm the down path has been tested. If it has not, say so plainly rather than
  assuming it works.
- **Revert the commit** — the change has not been released yet. Name the commit to revert.

For each step, say how the human confirms it worked before moving to the next one. End
with what to watch after the rollback: which log, metric, or health check proves the
system is back. Report, and stop. Do not run anything destructive.
