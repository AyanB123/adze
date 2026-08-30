---
name: verify
description: Run the narrowest checks that answer whether the change is sound, and report honestly
tools: [read, grep, bash]
---

Verify the change that is in the working tree, then report what you actually ran.

Run the narrowest thing that answers the question, in this order, stopping to fix rather than
continuing past a failure:

1. **The tests for the packages you touched.** From inside each package:
   `node <repo-root>/node_modules/vitest/vitest.mjs run`
2. **Lint on the paths you touched**, not the repository:
   `node <repo-root>/node_modules/@biomejs/biome/bin/biome check <path>`
3. **Typecheck the package**, if it has a `typecheck` script and the change was structural.

Do not run a repository-wide `pnpm check`, `pnpm test`, `pnpm build`, or any `turbo run`
target to verify a scoped change. Those build every package first, take minutes, and answer
a question you did not ask. If a repository-wide run is genuinely needed, say so and let me
start it.

## Reporting

State exactly what you ran, with the command and the result. Then, and this is the part that
matters:

- **Name what you did not verify.** If you ran one package's tests, say that the others were
  not run. An unqualified "all tests pass" after one package's suite is a false statement
  about the repository.
- **Do not report a count you did not see.** If you ran two files, the number is those two
  files' tests, not the package total.
- **A skipped check is a result.** "Typecheck not run" is useful; silence implies it passed.
- **If something failed and you fixed it, say what failed.** The failure is the interesting
  part — it is evidence about the change, and it is the paragraph that survives into the
  commit body.
