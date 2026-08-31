# Plan

What to work on next, and why in this order.

## How to use this document

Four documents divide the work of steering this project, and they do not overlap:

| Document | Answers |
| --- | --- |
| [`roadmap.md`](roadmap.md) | Where the code is, and what each milestone means |
| [`architecture/adr/`](architecture/adr/) | Why each decision was made, and what it forbids |
| [`benchmarks/strategy.md`](benchmarks/strategy.md) | What may be published as a number |
| **this document** | What to do next, in what order, and what not to do |

Every item below carries an id (`P0.1`, `D3`, `N7`). Cite them in commit bodies,
issues, and pull requests — `Refs plan P0.2` — so the reasoning behind a change
stays reachable after the branch is merged.

This document does **not** restate progress. The verified state of every package
lives in the roadmap's state table, and duplicating it here would produce a second
number to keep in sync. What lives here is the part the roadmap deliberately does
not carry: judgement about ordering.

**When this goes stale.** Section [§1](#1-verification) records how it was
verified. Anything in [§3](#3-discrepancy-ledger) is either fixed or still true —
check before trusting it. The priorities in [§4](#4-priorities) assume the ledger;
if the ledger changes materially, re-derive them rather than working down a list
whose premises moved.

---

## 1. Verification

Verified **2026-08-30** on Windows (win32 10.0.26200, Node 25.5.0, pnpm 10.20.0)
by running `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:plugins`, and
`pnpm bench:apply`, and by reading source rather than documentation for every
claim in [§3](#3-discrepancy-ledger).

Two limits on that verification, stated because they change what it is worth:

- **Windows only.** The four real-containment tests in `@adze/sandbox` skip here,
  as does anything needing Seatbelt or bubblewrap. CI covers macOS and Ubuntu.
- **No model was called.** Nothing here verifies the `run` or `chat` path
  end-to-end. See [`D8`](#3-discrepancy-ledger).

---

## 2. The pattern worth naming

Four separate audits of this repository converge on the same shape, and it is more
useful than any of the four findings individually.

**This project builds and documents components well, and loses them at the wiring
seam.** In each case below the code exists, is tested, is honestly commented, and
is unreachable from anything a user runs:

| Component | Built | Reachable from a user-run path? |
| --- | --- | --- |
| `@adze/sandbox` | 16 files, ~2,965 lines, Seatbelt + bubblewrap + Docker | **No.** No package declares a dependency on it. |
| `publication.ts`, `statistics.ts` | 6 exported functions, unit-tested | **No.** The report pipeline imports none of them. |
| `leakage.ts` | 3 of 6 assertions, 20 tests | **No** — and correctly so. Unlike the three rows above, this one has no input to check until a Tier-2 adapter exists; wiring it now would return clean on every run. See [`P1.3`](#p13--leave-the-leakage-assertions-unwired-until-there-is-data-to-check). |
| `validator: 'tree-sitter'` | Declared in 4 schemas and a CLI switch | **No.** No code produces it; 0 grammars present. |

The individual fixes are in [§4](#4-priorities). The systemic response is
[`P1.5`](#p15--add-a-reachability-test-for-declared-capability): a test that asks
whether a declared capability is reachable, so the fifth instance is caught by CI
rather than by an audit.

Why this matters more than it looks: every one of these is *documented honestly at
the source*. `report-policy.ts` explains why it does not call the comparison gate.
`wasm.ts` explains that its default runtime refuses to load. The code is candid.
The failure is that candour at the module level does not aggregate into an accurate
statement about the product, and the top-level documents are where a reader looks.

---

## 3. Discrepancy ledger

Where a document and the code disagree. Severity is about what a reader would
wrongly believe, not about effort.

| id | Claim | Where | Reality | Severity |
| --- | --- | --- | --- | --- |
| **D1** | Seatbelt, bubblewrap and Docker "report `os-level`" | `roadmap.md` §gaps, M1 table | True of the package, **false of the product**. Nothing wires `@adze/sandbox`; the CLI builds core's `NodeSubprocessBroker`, which is `gate-only` on every platform by construction. | **Critical** — a false security claim |
| **D2** | "no OS-level containment on any platform, because `@adze/sandbox` contains no code" | `README.md`, `docs/architecture/README.md`, `guides/README.md`, `guides/embedding.md` | Right conclusion, wrong reason. The package has ~2,965 lines. The reason is that nothing consumes it. | High |
| **D3** | "twelve ADRs" | `roadmap.md` M0, `README.md` | **Thirteen.** ADR-0013 is committed, Accepted, and indexed. | High |
| **D4** | "no platform ships OS-level containment today" | ADR-0013 Context | Contradicts ADR-0007's platform table. Describes the *product* correctly, but asserts a platform-support fact ADR-0007 denies — inside an accepted decision record. | High |
| **D5** | `validator: 'tree-sitter'` is a producible outcome | `apply/src/types.ts`, protocol schema, 2 bench schemas, CLI switch | Unreachable. No code path emits it, and 0 grammar `.wasm` files exist outside `node_modules`. The project's own rule is that this field is "a claim about evidence". | High |
| **D6** | "Two of them are asserted today" | `benchmarks/strategy.md` §leakage | Fixed. Its own table two lines below marked **three** rows Asserted; both were written in the same commit. The prose had counted the two functions rather than the three rows they cover. | Medium |
| **D7** | `@adze/plugin-sdk`, `@adze/sdk`, `@adze/mcp`, `apps/vscode` empty or in progress | `README.md`, `docs/architecture/README.md` | All landed. `README.md` also reports **904 tests** against a verified 2,003. | Medium |
| **D8** | M1's exit criterion is met | `roadmap.md` M1 | Met as written, and honestly bounded to "one task, one model, one platform" — but the evidence is a narrative in a commit body. **No trajectory artifact is committed**, so the run is not reproducible from this repository. | Medium |
| **D9** | `edit.pre` cannot see whole-file content; police it on `tool.pre` | `guides/plugins.md` | Fixed. The guide now teaches the exact pattern this repo's own post-mortem identifies as the bug that made `adze.secrets-guard` miss a credential. | Medium |
| **D10** | `apps/ide` "Empty — no source" | `roadmap.md` state table | 26 tracked files: 9 pipeline scripts, 6 placeholder patches, branding fixtures. `apps/ide/README.md` is candid about all of it. | Low |
| **D11** | `apply-bench` has 50 cases / "~200 synthetic edits" | `roadmap.md`, `README.md`, `benchmarks/strategy.md` | **51.** Three of four references were not updated when case 51 landed. `benchmarks/strategy.md` is fixed and now points at `pnpm bench:list` for the live count; `roadmap.md` and `README.md` still say 50. | Low |
| **D12** | "enforced by a dependency-cruiser check in CI" | `docs/architecture/README.md` | No dependency-cruiser anywhere in the repo. The five package-dependency rules are review-enforced only. | Low |
| **D13** | `docs/` contains "research digests" | `README.md` | `docs/research/` is empty and untracked. Every ADR cites unnamed studies with no bibliography. | Low |
| **D14** | `apps/hub` is a workspace package | `pnpm-workspace.yaml` | Empty directory, zero files. `bench/suites/nep-bench` likewise. `plugins/*` is declared as a workspace glob while CI documents that plugins are deliberately *not* workspace packages. | Low |

---

## 4. Priorities

### P0 — before anything else

#### P0.1 — Correct the sandbox claim

The roadmap tells a reader that an approved command on macOS is confined to the
writable roots. It is not. Under this project's honesty rules a false claim about
the security posture outranks every other defect here, and it is cheap to fix.

Correct [`D1`](#3-discrepancy-ledger) and [`D2`](#3-discrepancy-ledger) together,
because the two say opposite things and both are wrong: the package exists **and**
the product has no containment. `guides/getting-started.md` already states this
correctly and is the model to copy.

- **Done when** every document states the same thing: brokers exist and are
  tested, no surface wires them, the shipped CLI is `gate-only` everywhere.
- **Governed by** ADR-0007. **New ADR** no. **Changeset** no (docs only).
- **Size** small.

#### P0.2 — Wire `@adze/sandbox` into the CLI

Makes [`P0.1`](#p01--correct-the-sandbox-claim)'s corrected statement obsolete in
the right direction. The package's own README says the wiring is a constructor
argument in a surface with no change to core, and `setup.ts` already accepts a
`broker` override that nothing supplies — so this is plumbing, not design.

This is the single largest quantity of built, tested, unreachable capability in
the repository, and it is the product promise.

- **Done when** `adze doctor` reports `os-level` on macOS and on Linux with
  usable bubblewrap, Windows still reports `gate-only` with its three named
  degradations, and the real-containment tests exercise the wired path.
- **Governed by** ADR-0007, which anticipated this. **New ADR** no. **Changeset**
  yes: approved commands become confined, which is user-visible and can turn a
  previously working command into a refusal.
- **Decided** ([§7](#7-decisions-taken)): now, on by default, before any publish.
- **Size** medium. Cannot be fully verified on Windows; needs CI or a macOS/Linux
  host.

#### P0.3 — Fix the ADR count and ADR-0013's premise

[`D3`](#3-discrepancy-ledger) and [`D4`](#3-discrepancy-ledger). A stale count is
trivial. The ADR-0013 sentence matters more: an accepted decision record asserts a
platform-support fact that ADR-0007 denies. Its argument only needs "prefix rules
are load-bearing on `gate-only` platforms", so narrow the sentence without
touching the decision.

- **Done when** both counts say thirteen and ADR-0013's Context no longer
  contradicts ADR-0007.
- **New ADR** no — narrowing a Context sentence is not a reversal. **Changeset** no.
- **Size** small.

### P1 — next

#### P1.1 — Make `validator: 'tree-sitter'` producible

[`D5`](#3-discrepancy-ledger), and **decided**: build it, rather than narrowing the
type or documenting the gap.

ADR-0005 already committed to this — "**With tree-sitter grammars present:** a real
parse. Reject on error nodes." So it is an unfinished decision, not a new feature,
and needs no new ADR. Today `'tree-sitter'` appears in `packages/apply/src` on
exactly one line: the type declaration.

Three facts shape the implementation. `web-tree-sitter` is already in the
`catalog:` block, so nothing new enters the dependency graph. Grammars resolve from
a configured directory rather than being vendored — `$ADZE_GRAMMAR_DIR`, else
`<root>/.adze/grammars` — so apply can follow the same convention with no
duplicated files. And `@adze/apply` cannot import `@adze/retrieval`'s loader,
because service packages must not import each other.

1. `web-tree-sitter` as apply's first dependency, via `catalog:`.
2. A loader in apply: lazy `await import('web-tree-sitter')`, the same grammar
   directory convention, and **failed loads cached** — retrieval's discipline,
   because retrying a missing grammar turns one absent file into a filesystem miss
   on every edit.
3. A new **async** validation entry that parses when a grammar is available and
   rejects on error and missing nodes. `validate()` stays synchronous and
   structural-only, so the existing public export keeps its shape; `applyEdit` is
   already async and can await the new path.
4. `'tree-sitter'` returned **only** when a parse actually completed. No grammar
   means `structural`; unknown language means `none`.
5. Tests: grammar-present cases gated the way retrieval gates its two, so they skip
   loudly rather than silently; a case proving a broken edit is rejected with
   `validator: 'tree-sitter'`; a case proving the no-grammar path never reports it;
   and a meta-test that no source file hardcodes the value. Assert on `validator`,
   not only on `ok`.

**What this does not do**, and the plan should not imply otherwise: on a clone with
no grammar files, validation still returns `structural`. The fix makes the variant
*earnable*, which is the honesty problem. Whether it fires depends on the operator
having grammars, exactly as retrieval already behaves. Vendoring grammars is a
separate question carrying repo weight and a per-language licence review, and
retrieval already declined it.

- **Governed by** ADR-0005. **New ADR** no. **Changeset** yes — `'tree-sitter'`
  becomes producible and a new validation entry point is public.
- **Size** medium.
- **Follow-up, not now:** if apply's and retrieval's loaders drift, extract the
  shared "load runtime, resolve grammar, cache it" piece into a package both
  depend on. That is a boundary change needing its own ADR, so it waits until the
  duplication is real rather than anticipated. Node caches the `web-tree-sitter`
  module itself, so two loaders is wasteful rather than incorrect.

#### P1.2 — Unblock a third-party plugin author

`plugins/FINDINGS.md` finding 3, ranked by the audit as the worst of the eight
open findings. `docs/plugins/spec.md` mentions neither `runtime` nor
`allowUnsandboxedJs`, yet the loader refuses `runtime: 'js'` without the flag and
refuses WASM by default. **Every procedural plugin that can run today needs a host
flag the spec never mentions.** Compounding it: the spec advertises
`adze plugin add` and `adze plugin dev`, neither of which exists, and its example
manifest pins `engines.adze` to a range the SDK does not satisfy.

M3's exit criterion is a third party shipping a plugin unaided. Today they hit
three blockers before their first successful load.

- **Done when** an author can follow the spec alone to a loading plugin, or the
  spec states plainly what is not yet possible.
- **Governed by** ADR-0008. **New ADR** no. **Changeset** only if the loader
  changes.
- **Size** medium. Also fix [`D9`](#3-discrepancy-ledger) here — the live guide
  teaches the pre-fix workaround.

#### P1.3 — Leave the leakage assertions unwired until there is data to check

**Answered, not done, and the item is now the record of why.** The original wording
asked for a run that invokes the assertions and fails on a violation. That cannot be
done honestly against the suite that exists.

`checkPromptLeakage` needs a dataset record and the payload assembled from it.
`checkHistoryIsolation` needs a prepared repository and the base commit it is supposed
to sit at. `apply-bench` has none of the four: hand-written edits applied to strings
in memory, with no task record, no prompt and no checkout. Calling them anyway returns
`ok` on every run — an empty payload trips no field guard, and a record with no `patch`
field leaks no patch lines — which is the appearance of enforcement without the
substance. This repository has already corrected that mistake twice: `8202946` fixed
three source comments claiming enforcement no caller reached, and `report-policy.ts`
declines to call `compareToBaseline` on absent data for the identical reason. A third
instance would be self-inflicted.

Two alternatives were considered and rejected:

- **Gate the report policy on leakage-audit evidence when `inputSource` is not
  `synthetic`.** Needs a new `BenchReport` field, and `report-policy.ts` states that a
  Tier-2 report will have a different shape — so the field would be added to the Tier-1
  shape to guard a condition only an absent shape can reach. It would also be the
  weakest rule in that gate: every other one compares two things present in the same
  artifact, and a leakage field would carry a claim with nothing beside it to check the
  claim against.
- **Construct a task record inside the runner so there is something to check.** Rejected
  for the same reason as wiring the calls directly. It would measure a fixture, which
  `bench/harness/test/leakage.test.ts` already does against real git repositories, and
  print the result as though it had measured a run.

What did land is the status, stated where a reader looks for it: `leakage.ts` says
plainly that nothing calls it and what each function waits for, `strategy.md` says what
"Asserted" does and does not mean, `report-policy.ts` records the rejected gate, and
every generated `audit.md` restates per run that the assertions had no input — so the
gap is visible in the artifact rather than only in a document.

- **Done when** an adapter loads a task record and prepares a repository, and calls the
  assertions where the payload is built, before it is handed over. Not in `runSuite`,
  which will never be the code that assembles a prompt.
- **Blocked on** Harbor and a dataset, not on effort. See [§6](#6-sequencing).
- **Governed by** ADR-0011. **New ADR** no. **Changeset** no (`bench/` is private).
- **Size** small once the input exists.

#### P1.4 — Emit `audit.md`, and fix the count contradiction

**Done 2026-08-31.** `writeRun` writes all five files the policy names; `audit.md` is
generated by `bench/harness/src/audit.ts` and tested in
`bench/harness/test/audit.test.ts`. Its content for `apply-bench` is mostly a statement
of what does not apply and why — there is no borrowed task set to audit for broken
tasks, and no leakage assertion has an input — plus the part that is real: case count,
the refusal reasons the run exercised, which validator levels ran and which did not, and
the severe-failure count. Applicability is derived from the report's `inputSource`, so
the exemptions become obligations rather than going stale.

[`D6`](#3-discrepancy-ledger) is closed. [`D11`](#3-discrepancy-ledger) is closed in
`benchmarks/strategy.md` only; `roadmap.md` and `README.md` still say 50 cases.

One thing found on the way: the five git-backed tests in
`bench/harness/test/leakage.test.ts` were flaking as timeouts on a loaded machine, with
a different set of victims each run. Each builds a five-commit repository and clones it,
which does not fit vitest's five-second default. Fixed by budgeting that block
explicitly; no assertion changed.

#### P1.5 — Add a reachability test for declared capability

The systemic response to [§2](#2-the-pattern-worth-naming). Four instances of
built-and-unreachable were found by hand; the fifth should be found by CI.

Cheapest useful form: assert that each package's public entry point transitively
reaches its documented capabilities, and that a declared union variant has a
producer. `packages/retrieval/test/invariants.test.ts` is the existing precedent.
This also gives [`D12`](#3-discrepancy-ledger) somewhere to live, since the
dependency rules are currently review-enforced despite a document promising CI.

- **Size** medium. Highest leverage per line in this list.

### P2 — worth doing, not urgent

- **P2.1** — Refresh `README.md` and `docs/architecture/README.md`
  ([`D7`](#3-discrepancy-ledger)). Both are badly stale; `README.md` is the first
  thing a stranger reads and it undercounts tests by more than half. Deferred
  below P1 only because it misleads *downward* — it undersells a working project
  rather than overselling a broken one.
- **P2.2** — Declare an authoritative source. Three status tables disagree and
  nothing marks one canonical. Point the others at the roadmap.
- **P2.3** — `pnpm-workspace.yaml` declares three globs that resolve to nothing
  ([`D14`](#3-discrepancy-ledger)).
- **P2.4** — A bibliography for the ADRs ([`D13`](#3-discrepancy-ledger)). Every
  ADR cites "a published study found" with no source. For a project whose
  positioning rests on evidence, a skeptic currently has nothing to follow.
- **P2.5** — `scripts/check-licenses.mjs` detects `AND`/`OR` with `\b` and splits
  on `\s+`. Making them agree would split `AGPL-3.0-or-later` and could turn a
  build failure into a pass on the strongest copyleft licence in the denylist. Add
  the comment that says so before someone tidies it.
- **P2.6** — Commit a trajectory for the M1 run ([`D8`](#3-discrepancy-ledger)).
  **Decided** ([§7](#7-decisions-taken)): capture one. No artifact exists, so it
  needs a fresh `adze run --json` against a real key.

---

## 5. Do not do this

Nineteen non-negotiables live across thirteen ADRs with no consolidated list, so a
contributor would have to read all thirteen to learn that a helpful-looking change
reverses a decision. This is that list. **Reversing any of these requires a new ADR
that supersedes the old one** — not a commit.

Ordered by how much the reversal looks like progress.

| id | Constraint | ADR | Why the reversal is tempting |
| --- | --- | --- | --- |
| **N1** | **Do not build a benchmark harness.** Harbor owns the containers; we build adapters. | 0011 | M5 lists "two-container isolation — not started" and three leakage rows read like a to-do list. Writing container orchestration to close them is a reversal, not progress. |
| **N2** | **Never relax matching past indentation tolerance.** The ladder is exact → whitespace-normalized → indentation-tolerant → anchored and stops. | 0005 | Every `not-found` refusal argues for one more strategy. Trigram or token-similarity would raise apparent success and silently apply wrong edits. |
| **N3** | **Ambiguity is an error, never a guess.** | 0005 | Taking the first of several matches is the single change that would most improve the numbers, and is named "the single worst thing this package could do". |
| **N4** | **No JSON-in-a-string tool-calling fallback.** A provider without native tool calling is `degraded`. | 0004 | Supporting a popular local model. Reintroduces a measured 7.3% tax. |
| **N5** | **Approval policy `never` refuses; it does not escalate.** | 0007 | Avoiding a failed run. ADR-0013 records that the live run only proceeded via an explicit `--allow`, so the pressure is real. |
| **N6** | **A plugin-supplied tool must never set `requested` itself.** | 0013 | Plugin surfaces have landed, making this the nearest live tripwire. Explicitly requires its own ADR. |
| **N7** | **Tier-3 fast-apply is never a hard dependency.** | 0005 | Making a fast-apply provider the default breaks local-first. |
| **N8** | **No network call for retrieval without explicit opt-in.** | 0006 | A default remote embedding provider when vectors land. |
| **N9** | **No private back channel between a surface and the engine.** | 0001 | Named as "the temptation that destroys the architecture". |
| **N10** | **No plugin UI in the engine.** | 0001, 0008 | |
| **N11** | **Never a vendored merged fork of upstream**, and never rebase onto each tag. | 0010 | |
| **N12** | **No tree search, planner/executor split, or reflection in the core loop.** | 0003 | Reopening needs a controlled experiment beating baseline by more than 3 points. |
| **N13** | **Each Rust sidecar needs its own ADR.** | 0002 | The Windows containment helper is the first legitimate one. |
| **N14** | **No open-core split, ever** — and *not* revisited because someone proposes one. | 0012 | Routes to GOVERNANCE.md's process. |
| **N15** | **DCO, never a CLA.** | 0012 | |
| **N16** | **Never a paid hub**; no registry service in v1. | 0008 | |
| **N17** | **Never touch `marketplace.visualstudio.com`**, and do not tell users to sideload VSIX files — §2(b) prohibits *use*. | 0009 | |
| **N18** | **No aggregator citations, ever.** No best-of-N headline. The Tier-1 smoke-slice number is never published. | 0011 | |
| **N19** | **`pass@1`, mean ± SEM over ≥3 attempts, never max-over-N.** | 0011, 0003 | |

---

## 6. Sequencing

**Why the sandbox goes first.** It is the only item that is simultaneously a false
claim, a missing product capability, and already-written code. Fixing the claim
([`P0.1`](#p01--correct-the-sandbox-claim)) costs an hour and removes a security
misstatement. Wiring the package ([`P0.2`](#p02--wire-adzesandbox-into-the-cli))
makes the honest version obsolete in the direction that helps users. Doing the
claim first is deliberate: if the wiring turns out to be harder than it looks, the
documents are already correct rather than waiting on it.

**Why plugin authoring beats polishing the README.** M2's remaining criterion is
publishing to a gallery; M3's is a third party shipping a plugin unaided. A
stranger who installs the extension and tries to write a policy hook hits
[`P1.2`](#p12--unblock-a-third-party-plugin-author) immediately. A stale
`README.md` costs credibility; an unusable plugin surface costs the milestone.

**Why the reachability test is worth more than any single fix it would catch.**
[`P1.5`](#p15--add-a-reachability-test-for-declared-capability) is the only item
that changes the *rate* at which this class of defect appears. Everything else in
[§2](#2-the-pattern-worth-naming) is one instance.

**What is blocked on something other than effort:**

| Item | Needs |
| --- | --- |
| Verifying [`P0.2`](#p02--wire-adzesandbox-into-the-cli) | A macOS or Linux host, or CI |
| Wiring the leakage assertions ([`P1.3`](#p13--leave-the-leakage-assertions-unwired-until-there-is-data-to-check)) | A task record and a prepared repository — so Harbor and a dataset. Not effort. |
| Tier-2 benchmarks, and the comparison and max-over-N gates | Harbor, a dataset, model keys, a container runtime |
| Windows containment | A Rust sidecar and its own ADR ([`N13`](#5-do-not-do-this)) |
| A published number | Everything in [`benchmarks/strategy.md`](benchmarks/strategy.md)'s artifact list |

---

## 7. Decisions taken

Recorded so the reasoning survives, and so a later reader can tell a settled
question from an open one.

1. **Wire the sandbox now, on by default, before any gallery publish.** Nothing is
   published, so no user gets a behaviour change, and Windows is `gate-only` either
   way — the confined paths are verified by CI on macOS and Ubuntu rather than
   locally. [`P0.2`](#p02--wire-adzesandbox-into-the-cli).
2. **Make `validator: 'tree-sitter'` real, rather than narrowing the type or
   documenting the gap.** ADR-0005 already committed to a real parse when grammars
   are present, so the variant is an unfinished decision rather than an
   overstatement to retract. The two rejected options are worth recording: removing
   the variant from the protocol schema would have to be re-added later, and
   documenting it at the declaration site would leave a declared outcome no code
   can reach. [`P1.1`](#p11--make-validator-tree-sitter-producible).
3. **Capture a trajectory for the M1 run.** No artifact exists, so this needs a
   fresh `adze run --json` against a real key — which the maintainer has and CI does
   not. Until it lands, M1's claim rests on a narrative in a commit body.
   [`P2.6`](#p2--worth-doing-not-urgent).

One judgement inside decision 2 is worth flagging for whoever implements it. The
rule is that `validator` reports *the level that actually ran*, and since no result
ever carries `'tree-sitter'` today, nothing currently misreports — the defect is
that the type advertises a capability, not that a claim is false. That is why
building it is the proportionate answer and why deleting the variant would have
been a retreat from ADR-0005 rather than a correction to it.

---

## 8. The single highest-value next action

**Wire `@adze/sandbox` into the CLI** — [`P0.2`](#p02--wire-adzesandbox-into-the-cli),
after the one-hour claim correction in [`P0.1`](#p01--correct-the-sandbox-claim).

It converts roughly 2,965 lines of tested, unreachable code into the product's
stated security posture; it is the only item on this list that closes a gap
between what the documents promise and what a user gets on the security axis; the
design work is already done and recorded in ADR-0007; and the package was
deliberately built so the wiring is a constructor argument in a surface with no
change to the engine.
