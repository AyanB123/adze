# Commit Conventions

**Writes Conventional Commit messages with a DCO sign-off, refuses a commit that would not
carry one, and refuses history rewrites.**

Surfaces used: **slash commands** (`/commit`, `/changeset`), **hooks** (`tool.pre`).

## What it does

| Rule | Outcome |
| --- | --- |
| `git commit` with no `-s`, no `--signoff`, and no `Signed-off-by:` in the message | `deny` |
| `git commit --amend` | `deny` |
| `git commit --no-verify` | `deny` |
| `git push --force`, `-f`, or `--force-with-lease` | `deny` |
| A `-m` message that is not a Conventional Commit subject | `deny` |
| A summary ending in a period, or starting with a capital | `deny` |
| `git log`/`diff`/`show`/`blame`/`shortlog` without `--no-pager` | `modify` |

`/commit` reads the staged diff and the last three commit messages and drafts a message in
the style this repository actually uses. `/changeset` decides whether the change is
user-visible enough to need one, and says so when it is not.

## Why it exists

This dogfoods `CONTRIBUTING.md`. The sign-off requirement, the Conventional Commits
format, and the rule against amending a branch under review are all written down there and
none of them is checkable by the engine. A hook makes them mechanical.

It is also the plugin that demonstrates *both* useful hook answers on one workflow, and
the choice between them is the interesting part.

## Why a missing sign-off is a denial and not a rewrite

The obvious implementation rewrites `git commit -m "..."` into `git commit -s -m "..."`.
`modify` exists, the rewrite is one token, the agent never loses a step, and it would be
wrong.

`-s` appends `Signed-off-by: Name <email>`, which is an assertion under the
[Developer Certificate of Origin](https://developercertificate.org/) that the committer has
the right to submit the code under the project's licence. That is a legal certification
about a person. A plugin that adds it automatically has signed something on a human's
behalf that the human did not sign, and the DCO's entire value is that a person asserted
it. `CONTRIBUTING.md` is explicit that there is no CLA and never will be, precisely because
the difference between "you asserted this" and "something asserted it for you" is
load-bearing.

So the sign-off rule denies, explains, and the human types `-s`.

The `modify` path is used for the one thing where nothing is being asserted. `git log`
without `--no-pager` can block on a pager in a non-interactive shell: the agent sees a tool
call that never returns and the user sees the agent freeze. Rewriting it to
`git --no-pager log` changes no meaning and removes a real failure mode.

That is the line this plugin draws between the two outcomes — `modify` for a mechanically
safe correction, `deny` for anything a human has to decide.

## Compound commands

A model writes `git add plugins && git commit -m "..."` as a single `bash` call, so a check
anchored at the start of the command string would miss the commit. Every `&&`, `||`, `;`, and
newline-separated segment is examined.

The split is quote-aware, and it has to be. A real commit message contains newlines — subject,
blank line, body, sign-off trailer — and it arrives inside one quoted `-m` argument. Splitting
naively on `\n` cuts that message in half, leaves the first piece holding an unterminated
quote, and finds no sign-off in it, denying a correctly signed commit. That was a real bug in
this plugin, caught by the test `allows a sign-off written into the message body`, and it is
the exact failure that gets a policy hook uninstalled.

Flag detection additionally runs against a copy of each segment with quoted text blanked out,
because `git commit -m "explain the -s flag"` contains the token `-s` inside its own message.
Testing the raw string would read that as a sign-off and allow the commit — a false negative
on a policy check, which is the direction that matters.

The splitter is still not a shell parse: it does not handle backslash escapes inside quotes,
or subshells. That is deliberate. A policy hook containing a shell grammar has a shell
grammar's bugs, and this one's failure mode on a pathological command is that it is examined
as one segment instead of two — a spurious `allow` rather than a wrong `deny`.

## What it does not catch

- **A message passed with `-F <file>`.** The hook cannot read the filesystem — it declares
  `filesystem: "none"` — so it cannot verify a sign-off inside the file. It requires `-s`
  in that case and says why, which is the same outcome by a different route.
- **A sign-off with a name that is not yours.** DCO compliance is a claim about a person;
  a string match cannot check it.
- **Whether the scope is the right one.** `feat(core)` for a change in `packages/apply`
  passes. Scope accuracy is a review question.

## Installing

```bash
adze plugin dev ./plugins/adze-commit-conventions
```

The hook is `runtime: "js"` and therefore **unsandboxed**; the host must pass
`allowUnsandboxedJs`. See [FINDINGS.md](../FINDINGS.md#3-the-spec-gives-no-entry-shape-for-four-of-the-six-surfaces)
for why every procedural plugin needs that flag today.

## Tests

`plugins/test/commit-conventions.test.ts` runs each denial through `dispatchToolCall` from
`@adze/core` and asserts the `bash` body never ran, plus the `modify` path reaching the
tool body rewritten.
