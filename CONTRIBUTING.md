# Contributing to Adze

Adze is built in public. The parts most worth having are the parts we have not
written yet, so a first contribution is genuinely useful rather than ceremonial.

## The short version

```bash
git clone https://github.com/AyanB123/adze.git
cd adze
pnpm install
pnpm check          # lint + typecheck + test. Run this before you push.
git commit -s       # the -s is required. See "Sign-off" below.
```

## Sign-off: DCO, not a CLA

Every commit needs a Developer Certificate of Origin sign-off line:

```
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds it for you. Set `user.name` and `user.email` first.

**There is no contributor license agreement, and there will not be one.** This is
a deliberate, load-bearing decision rather than an oversight.

A CLA transfers or broadly licenses your copyright to the project owner, which
lets the owner relicense the project later — including closing it. Several
well-funded projects in exactly this category did precisely that: Sourcegraph
took Cody private and killed its free tier, and Continue was acquired and wound
down. Contributors were right to be wary.

A DCO asks something narrower and sufficient: you assert you have the right to
submit the code under the project's existing license. It leaves the copyright
with you. The cost to us is that relicensing Adze later would require asking
every contributor — which is the point. Read the full text at
<https://developercertificate.org/>.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/). The type prefix
drives changelog generation.

```
feat(apply): add indentation-tolerant search/replace matching
fix(core): stop double-counting cached input tokens in cost accounting
docs(adr): record the decision to use Open VSX over MS Marketplace
perf(retrieval): reuse the ripgrep process across queries in a turn
test(apply): add cases for models that emit trailing-whitespace drift
chore(deps): bump zod to 4.5.2
```

Scopes match package directory names: `protocol`, `core`, `providers`, `apply`,
`retrieval`, `sandbox`, `plugin-sdk`, `mcp`, `cli`, `sdk`, `vscode`, `ide`,
`hub`, `bench`, `docs`, `adr`, `ci`, `deps`.

Anything user-visible needs a changeset: `pnpm changeset`.

## Where help is most valuable

Ordered by how much difference a contribution makes, not by difficulty.

### 1. Edit-format reliability cases (`bench/suites/apply-bench`)

The failure users actually feel is a mangled file, not a wrong answer. Every case
you add to `apply-bench` becomes permanent regression protection for every model
we ever support. If you have seen a model produce an edit that broke a file,
that is a bug report *and* a test case — please add it.

This is the highest-leverage contribution in the repo and it needs no AI
expertise: a case is an input file, an edit instruction, and the expected result.

### 2. Plugins

The six plugin surfaces are specified in [docs/plugins/spec.md](docs/plugins/spec.md)
*before* the registry exists, on purpose. We do not actually know the right
extension points until real plugins exist and something turns out to be
impossible. Building a plugin and telling us what you could not do is the
feedback we most need right now.

### 3. Language coverage (`packages/retrieval`)

Symbol extraction and structure-aware chunking currently cover a starter set of
languages. Adding a language means a tree-sitter grammar plus a symbol query.
Self-contained, well-bounded, immediately useful.

### 4. Provider adapters (`packages/providers`)

Open-weight models reached frontier parity on coding benchmarks at a fraction of
the cost, which makes them strategically important to us rather than a fallback.
Adapters and cost tables for them are very welcome.

### 5. Windows sandboxing (`packages/sandbox`)

No open-source coding agent currently has a working Windows sandbox. This is a
genuine gap in the whole ecosystem and an unusually visible thing to have built.
See [ADR-0007](docs/architecture/adr/0007-sandbox-and-permissions.md).

## Architecture rules that reviews will enforce

These exist because violating them is how the codebase becomes unmaintainable,
and they are cheaper to enforce at review time than to fix later.

1. **The engine renders nothing.** `@adze/core` must not import from any surface
   package and must not emit terminal escapes, HTML, or markdown intended for
   display. It returns structured events. Surfaces render.

2. **Surfaces talk to the engine only through `@adze/protocol`.** If the CLI can
   do something the extension cannot, the protocol is missing a message. Add the
   message; do not add a private back channel.

3. **No plugin may inject UI into the engine.** UI extension happens in the
   surface. This is what keeps the CLI, the extension, and the IDE from
   diverging into three different products.

4. **Every tool call passes the permission gate.** No exceptions, including
   internal tools. The gate is the only thing standing between an agent and a
   user's filesystem.

5. **Nothing leaves the machine without an explicit opt-in.** Local-first is a
   product promise, and a network call added casually breaks it. Any new outbound
   request needs an ADR or an existing configured provider.

6. **Benchmark claims follow [the policy](docs/benchmarks/strategy.md).** It was
   written before we had any numbers so that it cannot be adjusted to fit one.
   No aggregator citations, no wins claimed inside 3 percentage points, and
   trajectories published for failures as well as passes.

## Reviewing and merging

- CI must be green: lint, typecheck, tests on Linux/macOS/Windows.
- New behavior needs a test. Bug fixes need a test that fails before the fix.
- Public API changes need the ADR updated or a new ADR.
- Maintainers squash-merge. Keep PRs focused; two small PRs beat one large one.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Code of Conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
