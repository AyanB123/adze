# Adze IDE

A Code-OSS fork: upstream cloned at a pinned release tag, a thin patch series
applied on top, additive code in a directory upstream does not own, and the agent
behind upstream's Agent Host Protocol.

> ## No binary has been built or shipped
>
> Nothing in this directory has produced an executable. There is no installer, no
> release, no update feed, and no gallery. The build pipeline has never been run to
> completion by anyone, and the CI workflows that would run it are gated on
> `workflow_dispatch` with their schedules commented out.
>
> This is **milestone M4 groundwork**: the pipeline, the branding delta, the patch
> series structure, and the CI shape, committed so they are reviewable alongside
> [ADR-0010](../../docs/architecture/adr/0010-ide-fork-strategy.md) rather than
> written six weeks later under time pressure.
>
> **Every patch in [`patches/`](patches/) is an unwritten placeholder.** Each has
> its header, its intent, the upstream files it will touch, and instructions for
> writing it. None contains a diff hunk, because hunks written against source
> nobody has read fail to apply — and a plausible-looking patch that fails is worse
> than a placeholder that says so.
>
> What *is* verified is listed under [Verified / unverified](#verified--unverified).

---

## Layout

```
apps/ide/
├── UPSTREAM_TAG            the pinned upstream release tag — the only place it lives
├── config.sh               paths, the recorded tag commit, build knobs
├── scripts/                the pipeline, numbered in execution order
├── branding/               product.json delta, claimed gallery namespaces
├── patches/                numbered patch series (all currently placeholders)
├── contrib/                plan for the in-tree code, none of which is written
├── fixtures/               a product.json stand-in, so the delta is testable
└── vscode/                 gitignored — the upstream checkout, fetched, never vendored
```

## Pipeline

```bash
bash apps/ide/scripts/build.sh --target win32-x64
```

| Step | Does |
| --- | --- |
| [`00-preflight.sh`](scripts/00-preflight.sh) | Tools, Node version, the tag's format, CRLF in the patch series, Windows path length. Reports every problem at once. |
| [`10-fetch-upstream.sh`](scripts/10-fetch-upstream.sh) | Shallow clone at the pinned tag, after verifying the tag still points at the recorded commit. |
| [`20-apply-patches.sh`](scripts/20-apply-patches.sh) | Numbered order, `.patch.no` skipped, one commit per patch, `.rej` files on failure. |
| [`30-generate-product.sh`](scripts/30-generate-product.sh) | Applies the `jq` delta to upstream's `product.json`, then asserts on the result. |
| [`40-audit-gallery.sh`](scripts/40-audit-gallery.sh) | Runs the ADR-0009 gate. A recommendation naming an unclaimed namespace fails the build. |
| [`50-neutralize-telemetry.sh`](scripts/50-neutralize-telemetry.sh) | ripgrep sweep over the checkout, then re-scans to verify itself. |
| [`60-build.sh`](scripts/60-build.sh) | `npm ci`, compile once, package one target. **Never run.** |

Two orderings that are not obvious: patches before the telemetry sweep, because
patches are pinned to line numbers and the sweep is not; and the gallery audit
after `product.json` generation, because auditing upstream's unmodified file tests
a document we do not ship.

Anything checkable without a clone:

```bash
bash apps/ide/scripts/verify-product-delta.sh   # 42 checks, no network, ~1 second
```

---

## Zero to a binary

Ordered by dependency. Estimates are for one engineer who has not built Code-OSS
before, and they are deliberately not optimistic — ADR-0010 budgets 6–10 weeks for
this milestone, and the roadmap says the IDE only starts after the extension has
users.

| # | Step | Estimate | Notes |
| --- | --- | --- | --- |
| 1 | Install the toolchain | **0.5–2 days** | Node 22, Python 3, a C++ toolchain. Windows needs Visual Studio Build Tools *including the Spectre-mitigated libraries* — see below. Linux needs `libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev`. |
| 2 | `10-fetch-upstream.sh` | **10–30 min** | ~2 GB. Bandwidth-bound. |
| 3 | `npm ci` in the checkout | **10–25 min** | The step most likely to fail on a fresh machine. Native modules compile here. |
| 4 | First unbranded compile | **20–45 min** | Do this *before* touching anything. A baseline build establishes that the toolchain works, so a later failure is attributable to our changes. |
| 5 | `30-generate-product.sh` + audit | **minutes** | Already works against a fixture. |
| 6 | Author the icon set, write patch 0001 | **1–3 days** | Six formats across three platforms from one SVG. Mostly asset work. |
| 7 | Write patch 0002 (one import line) | **1 hour** | Trivial once the contribution file exists. |
| 8 | Write `adze.contribution.ts` | **2–5 days** | Registration only, no features. Getting the DI wiring right is most of it. |
| 9 | Write patch 0006 (product types) | **1 hour** | Six lines in one interface. |
| 10 | First branded build, all six targets | **1–2 days** | Expect a per-platform packaging failure. arm64 cross-compilation is where surprises live. |
| 11 | Write patch 0004 (signature verification) | **2–4 days** | Needs a working gallery to test against, so it depends on step 13. |
| 12 | Write patch 0003 (chat wiring removal) | **3–7 days** | Sized by measurement, not by plan — see the patch header. Hottest area upstream. |
| 13 | Deploy a self-hosted Open VSX instance | **1–2 weeks** | Postgres, Elasticsearch, Redis, object storage. ADR-0009 rejected depending on `open-vsx.org`. Real infrastructure with real operational cost. |
| 14 | Static update feed + patch 0005 | **3–5 days** | Six JSON files behind a CDN, plus the client change. Verify per platform; Squirrel.Mac fails silently. |
| 15 | Signing and notarization | **1–2 weeks** | Windows Authenticode certificate (and EV for immediate SmartScreen reputation), Apple Developer ID, notarytool. Mostly procurement latency, not engineering. |
| 16 | AHP harness | **2–4 weeks** | Where the product actually is. Everything above is packaging. |
| 17 | Streaming diff, undo grouping, overlay widget | **4–8 weeks** | [`contrib/README.md`](contrib/README.md). Why the IDE exists. |

Steps 1–10 produce an unsigned, un-updatable build with an empty extension gallery
that you can run locally. That is the honest first milestone, and it is roughly two
to three weeks of work. Steps 13–15 are what "shipping" means, and they are
infrastructure and procurement rather than code.

---

## Windows failure modes

Every one of these produces an error that does not name its own cause. This section
exists because the time lost to them is measured in days, and the fix is usually a
single setting.

### CRLF corrupting patches

**The most common Windows-only fork build failure.** A patch checked out with CRLF
fails with `error: patch does not apply` and says nothing about line endings. The
content is fine; the bytes are not.

`.gitattributes` at the repository root marks `*.patch` and `*.diff` as `-text`, and
[`apps/ide/.gitattributes`](.gitattributes) extends that to `*.patch.no` so a rename
between the two forms is safe. `00-preflight.sh` scans the working tree for CR bytes
before anything expensive runs.

If it happens anyway — usually a clone made before the attribute existed:

```bash
git rm --cached -r apps/ide/patches
git checkout -- apps/ide/patches
```

### `MAX_PATH` and a long build root

Upstream's `node_modules` tree exceeds 200 characters on its own. Windows caps most
path APIs at 260 unless the process has opted into long paths, and Node's
dependencies have not uniformly done so. The failure is `ENAMETOOLONG`, or a module
reported as missing when it is present.

```bash
ADZE_IDE_BUILD_ROOT=/c/a bash apps/ide/scripts/build.sh --target win32-x64
git config core.longpaths true
```

`00-preflight.sh` warns above 32 characters. The CI workflow uses `/c/a`.

### MSVC Spectre-mitigated libraries

`npm ci` compiles native modules through `node-gyp`. Several require the
Spectre-mitigated MSVC runtime libraries, which are a **separate optional component
in the Visual Studio Installer** and are not included by "Desktop development with
C++" by default.

Without them the failure is a linker error inside a transitive dependency, naming a
`.lib` nobody has heard of and not mentioning Spectre. Install *MSVC v143 - VS 2022
C++ x64/x86 Spectre-mitigated libs* (and the ARM64 variant for arm64 builds).

### AppId collisions

Covered in detail in [`branding/README.md`](branding/README.md), and repeated here
because it is the one failure with consequences on someone else's machine.

Inno Setup treats `AppId` as product identity. An installer carrying VS Code's AppId
is not installed *alongside* VS Code — it is treated as an upgrade *of* it, inherits
its uninstall entry, and can remove it. The four GUIDs in
[`branding/product.delta.jq`](branding/product.delta.jq) were generated fresh for
Adze, and `30-generate-product.sh` asserts they differ from upstream's published
values so that copying them back in is a build failure.

The same argument applies in three further mechanisms: a shared `win32MutexName`
makes each product believe the other is a running instance of itself, a shared
`win32RegValueName` has them overwrite each other's file associations, and a shared
`win32AppUserModelId` merges them into one taskbar button.

Never regenerate an AppId after a build has shipped. It orphans every existing
installation, which then cannot be upgraded or uninstalled.

### Antivirus file locking

Real-time scanning opens files the build is writing. Symptoms: `EBUSY`, `EPERM`,
`EACCES` on a file that plainly exists, on a different file each run — the
non-determinism is the tell. It is most likely during `npm ci`'s many small writes
and during packaging's large ones.

Exclude the build root and the npm cache from real-time scanning. This is also why
the CI workflow uses a dedicated short root rather than the runner workspace.

---

## Extensions

Adze uses **Open VSX**, self-hosted. The Microsoft Marketplace is closed to forks:
its Terms of Use §2(b) and §3 prohibit installing, importing, or using Marketplace
offerings in products outside Microsoft's own, Microsoft's FAQ names Code-OSS forks
explicitly, and it has been enforced — the C/C++ extension stopped working in forks
in April 2025. Full reasoning:
[ADR-0009](../../docs/architecture/adr/0009-extension-gallery.md).

Open VSX carries roughly 17,000 extensions against the Marketplace's 48,000+. Most
workflows are covered. Some are not, and this is the honest table:

| Unavailable (Microsoft-licensed) | Substitute | Assessment |
| --- | --- | --- |
| Pylance | basedpyright | Good. Set `typeCheckingMode: off` for similar behaviour. |
| C# Dev Kit | SharpLsp | Reasonable. The base C# extension is MIT; only Dev Kit is restricted. |
| .NET debugger (`vsdbg`) | netcoredbg | Weaker but functional. |
| Remote - SSH | open-remote-ssh | Works; needs `serverDownloadUrlTemplate` wiring. |
| Dev Containers | open-remote-devcontainer | **Immature.** No Compose, no `features`. |
| Copilot / Copilot Chat | Adze itself | n/a |
| Live Share | — | **No substitute. A genuine gap.** |

**If your workflow depends on Dev Containers or Live Share, do not use the Adze
IDE.** Use the [Adze extension](../vscode/) inside real VS Code instead — it is one
of the reasons the extension ships first.

One further consequence of the same rule, which is ours rather than inherited:
`builtInExtensions` is emptied by the branding delta, because upstream downloads
those from the Marketplace during the build and that download is exactly the
prohibited import. A build from this pipeline therefore has **no JavaScript
debugger** and none of the JS profiling viewers. Sourcing replacements from Open VSX
or building them from their own repositories is an open decision, recorded here
rather than papered over.

---

## Maintenance cost

Upstream releases **weekly** — measured from git tags, monthly through 1.111.0
(2026-03-06), then 1.112.0 on 2026-03-17 and roughly 7-day gaps since. That is
about **50 tracking events a year, not 12**. Any estimate written against a monthly
cadence is off by 4×.

ADR-0010's design is a response to that arithmetic. Measured churn over 5.8 months
and ~24 releases:

| Path | Commits | Our exposure |
| --- | --- | --- |
| `editorExtensions.ts` | **0** | We consume it. Frozen. |
| `codeEditorService.ts` | **0** | We consume it. Frozen. |
| `editorBrowser.ts` | **0** | We consume it. Frozen. |
| `productService.ts` | **0** | We consume it. Frozen. |
| `product.json` | 29 | **Zero.** Regenerated from a `jq` delta. |
| `workbench.common.main.ts` | 31 | One appended line. `rerere` replays the resolution. |
| `contrib/inlineChat/` | **67** | **Zero.** We do not patch it — the agent runs behind AHP. |
| `contrib/adze/` | n/a | Ours. Upstream never touches it, so it cannot conflict. |

Per release, if the design holds: the bot bumps the pin, checks that the series
still applies, regenerates `product.json`, and opens a pull request. A human reads
it. **Minutes, most weeks.** When a patch breaks, the cost is one `.rej` resolution
in a patch we wrote, and the merge bot names which one.

ADR-0010 states the real budget plainly, and it is not a per-release number: **one
engineer's continuous attention on upstream tracking, permanently.** Not budgeting
that is what killed Void. "Releases behind" is a tracked metric with an alert above
3, and sustained drift is treated as a resourcing signal rather than a bug.

---

## Verified / unverified

Nothing below is a claim about the built product, because there is no built product.

**Verified by running it:**

- All 11 shell files pass `bash -n`.
- `verify-product-delta.sh` passes 42 checks: the `jq` program parses, produces a
  valid object from an upstream-shaped fixture, applies every override and deletion,
  preserves the fixture's unrelated keys, keeps Inno Setup's doubled-brace escaping,
  emits four distinct AppIds that are none of upstream's, prunes all seven
  recommendation maps while keeping their types, is idempotent, and passes the real
  ADR-0009 audit gate.
- `30-generate-product.sh` refuses to write a `product.json` containing a
  reserved-TLD endpoint, and writes one when `ADZE_ALLOW_PLACEHOLDER_ENDPOINTS=1`.
- `60-build.sh` refuses to build against an unbranded `product.json`.
- `40-audit-gallery.sh` passes against the generated document, reporting one
  recommendation resolved against one claimed namespace.
- Both workflow files parse as YAML.

**Not verified, and not verifiable without cloning upstream:**

- That the real `product.json` at the pinned tag has the shape the fixture models.
  The fixture is a stand-in and says so.
- That any patch applies. None contains a hunk.
- That the upstream file paths named throughout exist at the pinned tag.
- That the telemetry hostname denylist matches anything in the upstream tree. The
  sweep reports zero matches as a question rather than as success.
- That `npm ci`, the compile, or any packaging task succeeds. `60-build.sh` has
  never been executed.
- That the CI workflows run. Neither has ever been triggered.

The pinned tag itself is verified: `1.135.0` resolves to
`08d4889f9ec4a1685d257b9b95de036c8e1ce1e5` via `git ls-remote`, and it is the newest
`1.13x.0` release tag upstream publishes. `10-fetch-upstream.sh` re-checks that
before cloning.

---

## See also

- [ADR-0010 — patch series plus AHP, not a merged fork](../../docs/architecture/adr/0010-ide-fork-strategy.md)
- [ADR-0009 — Open VSX only](../../docs/architecture/adr/0009-extension-gallery.md)
- [`patches/README.md`](patches/README.md) — series convention, and what is deliberately not a patch
- [`branding/README.md`](branding/README.md) — the delta, the GUIDs, the placeholders
- [`contrib/README.md`](contrib/README.md) — the additive contribution plan
- [`docs/roadmap.md`](../../docs/roadmap.md) — M4, and why it comes after the extension
