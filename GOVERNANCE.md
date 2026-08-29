# Governance

Adze is young. This document describes how it is run now and the conditions under
which that changes, rather than pretending a large formal structure already
exists.

## Current state: BDFL-ish, explicitly temporary

The project was started by [@AyanB123](https://github.com/AyanB123) and decisions
currently rest there. That is normal for a new project and it is also a
single point of failure, which is why the rest of this document exists.

## Principles

These are the commitments that outlast any particular maintainer.

**Apache-2.0 forever, on the whole product.** No open-core split, no `ee/`
directory, no feature held back for a paid tier. Several projects in this
category monetized by carving a directory out of the license; it damaged trust
and mostly did not save them.

**DCO, never a CLA.** No contributor is asked to sign away rights that would let
a future owner close the project. We accept that this makes relicensing hard on
purpose. See [CONTRIBUTING.md](CONTRIBUTING.md).

**The registry is not the business model.** Plugin distribution stays free and
unmetered. Monetizing the plugin hub is the failure mode that killed the closest
comparable project.

**Benchmark honesty over benchmark marketing.** The
[benchmark policy](docs/benchmarks/strategy.md) was written before the first
number existed so it cannot be quietly adjusted to fit a favorable result. It
includes a rule that costs us headlines — no claimed win inside 3 percentage
points — and that rule is not negotiable by a maintainer who wants a launch.

**Decisions get written down.** Anything architectural gets an ADR in
[docs/architecture/adr](docs/architecture/adr/), including the options rejected
and why. A new contributor should be able to reconstruct our reasoning without
asking anyone.

## Roles

**Contributor** — anyone who opens an issue or PR. No process to join.

**Committer** — merge rights on one or more areas. Earned by sustained,
good-quality contribution, typically several merged non-trivial PRs plus helpful
review of others' work. Existing committers nominate; a maintainer confirms.
Listed in `MAINTAINERS.md` once there is more than one.

**Maintainer** — release authority, security response, final call on
architecture. Nominated by existing maintainers, and the bar is judgement rather
than volume.

## How decisions get made

**Ordinary changes** — normal PR review. One committer approval for the area.

**Architectural changes** — an ADR PR first, then implementation. Discussion
happens on the ADR, so the reasoning is preserved where the next person will
look for it.

**Contested changes** — lazy consensus with a 72-hour window. If a committer
objects with a technical reason, the objection must be addressed rather than
outvoted. If it remains deadlocked, a maintainer decides and records the decision
and its rationale in an ADR.

**Anything touching the principles above** — requires a public issue with a
14-day comment period. These are commitments to the community, so the community
gets to see them being reconsidered before it happens, not after.

## Releases

Semantic versioning, changesets for changelog generation, published from CI via
OIDC trusted publishing. Pre-1.0, minor versions may break; that is what pre-1.0
means and we will say so in release notes rather than surprising anyone.

## The succession plan

An open-source project with one maintainer is one bus away from being abandoned,
and this category is littered with archived repositories. Concretely:

- Adze will move to multiple maintainers with independent release authority as
  soon as there are qualified candidates. This is a priority, not an aspiration.
- Publishing credentials and signing keys live in the GitHub organization, not in
  a personal account, so continuity does not depend on one person's access.
- If the project is ever unmaintained for six months, any committer may fork it
  and claim the name with the community's blessing. Apache-2.0 makes this legally
  trivial; saying it out loud makes it socially legitimate.
- **Donating Adze to a neutral foundation is an intended outcome, not a
  concession.** The Agentic AI Foundation at the Linux Foundation is the obvious
  venue — it is where MCP, goose, and AGENTS.md now live. We are not ready: a
  foundation needs a project worth governing first. Every choice here (Apache-2.0,
  DCO, no CLA, clean provenance, written decisions) is made so that this stays
  possible.

## Trademark

The Adze name and logo are held by the project. You may say your product is
"built on Adze" or "compatible with Adze". You may not use the name in a way that
implies official endorsement, and you may not name a fork "Adze". A formal
trademark policy modeled on Rust's will land before 1.0.

## Contact

Technical discussion belongs in issues and PRs — in public, where it is
searchable. Security reports go to security@adze.dev
([SECURITY.md](SECURITY.md)). Conduct concerns go to conduct@adze.dev
([CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)).
