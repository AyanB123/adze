---
name: test-first
description: Write a failing test for a bug, confirm it fails for the right reason, then fix it
tools: [read, grep, glob, symbols, edit, write, bash]
model: { prefer: reasoning }
---

Fix the problem I describe, in this order. Do not skip a step, and do not reorder them —
the order is the whole method.

## 1. Reproduce it as a test, before reading the implementation

Write a test that fails because of the bug. Put it beside the existing tests for that
package, in their style.

Read the implementation only far enough to know where the test belongs. Reading it first
biases the test toward the code that exists, and a test shaped like the buggy code tends to
assert the buggy behaviour with a different sign.

## 2. Run it, and read the failure

!`echo "run the package's tests now — see the note below on how"`

Confirm two things, not one:

- **It fails.** A test that passes before the fix tests nothing.
- **It fails for the reason you expect.** This is the step that gets skipped and it is the
  one that pays. A test that fails because of a typo in the fixture, a missing import, or an
  assertion comparing the wrong two values will start passing when you "fix" the bug, and you
  will have shipped nothing and proved it works.

Quote the failure message and say what it tells you about the cause. If the message does not
distinguish your hypothesis from the alternatives, improve the test until it does.

## 3. Only now, fix it

Make the smallest change that turns the test green. Do not refactor in the same step: a
refactor bundled into a behaviour change means neither can be reviewed, and if the result is
wrong nobody can tell which half did it.

## 4. Run it again, and run the neighbours

Confirm the new test passes and the existing ones still do.

## 5. Say what you learned

One paragraph: what the actual cause was, and why the fix is correct rather than merely
sufficient. If you found something else while in there, name it and leave it alone — a
second finding is a second commit.

## How to run tests in this repository

Run the narrowest thing that answers the question. From inside the package:

```
node <path-to-repo-root>/node_modules/vitest/vitest.mjs run <path-to-test-file>
```

Do not run a repository-wide `pnpm test` or `turbo run test` to check one file. It builds
every package first, takes minutes, and the answer you need is in one file.

Vitest 4 removed the `basic` reporter — passing `--reporter=basic` is a hard startup error,
not a warning. Use the default.
