# 0010 — Patch series plus Agent Host Protocol, not a merged fork

**Status:** Accepted
**Date:** 2026-08-29
**Deciders:** @AyanB123

## Context

Two facts about upstream VS Code in 2026 invalidate the fork playbook that Cursor
and Void were built on.

**1. The release cadence changed from monthly to weekly.** Measured from git tags:
monthly through 1.111.0 (2026-03-06), then 1.112.0 on 2026-03-17, and roughly
7-day gaps since. That is **~50 merge events per year instead of 12.** Any
maintenance estimate based on a monthly cadence is off by 4×.

**2. Upstream shipped an Agent Host process and an open Agent Host Protocol**
(published 2026-08-26). A dedicated process owns agent sessions; editor windows,
a separate Agents window, and browser clients are all AHP clients. Harness
adapters translate SDK-specific events into a common session model. The spec is
public with client libraries in Rust, TypeScript, Kotlin, Go, and Swift, and
`code agent host` runs a standalone host.

Most of what Cursor and Void forked the editor to build is now an extension point.

**Churn measured per file** since the weekly era began (~5.8 months, ~24
releases):

| Path | Commits | Meaning |
| --- | --- | --- |
| `src/vs/editor/browser/editorExtensions.ts` | **0** | frozen |
| `.../services/codeEditorService.ts` | **0** | frozen |
| `.../editorBrowser.ts` | **0** | frozen |
| `.../platform/product/common/productService.ts` | **0** | frozen |
| `.../parts/views/viewPane.ts` | 1 | stable |
| `.../editor/common/languages.ts` | 3 | stable |
| `product.json` | **29** | conflicts nearly every merge |
| `workbench.common.main.ts` | **31** | conflicts nearly every merge |
| `.../contrib/inlineChat/` | **67** | hottest area in the blast radius |

This is an unusually actionable result. **The extension points we would build on
are frozen. The files upstream is actively developing are exactly the AI features
we would otherwise be reimplementing.**

## Decision

**A thin patch series over a pristine upstream checkout, additive code in our own
directory, and our agent behind AHP.**

### Never a vendored merged fork

`apps/ide/vscode/` is gitignored. The build clones upstream at a **release tag**,
applies a numbered patch series, and builds. Following VSCodium's method, not its
repo.

### Additive code never conflicts

Our features live in `src/vs/workbench/contrib/adze/{browser,common}/`. Upstream
has no opinion on that directory, so it cannot conflict. We touch
`workbench.common.main.ts` with **exactly one appended import line**.

### Mechanical handling for the two chokepoints

- `product.json` — a `jq` delta program regenerated at build time, plus a
  `merge=ours` driver. Never merged textually. This converts the #1 conflict
  source into a build step.
- `workbench.common.main.ts` — one appended line, which `rerere` resolves after
  the first time.

### The agent goes behind AHP

We implement an AHP harness rather than a bespoke chat UI. We inherit the Agents
window, session persistence, remote sessions, and the browser client — and we stop
merging against a directory that took 67 commits in 5.8 months.

### The minimum in-tree patch set

Only what no extension can do:

1. `product.json` — names, IDs, fresh win32 AppId GUIDs, protocol, gallery, update URL
2. Icons and installer resources
3. Telemetry endpoint neutralization (a ripgrep-and-rewrite pass, not a patch)
4. Removing upstream's bundled chat agent wiring
5. Pruning extension recommendation maps ([ADR-0009](0009-extension-gallery.md))
6. Update client repointed at a static JSON feed
7. Extension signature verification (upstream hardcodes an assumption forks break)
8. Type additions for custom `product.json` keys

Plus the three things that genuinely need in-tree work and are where the IDE
earns its existence: **view-zone-based streaming inline diff**, **custom
undo grouping** so one Ctrl+Z reverts an agent turn rather than 200 micro-edits,
and the **inline edit overlay widget**.

### Merge automation from day one

`git rerere` enabled with a shared `rr-cache`. A nightly CI job attempts the
upstream merge, auto-resolves known conflicts, regenerates `product.json`, and
opens a PR — or labels it `needs-human` with the conflict list. **"Releases
behind" is a tracked metric with an alert above 3.**

## Alternatives considered

**Long-lived fork with periodic `git merge upstream/main`** — rejected. Full-tree
conflict surface at ~50 merges/year. Right only if our value were genuinely
spread across the tree, and with AHP it is not.

**Rebase onto each tag** — rejected outright. Re-resolves the same conflict once
per commit in the series. Strictly dominated.

**Fork Void** — rejected. Archived, months behind at archival, unmaintained. Its
own fork ecosystem peaked near 230 stars. We read its source — its React-in-workbench
bundling and its view-zone diff service are the best available references — and
take its CI workflows under Apache-2.0. We do not take its tree.

**Build on Eclipse Theia** — rejected. Its critique of forking is accurate and
worth reading. But EPL-2.0 file-level copyleft conflicts with an Apache-2.0
product, the GPL-2.0-with-classpath-exception alternative is worse, and our users
are VS Code users who will notice the margins. AWS Kiro chose Code-OSS + Open VSX,
which is the relevant precedent.

**Extension only, no IDE** — rejected as an endpoint, adopted as sequencing. The
extension API genuinely cannot do streaming view-zone diffs or agent-turn undo
grouping. But the extension ships first.

**Bespoke chat UI instead of AHP** — rejected. It is competing with a weekly-released
upstream subsystem, permanently, for no user-visible gain.

## Consequences

**Good.** Maintenance cost proportional to our diff rather than to the tree.
Additive files cannot conflict. AHP gives us multi-window sessions and persistence
for free. Building on frozen extension points means our integration is stable.

**Bad.** Weekly upstream releases still require continuous attention. Patch
failures need manual `.rej` resolution. AHP is new, so it may change under us.
Cross-platform signing and notarization is real work with real cost.

**Costs we accept.** **One engineer's continuous attention on upstream tracking**,
permanently. Not budgeting this is what killed Void. And a UI ceiling: staying
inside AHP means we cannot do things upstream has not exposed, and we prefer that
to a permanent merge tax.

## Revisit when

- AHP proves insufficient for a feature users actually need — that is a case for a
  targeted patch, not for abandoning the strategy.
- "Releases behind" exceeds 3 for more than two weeks. That is a resourcing signal.
- Upstream cadence changes again.
