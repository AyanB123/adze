---
name: review-diff
description: Audit the staged diff with the read-only code-review subagent
tools: [read, grep, glob, symbols, bash, task]
model: { prefer: reasoning }
---

Audit the staged changes.

What is staged:

!`git --no-pager diff --cached --stat`

The change itself:

!`git --no-pager diff --cached`

Delegate the audit to the `code-review` subagent rather than doing it here. That is not
ceremony: the subagent's allowlist is `read`, `grep`, `glob`, and `symbols`, so it
structurally cannot modify the code it is reviewing, and a reviewer that cannot write is
the only kind whose findings you can trust not to have been "fixed" mid-review. Delegation
narrows by intersection with this session's grant and never widens it.

Consult @invariants for the architecture rules the audit is against.

If the diff touches `packages/apply`, also run `apply-forensics` on it. If it touches
`bench/`, also run `bench-claims`.

Report what comes back grouped by severity, and add nothing of your own — if you disagree
with a finding, say that you disagree and why, rather than dropping it. Silently filtering
a subagent's findings makes the delegation pointless.

Do not modify files. This command reviews.
