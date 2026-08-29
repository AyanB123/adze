<!--
Thanks for contributing to Adze.

Keep the pull request focused: two small ones review better than one large one,
and a refactor bundled into a behavior change is hard to review and harder to
revert. Fill in "Why" properly — the diff already says what changed.
-->

## What

<!-- One or two sentences. -->

## Why

<!--
The reasoning, not the mechanics. If you found a bug while writing the tests,
say so here — that paragraph is often the only place the reasoning survives.
-->

## How it was verified

<!--
What you actually ran, and on which platform. `pnpm check` is lint + typecheck +
test. If you touched the applier, say whether apply-bench moved.
-->

- [ ] `pnpm check` passes locally
- [ ] Tested on: <!-- Windows / macOS / Linux -->

---

## Checklist

- [ ] **Every commit is signed off** (`git commit -s`). This is the Developer
      Certificate of Origin assertion and it is required — a commit without it
      cannot merge. There is no CLA. See
      [CONTRIBUTING.md](../CONTRIBUTING.md#sign-off-dco-not-a-cla).
- [ ] **Commits follow Conventional Commits** with a scope that matches a package
      directory (`protocol`, `core`, `apply`, `cli`, `bench`, `ci`, `docs`, …).
- [ ] **New behavior has a test.** A bug fix has a test that fails before the fix.
- [ ] **A changeset is included** if anything user-visible changed —
      `pnpm changeset`. Protocol changes, CLI flags, tool behavior, and public
      types all count. Internal refactors and test-only changes do not.
- [ ] **An ADR is added or updated** if this changes a package boundary, the
      protocol, the permission or sandbox model, the applier's matching or
      validation behavior, a published benchmark claim, or **reverses an earlier
      decision**. A reversal gets its own ADR that supersedes the old one; the old
      one is marked `Superseded by NNNN` and kept.
      See [docs/architecture/adr/README.md](../docs/architecture/adr/README.md).
- [ ] **No new dependency**, or: the version is in the `catalog:` block of
      `pnpm-workspace.yaml`, its LICENSE file was read (not the registry's
      license field), and any install script is justified below.

## Architecture rules

These are review-blocking. Tick what applies; if something here is uncomfortable
to tick, that is worth discussing in the PR rather than working around.

- [ ] `@adze/core` imports no surface package and emits no display output — it
      returns structured events.
- [ ] Any new cross-surface capability went through `@adze/protocol`, not a
      private back channel. A gap between surfaces is a protocol gap.
- [ ] `@adze/protocol` still depends on nothing but `zod`.
- [ ] Service packages (`providers`, `apply`, `retrieval`, `sandbox`, `mcp`) do
      not import each other. Nothing imports from `bench/`.
- [ ] Every new tool call path goes through the permission gate.
- [ ] **No new outbound network call**, or it has an ADR. Local-first is a product
      promise.
- [ ] No planned capability is described as working. Planned work points at
      [docs/roadmap.md](../docs/roadmap.md) with a milestone.

<!--
If you added an apply-bench case for a real model failure: thank you, that is the
highest-leverage contribution in this repository, and it becomes permanent
regression protection for every model Adze ever supports.
-->
