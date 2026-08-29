# 0009 — Open VSX only; the Microsoft Marketplace is closed to forks

**Status:** Accepted
**Date:** 2026-08-29
**Deciders:** @AyanB123

## Context

An IDE without extensions is not an IDE. So the gallery question determines
whether the IDE surface is viable at all.

**The legal position is settled, not ambiguous.** The Visual Studio Marketplace
Terms of Use define "In-Scope Products and Services" as Microsoft's own products,
and then:

> §2(b): "Marketplace Offerings are intended for use only with In-Scope Products
> and Services and **you may not install, reverse-engineer, import or use
> Marketplace Offerings in products and services except for the In-Scope Products
> and Services.**"

> §3: "...harvesting, reverse-engineering, 'spidering' or 'scraping' ... whether
> automated or not, is prohibited. **You may not import, install, or use Offerings
> published by Microsoft or GitHub ... in any products or services except for the
> In-Scope Products and Services.**"

The wording tightened in 2025 — the earlier version said only "may install and
use ... only with In-Scope Products", and the current one adds "import" and
"reverse-engineer" plus a separate clause specifically about Microsoft-published
extensions.

Microsoft's own FAQ names forks explicitly: "alternative products including those
built on a fork of the Code - OSS Repository, are not permitted to access the
Visual Studio Marketplace." A 2016 Microsoft comment suggesting otherwise was
publicly retracted.

**Enforcement is real.** In April 2025 Microsoft's C/C++ extension stopped working
in Cursor and other forks.

**Code-OSS's MIT license grants nothing here.** It covers editor source, not a
Microsoft-operated service.

**Scale of the alternative:** Open VSX carries roughly 17,000 extensions against
Microsoft's 48,000+, serves 600M+ downloads/month, reached 1.0.0 in June 2026, and
is the gallery used by VSCodium, Cursor, Windsurf, and AWS Kiro. It implements the
VS Code gallery protocol, so `product.json` repointing is a config change.

## Decision

**Open VSX, self-hosted. No hybrid that touches `marketplace.visualstudio.com`,
ever.**

1. `product.json` `extensionsGallery` points at our Open VSX instance.
2. **Self-hosted rather than depending on `open-vsx.org`** — see the security
   record in [ADR-0008](0008-plugin-architecture.md). Self-hosting also lets us
   claim namespaces, which is the actual fix for recommendation squatting.
   Postgres + Elasticsearch + Redis + object storage, or the managed offering.
3. **The extension recommendation maps in `product.json` are pruned and audited in
   CI.** `extensionRecommendations`, `configBasedExtensionTips`,
   `exeBasedExtensionTips`, `languageExtensionTips`, `keymapExtensionTips`,
   `remoteExtensionTips`, `webExtensionTips` all inherit Marketplace IDs.
   Shipping them unpruned against a different registry is precisely the
   namespace-squatting vector used against four major forks in late 2025. Our
   build **fails** if a recommended ID does not resolve with a claimed namespace.
   See `scripts/audit-gallery-recommendations.mjs`.
4. **We document the substitution table prominently** rather than letting users
   discover a broken language server.

### Substitution table

| Unavailable (Microsoft-licensed) | Substitute | Assessment |
| --- | --- | --- |
| Pylance | basedpyright | Good. Set `typeCheckingMode: off` for similar behavior. |
| C# Dev Kit | SharpLsp | Reasonable. The base C# extension is MIT; only Dev Kit is restricted. |
| .NET debugger (`vsdbg`) | netcoredbg | Weaker but functional. |
| Remote - SSH | open-remote-ssh | Works; needs `serverDownloadUrlTemplate` wiring. |
| Dev Containers | open-remote-devcontainer | **Immature.** No Compose, no `features`. |
| Copilot / Copilot Chat | Adze itself | n/a |
| Live Share | — | **No substitute. A genuine gap.** |

We publish this table with the honest assessments above, including the two entries
where the answer is "this is worse."

## Alternatives considered

**Point at the MS Marketplace anyway** — rejected. Prohibited by §2(b) and §3,
enforced in practice, and it would make the project legally indefensible. Some
forks have done it; that is not a reason.

**Instruct users to sideload VSIX files manually** — rejected. §2(b) prohibits
*use*, not merely gallery installation, and §3 covers manual acquisition
explicitly ("whether automated or not"). A workaround that relies on users
violating terms is not a strategy.

**Build our own gallery from scratch** — rejected for v1. We would only need a
handful of endpoints, and we would launch with an empty store.

**Depend on `open-vsx.org` directly** — rejected. Simplest, and it inherits a
single point of failure with a documented incident history, plus no ability to
claim namespaces.

**Proxy chain across multiple galleries** — rejected. `product.json` supports one
`serviceUrl`, so this means patching gallery resolution and then owning conflict
resolution when an ID exists in two registries. That is an attack surface, not
just a bug surface.

## Consequences

**Good.** Legally clean and defensible. ~17,000 extensions is enough for most
workflows. Self-hosting gives availability control and namespace authority. The
CI audit closes a live vulnerability class that shipped in four commercial
products.

**Bad.** Users lose Pylance, C# Dev Kit, Dev Containers, and Live Share. Roughly a
4× download-volume gap suggests some long-tail extensions are simply absent.
Self-hosting is real infrastructure: Postgres, Elasticsearch, a Redis cluster.

**Costs we accept.** **Users whose workflow depends on Dev Containers or Live
Share should not use the Adze IDE**, and we will say that in the docs rather than
letting them find out. They can still use the Adze *extension* inside real VS
Code, which is one reason the extension ships first.

## Revisit when

- Microsoft changes the Terms of Use. Re-read before every major release.
- `open-remote-devcontainer` matures enough to move off the "immature" row.
