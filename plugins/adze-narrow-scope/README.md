# Narrow Scope

Keeps work in small reviewable phases with one concern per commit.

- `/plan-small` breaks a task into narrow phases before code is written, each with
  its boundary, its verification, and its future commit subject. It writes no code.
- `/split-commit` proposes how to split what is already staged into narrow commits,
  with the exact `git reset -p` and signed-off commit steps. It stages nothing and
  runs nothing.
- The `scope-auditor` subagent audits a diff for bundled concerns — a behaviour
  change plus a refactor, a fix plus its proof tangled together, a user-visible
  change with no changeset. It is read-only by construction, so a narrow verdict
  means the diff is narrow, not that it was narrowed mid-review.
