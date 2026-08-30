# Test First

**Makes write-a-failing-test-then-fix a first-class workflow, and turns a model failure into a
permanent regression case.**

Surfaces used: **slash commands** (`/test-first`, `/regression-case`, `/verify`).

## What it does

| Command | Does |
| --- | --- |
| `/test-first` | reproduce the bug as a failing test, confirm it fails *for the right reason*, then fix it, then re-run |
| `/regression-case` | turn an edit-application failure into a case in `packages/apply/test/` **and** `bench/suites/apply-bench/cases/` |
| `/verify` | run the narrowest checks that answer the question, and report what was not verified |

## Why it exists

A single round of test feedback is the highest-value intervention available in an agent loop.
A model that writes code and is told nothing has to be right the first time. A model that
writes a test, watches it fail, and reads the failure message has been handed the one piece of
information it cannot generate for itself: what the system actually does.

Making that a command rather than a habit matters because the step that gets skipped is
predictable. It is not "write the test" — models do that when asked. It is **confirming the
test fails for the reason you think it does.** A test that fails because of a typo in the
fixture, a missing import, or an assertion comparing the wrong two values will start passing
when the bug is "fixed", and the result is a green suite that proves nothing. `/test-first`
makes that a separate numbered step with its own output requirement, because a step folded
into another one is a step that gets skipped.

The second thing it encodes: **read the implementation only far enough to know where the test
belongs.** Reading it first biases the test toward the code that exists, and a test shaped like
the buggy code tends to assert the buggy behaviour with a different sign.

## `/regression-case` and the two places

`CONTRIBUTING.md` calls edit-format reliability cases the highest-leverage contribution in the
repository and sets the bar for adding one deliberately low. The failure users feel is a
mangled file, not a wrong suggestion — a wrong answer is annoying, and a corrupted file
destroys trust in a way that does not recover.

So the command writes the case in both places on purpose. `packages/apply/test/` is the unit
reproduction; `bench/suites/apply-bench/cases/` is what makes it protect every model the
project ever supports rather than only the one that produced it.

It also insists on the **exact** original input, and asks rather than reconstructing when it is
missing. A regression case built from a reconstructed file tests a situation that never
happened, and whitespace and indentation — the parts most likely to be smoothed over in a
reconstruction — are frequently the cause.

The command asserts on `tier`, `strategy`, and `validation` rather than only on `ok`, because
those three fields are what make "apply success rate per model per tier" publishable, and a
test checking only `ok` keeps passing while the telemetry rots.

And it refuses one specific fix: **do not add a matching strategy to make the case pass.** The
ladder is exact → whitespace-normalized → indentation-tolerant → anchored, and it stops there.
A near-miss on source code is a different program. If a case only passes with fuzzy matching,
the correct behaviour is a refusal whose message tells the model what to change.

## `/verify` exists because of how this repository is actually run

Every command in this plugin tells the agent to run the narrowest check, from inside the
package, with a direct `node` invocation:

```
node <repo-root>/node_modules/vitest/vitest.mjs run <path-to-test-file>
```

Not `pnpm test`, not `turbo run test`. A repository-wide target builds every package first,
takes minutes, and answers a question nobody asked. `/verify` also asks for the honest
negative: naming what was *not* checked, because "all tests pass" after running one package's
suite is a false statement about the repository, and it is the kind that gets quoted into a
commit body.

One concrete note that belongs in a prompt rather than in tribal memory: Vitest 4 removed the
`basic` reporter. Passing `--reporter=basic` is a hard startup error rather than a warning, so
the commands say to use the default.

## Zero executable code

Three markdown files and a manifest. This is the surface where ADR-0008's "most plugins need no
code at all" claim is least surprising and most useful — a workflow is prose, and prose is
reviewable by people who do not program.

## Installing

```bash
adze plugin dev ./plugins/adze-test-first
```

No flags: nothing here is procedural.

## Tests

`plugins/test/declarative.test.ts` loads the manifest, parses all three commands, and asserts
each one's `tools` allowlist matches what it actually needs — `/verify` and
`/regression-case` differ deliberately, and a command that quietly gained `bash` would be a
real change in what it can do.
