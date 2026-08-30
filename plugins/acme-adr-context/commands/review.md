---
name: review
description: Review staged changes against our conventions
tools: [read, grep, symbols, bash]
model: { prefer: reasoning }
---

Review the staged diff.

!`git diff --cached`

Check: error handling, missing tests, and anything violating @adr.

Report findings by severity. Do not modify files.
