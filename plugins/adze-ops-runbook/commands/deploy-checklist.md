---
name: deploy-checklist
description: Walk through the pre-deploy checks for this change and confirm each one
tools: [read, grep, glob, bash]
model: { prefer: reasoning }
---

Walk through the pre-deploy checks for the change that is staged. Do not deploy anything:
this command produces a checklist with evidence, and a human approves each line.

What is staged:

!`git --no-pager diff --cached --stat`

The change itself:

!`git --no-pager diff --cached`

Recent history, for context on what is already released:

!`git --no-pager log --format=%h\ %s -8`

Work through each check in order, and quote the evidence for each one rather than
asserting it:

1. **Tests.** Which package suites cover this change, and did they pass? Name the
   command you ran. A check you did not run is reported as not run, never as passing.
2. **Migrations.** Does this change touch stored state, a schema, or a migration file?
   If so, is the migration reversible, and has the rollback been tested? If there is no
   migration, say so explicitly.
3. **Configuration.** Does the change need a new environment variable, flag, or secret?
   If so, is it documented, and is the value present in every environment it must be?
   Never print a secret value: name the variable, not its content.
4. **Destructive steps.** Does the plan delete data, drop a table, remove a namespace, or
   rewrite history? Each one needs a named human approver before it runs. If there are
   none, say so.
5. **Rollback.** What is the fastest way back if this goes wrong: redeploy the previous
   release, run the down migration, or revert the commit? Name the exact command.

End with two lists: ready to deploy, and blocked on a human. Do not run the deploy. The
approvals below are a human act, and the agent asserting them would be certifying
something on a human's behalf.
