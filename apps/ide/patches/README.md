# Patch series

Patches applied to a pristine `microsoft/vscode` checkout at the tag pinned in
[`../UPSTREAM_TAG`](../UPSTREAM_TAG). Applied by
[`../scripts/20-apply-patches.sh`](../scripts/20-apply-patches.sh).

Read [ADR-0010](../../../docs/architecture/adr/0010-ide-fork-strategy.md) first.
The series exists because that ADR rejected a vendored merged fork: upstream now
releases weekly, roughly 50 times a year, and a full-tree merge surface at that
cadence is what killed the previous generation of forks.

> **Status, stated plainly: every patch in this directory is an unwritten
> placeholder.** Each carries its header, its intent, and the specific upstream
> files it will touch. None contains a diff hunk. Nothing here has been applied to
> an upstream checkout, because writing hunks against source that has not been
> read produces patches that fail — and a plausible-looking patch that fails to
> apply is strictly worse than a placeholder that says so.

---

## Convention

```
NNNN-short-kebab-description.patch      enabled, applied in numbered order
NNNN-short-kebab-description.patch.no   disabled, skipped, kept in the tree
```

`NNNN` is a zero-padded four-digit number. Order is lexical, which for a
zero-padded prefix is numeric. `20-apply-patches.sh` refuses to run if two
patches share a number, because then the order is decided by the rest of the
filename — an ordering nobody chose and nobody can see.

Numbers are never reused or renumbered. A `.rej` file from six months ago should
still name the patch it came from.

### `.patch.no` disables without deleting

A patch that stops applying and is not immediately worth fixing gets renamed to
`.patch.no` with the reason written **inside the file**. That is the point of the
suffix: deleting the patch loses the reason, and putting the reason only in a
commit message means the next person has to know to run `git log` on a file that
no longer exists.

The applier reports disabled patches on every run, so a `.patch.no` cannot quietly
become permanent.

### One commit per patch

Each applied patch becomes one commit in the checkout, so `git log
adze/pristine..HEAD` reads as the fork's diff and `git diff adze/pristine` **is**
the fork's diff. `10-fetch-upstream.sh` creates the `adze/pristine` tag for this.

### Line endings

`apps/ide/.gitattributes` marks both `*.patch` and `*.patch.no` as `-text`. A
patch checked out with CRLF fails with `patch does not apply` and says nothing
about line endings, which makes it the single most common Windows-only fork build
failure. `00-preflight.sh` checks the working tree for CR bytes before anything
expensive starts.

If a patch fails on Windows and the content looks right:

```bash
git rm --cached -r apps/ide/patches
git checkout -- apps/ide/patches
```

### Refreshing a patch

```bash
# Fix it up in the checkout, then regenerate from the pristine tag:
git -C apps/ide/vscode diff adze/pristine -- <paths> > apps/ide/patches/NNNN-name.patch
```

Regenerate against the pinned tag, not against whatever upstream is today.

---

## What is deliberately *not* a patch

Three things a fork would conventionally patch are handled by other mechanisms
here. Each is a decision, not an omission, and each removes a recurring conflict.

| Concern | Handled by | Why not a patch |
| --- | --- | --- |
| `product.json` branding | [`../branding/product.delta.jq`](../branding/product.delta.jq), applied at build time | 29 upstream commits in 5.8 months. The correct resolution is always "all of theirs plus all of ours", which a textual three-way merge cannot express. Regenerating converts the single largest conflict source into a build step. |
| Telemetry endpoints in source | [`../scripts/50-neutralize-telemetry.sh`](../scripts/50-neutralize-telemetry.sh) | The hosts appear across a double-digit number of files that upstream edits for unrelated reasons. A patch pinned to those locations breaks on a large fraction of ~50 releases a year. A sweep finds a moved string at its new location and turns a *new* endpoint into a build failure — which a patch cannot do at all. |
| Extension recommendation maps | The `product.json` delta, gated by [`scripts/audit-gallery-recommendations.mjs`](../../../scripts/audit-gallery-recommendations.mjs) | Data, not code. Pruning it in the delta means the audit runs against the document we actually ship. |

## What the fork does not patch at all

`src/vs/workbench/contrib/inlineChat/` took **67 commits** in the 5.8 months
measured for ADR-0010 — the hottest area in the whole blast radius, and exactly
the AI surface a fork is tempted to modify. Adze's agent runs behind upstream's
Agent Host Protocol instead. See
[`../contrib/README.md`](../contrib/README.md).

The extension points the additive code does build on took **zero** commits in the
same window: `editorExtensions.ts`, `codeEditorService.ts`, `editorBrowser.ts`,
`productService.ts`.

---

## The series

| # | Patch | Touches | Risk | Status |
| --- | --- | --- | --- | --- |
| 0001 | branding: icons and installer resources | `resources/**`, `build/win32/**` | Low — upstream rarely edits these | unwritten |
| 0002 | register the Adze workbench contribution | `src/vs/workbench/workbench.common.main.ts` | Medium — 31 upstream commits, but one appended line, and `rerere` learns it once | unwritten |
| 0003 | remove bundled chat agent wiring | `src/vs/workbench/contrib/chat/**` | **High** — the one patch in genuinely hot territory | unwritten |
| 0004 | extension signature verification | `src/vs/platform/extensionManagement/node/**` | Medium | unwritten |
| 0005 | update client reads a static JSON feed | `src/vs/platform/update/**` | Low-medium | unwritten |
| 0006 | `IProductService` type additions | `src/vs/base/common/product.ts` | Low | unwritten |

"Risk" is the probability the patch needs human attention at a given upstream
release, estimated from the churn table in ADR-0010 rather than from feel.
