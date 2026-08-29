# 0012 — Apache-2.0, DCO, no open-core split

**Status:** Accepted
**Date:** 2026-08-29
**Deciders:** @AyanB123

## Context

Licensing and governance decide whether contributors trust the project enough to
invest in it. This category gives us an unusually direct evidence base, because
several projects made these choices and then demonstrated the consequences.

**What happened to the ones that reserved rights:**

- Sourcegraph took Cody private; the archived public snapshot flags a specific
  commit as "the last one made under an Apache License." Free and Pro tiers ended
  2025-07-23.
- Continue used an Apache-derived CLA, was acquired, and wound down.
- Roo Code shut down with paying users, leaving a billing address in an archived
  README.

**What the survivors chose:** Void, Continue, Cline, and goose picked Apache-2.0;
opencode, Kilo Code, and OpenHands picked MIT. Nobody thriving picked a
source-available license.

**A trap worth naming.** One popular Go CLI in this space is FSL-1.1-MIT —
source-available with a **two-year non-compete** before MIT conversion. It has
~28k stars and a `LICENSE.md` that does not look restrictive at a glance. Building
a competing product means we cannot use it at all. GitHub's license API reports
`NOASSERTION` for that project *and* for several perfectly usable ones, so the API
field cannot distinguish the fatal case from the fine ones.

**Open-core carve-outs are inheritable by accident.** Several otherwise-permissive
repos separately license an `ee/` or `enterprise/` subdirectory.

**MCP itself is mid-relicense** from MIT to Apache-2.0, following its donation to
a Linux Foundation body: new code Apache-2.0, docs CC-BY-4.0, un-relicensed
contributions still MIT, with an explicit note that no rights beyond the original
license are conveyed. Three licenses in one dependency tree.

## Decision

### Apache-2.0 for everything

Apache-2.0 over MIT for two specific clauses, not by habit:

- **§3, express patent grant.** Contributors grant patent rights covering their
  contributions. In a space this dense with patent activity, MIT's silence is a
  real gap.
- **§6, trademark disclaimer.** Explicitly separates copyright license from
  trademark rights, which matters when the project name is the thing that must be
  protectable.

**No open-core split, ever.** No `ee/`, no `enterprise/`, no feature withheld for
a paid tier. The whole product is Apache-2.0.

### DCO, never a CLA

A `Signed-off-by` line asserting the right to submit. Copyright stays with the
contributor.

A CLA would let a future owner relicense — including closing the project — which
is exactly what happened above. **We give up easy relicensing on purpose, because
that is the credible signal**, and a project competing on openness cannot ask
contributors to sign away the thing it is selling.

The cost is real and accepted: relicensing Adze later would require contacting
every contributor.

### License hygiene in CI from commit one

- `pnpm licenses:check` against an **explicit allowlist**: Apache-2.0, MIT, BSD-2/3,
  ISC, Unlicense, CC0, BlueOak, Python-2.0.
- **Denylist**, failing the build: GPL family, AGPL, LGPL (for linked code),
  EPL-2.0, MPL-2.0 (case-by-case), SSPL, BUSL, FSL, Commons Clause, "source
  available", `UNLICENSED`.
- **`NOASSERTION` is not a verdict.** A human reads the LICENSE file and records
  the finding in `NOTICE`.
- Subdirectory carve-outs checked when vendoring any subtree.

### Attribution discipline

`NOTICE` records both copied code and **design-level derivations** — the sandbox
permission model, the edit-format taxonomy, the cache-epoch approach, the
two-container benchmark isolation, the patch-series build. None involve copied
code. Crediting the idea is both correct and cheap, and it tells contributors
where to read further.

### Governance built for succession

Details in [GOVERNANCE.md](../../../GOVERNANCE.md). The load-bearing parts: publishing
credentials in the org rather than a personal account; an explicit six-month
abandonment clause letting any committer fork and claim the name; and **donation to
a neutral foundation as an intended outcome.** Every choice here — Apache-2.0,
DCO, no CLA, clean provenance, written decisions — exists partly to keep that
possible.

### Trademark

Adze's name and logo are held by the project. "Built on Adze" and "compatible with
Adze" are fine; implying endorsement or naming a fork "Adze" is not. A formal
policy modeled on Rust's lands before 1.0. Registry availability is not trademark
clearance, and a USPTO/EUIPO class-9 search happens before 1.0.

## Alternatives considered

**MIT** — genuinely close. Shorter, more permissive, chosen by the largest project
in this category. Rejected only for the patent grant and trademark disclaimer.

**AGPL-3.0** — rejected. It would prevent a competitor from taking the code closed,
which is superficially attractive. But it is incompatible with the plugin ecosystem
we need, poisonous for embedding — which is the entire product thesis — and
disqualifying for most corporate contributors.

**Open core (Apache-2.0 plus a paid `ee/`)** — rejected. The obvious business
model, and the one that damaged trust in several comparable projects. Also
structurally at odds with "extensible without forking".

**BUSL or FSL** — rejected. Not open source. It would forbid exactly what we are
doing to someone else, which makes the project's positioning incoherent.

**CLA for enterprise indemnification** — rejected. If it ever becomes genuinely
necessary we would use the Apache ICLA verbatim and explain why publicly, rather
than a custom agreement. Not now.

## Consequences

**Good.** Contributors keep their copyright and know the project cannot be closed
from under them. Patent grant protects users. No license-boundary confusion.
Foundation donation stays available. License CI prevents the FSL-shaped accident.

**Bad.** Relicensing is effectively impossible. Anyone may take Adze and build a
proprietary product on it — including a competitor. No obvious revenue path from
the license.

**Costs we accept.** **A competitor can commercialize our work.** That is the
deal, and the deal is what makes contribution rational. And we forgo the
open-core revenue model, which is the standard answer here and has a poor record
in this specific category.

## Revisit when

- Foundation donation becomes concrete — that may require specific license or IP
  hygiene work, and it is a good problem.
- A dependency's relicensing forces an attribution change.
- **Not** when someone proposes open core. That requires the 14-day public
  process in GOVERNANCE.md, and this ADR is the standing answer.
