# Ops Runbook

Deploy and rollback as checklists with evidence, not as commands the agent runs.

- `/deploy-checklist` walks the staged change through tests, migrations,
  configuration, destructive steps, and the rollback, quoting evidence for each line.
  It reports what is ready and what is blocked on a human. It never deploys.
- `/rollback-plan` drafts the fastest way back with exact commands and a
  confirmation per step. It never runs any step.
- The `ops-reviewer` subagent audits a plan for destructive steps, missing
  approvers, untested rollbacks, and exposed secrets. It is read-only by
  construction — `read`, `grep`, `glob`, `symbols` — so its findings cannot have
  been fixed mid-review.

Approvals are a human act. The agent asserting them would be certifying something on
a human's behalf, in the same way a tool must not add a DCO sign-off by itself.
