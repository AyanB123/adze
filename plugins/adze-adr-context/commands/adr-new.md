---
name: adr-new
description: Draft an architecture decision record in this repository's format
tools: [read, grep, glob]
model: { prefer: reasoning }
---

Draft a new architecture decision record for the decision I am about to describe.

The existing records, so the number is right and the format matches:

!`ls docs/architecture/adr`

Read @adr for the house style before you write. Match it rather than a generic ADR
template — this repository's records argue a position with evidence, and a record that
only states a conclusion is not useful to the person who finds it in two years.

First, decide whether an ADR is warranted at all. One is required when the change:

- alters a boundary between packages, or what a package may import;
- changes the protocol in a way surfaces must adapt to;
- adds an outbound network call, a dependency with security surface, or an install script;
- changes the permission model, the sandbox contract, or the applier's matching or
  validation behaviour;
- changes what is published as a benchmark claim;
- **reverses an earlier decision.**

If none of those hold, say so and name the existing record the change follows instead
(`Refs ADR-0005.`). A record for a change that already had one dilutes the set.

If a record is warranted, write it as `docs/architecture/adr/00NN-<kebab-title>.md` with:

**Status, Date, Deciders.**

**Context.** With evidence. Numbers, incidents, prior art, and what other projects in
this space did and what happened to them. A context section that only describes the
problem in the abstract cannot be argued with, and being arguable is the point.

**Decision.** What is being decided, stated so a reader can tell whether a future change
violates it.

**Alternatives considered.** Each one named, with why it was rejected. This is the
section that has value later: the reader in two years wants to know whether their idea
was already considered.

**Consequences**, split into good, bad, and costs we accept. The last is not optional.
A decision with no accepted cost has not been examined.

**Revisit when.** The condition that would justify reopening it. A record with no exit
condition becomes permanent by inertia rather than by merit.

If this decision reverses an earlier one, the new record supersedes it: say which, and
mark the old one `Superseded by NNNN` rather than deleting it. Deleting the record of a
decision we changed our mind about is how a project loses the ability to explain itself.

Do not write the file. Print it for me to review first.
