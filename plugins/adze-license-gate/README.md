# License Gate

**Denies adding a dependency under a copyleft or source-available licence, and denies a
dependency added without going through the version catalog.**

Surfaces used: **hooks** (`edit.pre`, `tool.pre`).

## What it does

| Rule | Event | Outcome |
| --- | --- | --- |
| An edit records a forbidden licence identifier in `package.json`, `pnpm-workspace.yaml`, or a `LICENSE` file | `edit.pre` | `deny` |
| A whole-file write of one of those files does the same | `tool.pre` | `deny` |
| An edit adds a dependency with an inline version instead of `catalog:` | `edit.pre` | `deny` |
| `pnpm add`, `npm install`, `yarn add`, or `bun add` of a named package | `tool.pre` | `deny` |
| Any of the above names `ovsx` | either | `deny`, with the specific reason |

Forbidden identifiers, copied verbatim from `scripts/check-licenses.mjs`: `AGPL`, `LGPL`,
`GPL`, `EPL`, `MPL-1`, `SSPL`, `BUSL`, `FSL`, `COMMONS CLAUSE`, `COMMONS-CLAUSE`,
`ELASTIC-2`, `UNLICENSED`. Matched as prefixes, because the strings in the wild vary
(`GPL-3.0-only`, `GPL-3.0-or-later`, `AGPL-3.0`).

## Why it exists

The dependency policy in `CONTRIBUTING.md` has two halves and the second is what actually
catches licence problems. The first half is the forbidden list. The second is the process:
read the actual LICENSE file, put the version in the `catalog:` block, and — if the package
runs an install script — list it in `onlyBuiltDependencies` and justify it in the PR.

`pnpm add <pkg>` skips all of that in one keystroke. It writes an inline version into the
nearest `package.json`, which is the specific thing the catalog exists to prevent, and
nobody read a LICENSE. So the command is denied and the denial spells out the two-step
workflow, which is the intervention that has an effect.

## This is a pre-check, not the authority

`scripts/check-licenses.mjs` is the authority. It walks the installed tree, reads each
package's declared licence, and fails CI.

This hook fires *before* the dependency is added, which is a much better moment to find out
and a much worse position to judge from: it sees the text of an edit, not an installed
package. That asymmetry sets the bias deliberately. The forbidden list is copied from the CI
script so the two cannot disagree about what is forbidden, and **where this hook is unsure
it allows**, leaving CI to decide.

A hook that wrongly denies blocks legitimate work and gets uninstalled. A hook that wrongly
allows costs a CI failure at the next push. Those are not symmetric costs, and this plugin
is tuned for the cheaper failure.

The clearest case is dual licensing. `MIT AND GPL-3.0` is denied; `(MIT OR GPL-3.0)` is
allowed, because a dual licence is a genuine choice and taking the permissive option is
exactly what a consumer is entitled to do. Reading an `OR` expression as forbidden because
one of its options is would deny a large amount of perfectly usable code. The `AND`-before-
`OR` evaluation order is copied from the CI script for the same reason the list is.

## Why there is no package-name-to-licence table

The obvious implementation carries a list of well-known copyleft npm packages and denies
them by name. It is a bad idea, and the reason generalises past this plugin.

Such a list is a claim about facts that change without notice. Several projects in this
ecosystem have relicensed between minor versions, in both directions, and npm packages
frequently carry a different licence from the server or CLI they are named after. A stale
entry either blocks a package that is now permissive — a wrong `deny`, the expensive kind —
or waves through one that is not, while looking like it checked. **A wrong licence claim is
worse than no claim, because it gets believed.**

So the only package named by this plugin is `ovsx`, and only because this repository has
already established the fact and written it down: `pnpm-workspace.yaml` records that it is
EPL-2.0, deliberately absent from the dependency graph, and invoked through `pnpm dlx` when
publishing to Open VSX. That is a fact with a source in the repository rather than a fact
from memory.

## Precision of the catalog check

The inline-version check only fires on a `package.json` path, for a line shaped like
`"<name>": "<range>"` where the name is a plausible npm package name and the value starts
with a version range.

Keys whose value is a version but which are not dependencies are excluded by name:
`version`, `packageManager`, `name`, `node`, `pnpm`, `npm`, `main`, `module`, `types`,
`license`, `engines`, `type`. `"catalog:"` is not a version range, so a correctly written
dependency does not match. `pnpm-workspace.yaml`'s own catalog block is YAML rather than
JSON and is the correct place for a version, so it is not checked for this rule.

## What it does not catch

- **A transitive dependency's licence.** This hook sees an edit to a manifest. A permissive
  package that pulls in an AGPL dependency two levels down passes, and `scripts/check-licenses.mjs`
  is what catches it.
- **A licence stated only in a LICENSE file body.** The check looks for a `license:` field,
  not for the text of the GPL.
- **A dependency added by editing a lockfile.** That would be a strange thing to do and it
  is not covered.

## Installing

```bash
adze plugin dev ./plugins/adze-license-gate
```

`runtime: "js"`, therefore **unsandboxed**; the host must pass `allowUnsandboxedJs`.

## Tests

`plugins/test/license-gate.test.ts` drives each denial through `dispatchToolCall` from
`@adze/core`, including the dual-licence case that must *not* deny.
