# ADR Bibliography

The ADRs lean on outside evidence — audits, leaderboards, project histories,
vendor documentation. This file lists, per ADR, which of those a skeptic can
actually follow. Three labels:

- **Named** — the ADR names the source. Follow it.
- **Project-observable** — checkable in a public repository or public document
  without a citation: tags, commit history, star counts, license texts.
  Snapshots of counts are dated to the ADR (2026-08-29/30); they have moved
  since.
- **Unnamed** — the ADR reports a measurement without naming the study. The gap
  is recorded here instead of reconstructed. Do not quote these numbers
  externally without finding the source first, and do not guess which paper or
  post they came from.

New ADRs cite sources by name and add them here with the decision.

## ADR-0001 — Engine-first, multi-surface architecture

- Project-observable: the fates table (Void archived 2026-06-02, Roo Code shut
  down 2026-05-15, Continue acquired and wound down, Sourcegraph Cody
  repository privatized with the free tier ending 2025-07-23, Aider quiet since
  2026-05-22) and the star counts on both sides are GitHub-observable facts.
  Same for Void's continuation ecosystem peaking near ~230 stars.
- No external empirical studies cited.

## ADR-0002 — TypeScript for the engine, Rust reserved for sidecars

- Project-observable: the language reference points (opencode, Gemini CLI,
  Cline, Continue in TypeScript; Codex CLI in Rust; OpenHands with a Python
  engine behind a REST boundary to a TypeScript/Electron GUI) and the ecosystem
  facts (MCP SDK, AI SDK, `web-tree-sitter` ESM-first; TypeScript 7 currency).
- No external empirical studies cited.

## ADR-0003 — Minimal linear turn machine

- Unnamed: the controlled harness swap holding the model fixed (six
  open-weight models, aggregate differences not significant at p > 0.05,
  solve-set overlap 42% for strong models and 7% for weak ones, ~55% token
  efficiency gap at 1.89 versus 1.22 solves per million completion tokens).
- Unnamed: the minimal reference harness (~100 lines, bash-only, stateless
  subprocess, above 74% on SWE-bench Verified, used as the neutral harness by
  the official leaderboard, independent evaluators, and at least one frontier
  lab).
- Unnamed: the "independent analysis" putting scaffold headroom at 11–15
  points against a weak baseline.
- Unnamed: the public edit-format benchmark behind the 52.0% → 88.0% test
  feedback measurement (shared with ADR-0005's "same benchmark").

## ADR-0004 — Bash-first tools with native tool calling

- Unnamed: the harness measurement behind the 7.3% invalid-JSON rejection
  rate on open-weight rollouts (up to four rejections in one run).
- Unnamed: the roughly 12-to-1 vision-capable versus text-only gap on
  image-bearing tasks.
- Same unnamed minimal reference harness as ADR-0003 for the >74% figure.

## ADR-0005 — Three-tier edit applier

- Unnamed: the public edit benchmark behind 88.0% pass / 91.6% well-formed /
  ~8.4% malformed from the best model, and behind the 52.0% → 88.0% retry
  measurement (the ADR's "that same benchmark" ties it to ADR-0003's).
- Unnamed: the commercial fast-apply vendor claims (10,000+ tokens/second,
  around 98% success) and the quoted characterization of deterministic
  approaches as brittle and model-specific.
- Unattributed: the argument that fast-apply is transitional because frontier
  labs optimize against diff-editing benchmarks.

## ADR-0006 — Local-first hybrid retrieval

- Named: Cursor's own documentation for the backend behavior (chunk upload
  for embeddings, plaintext not persisted, embeddings plus file names and
  hashes retained, user-supplied keys still routing through the backend for
  server-side prompt assembly).
- Project-observable: the dependency facts (LanceDB as the maintained
  embedded vector option with a Node binding, ripgrep's Unlicense status,
  `web-tree-sitter` avoiding native rebuilds).
- Unattributed: the synthesis that agentic grep plus symbol lookup
  outperforms vector search on most repositories.

## ADR-0007 — Two-axis permission model

- Named: Codex's configuration and documentation for the separated sandbox
  versus policy axes and the approval-fatigue framing.
- Unnamed: the Apache-2.0 sandbox runtime described as purpose-built for
  Seatbelt and bubblewrap with proxy-based network filtering including MCP
  servers — identified by license and function, not by project name.
- Unattributed: the survey claim that no open-source agent has a working
  Windows sandbox and the only prior art is a Rust crate inside a
  competitor's CLI.

## ADR-0008 — Six plugin surfaces

- Named: the MCP project (settled tool standard, official registry,
  reference server collection, foundation governance), Zed's extension model
  (git repository plus manifest, declarative-first, `wasm32-wasip2`,
  PR-reviewed index), Obsidian (GitHub releases as distribution at scale).
- The registry-as-business-model failure record rests on ADR-0001's history.
- Unnamed: the Open VSX incident reports (super-admin publish-token
  vulnerability at ~10M+ developers affected, invisible-Unicode worm,
  namespace squatting aimed at users of four major forks).

## ADR-0009 — Open VSX only

- Named: Microsoft's Visual Studio Marketplace Terms of Use (§2(b), §3, the
  2025 tightening adding "import" and "reverse-engineer"), Microsoft's FAQ
  naming Code-OSS forks, the retracted 2016 comment, and the April 2025
  C/C++ extension enforcement in Cursor and other forks.
- Named: Open VSX for the scale figures (~17,000 versus ~48,000 extensions,
  600M+ downloads/month, 1.0.0 in June 2026, adoption by VSCodium, Cursor,
  Windsurf, and AWS Kiro).
- License texts: Code-OSS MIT scope, EPL/GPL incompatibility noted via
  ADR-0002.
- Unnamed: the late-2025 namespace-squatting incidents against four major
  forks.
- Authors' own assessment: the substitution table (basedpyright, SharpLsp,
  netcoredbg, open-remote-ssh, open-remote-devcontainer, Live Share gap) —
  our testing, no external source.

## ADR-0010 — Patch series plus Agent Host Protocol

- Project-observable: the release cadence (monthly through 1.111.0 on
  2026-03-06, 1.112.0 on 2026-03-17, roughly weekly since) is readable from
  the upstream vscode git tags.
- Named: the upstream Agent Host Protocol specification (published
  2026-08-26, client libraries in Rust, TypeScript, Kotlin, Go, and Swift).
- Authors' own measurement: the per-file churn table over ~5.8 months and
  ~24 releases, with the method stated in the ADR — reproducible against
  upstream history, not a citable publication.
- Named: AWS Kiro as the Code-OSS plus Open VSX precedent; Eclipse Theia
  license facts (EPL-2.0, GPL-2.0-with-classpath-exception alternative).

## ADR-0011 — Adopt Harbor

- Named: OpenAI's 2026-02-23 SWE-bench audit (138 hard instances, at least
  59.4% broken — 35.5% unspecified implementation details, 18.8%
  unspecified functionality — every frontier model reproducing the gold
  patch verbatim) and OpenAI's 2026-07-08 retraction of its replacement
  recommendation (~30% of SWE-bench Pro's public split broken).
- Named: Anthropic's Claude Opus 5 launch materials (2026-07-24, zero
  SWE-bench numbers) and the SWE-bench Verified official leaderboard
  (newest entry 2026-02-26, topping out at 79.20%).
- Named: the SWE-rebench leaderboard for the Cursor comparison (51.7%
  ±0.84 at $0.41/problem, behind Claude Code at 60.4%, Codex at 58.0%,
  Junie at 61.8%) and Harbor for Harbor-Index (82 tasks distilled from
  6,627 across 54 benchmarks, no agent clearing 30%) and for the
  hardest-tasks audit (roughly one third broken).
- Deliberately unnamed: the SEO aggregator cluster (96%, 96.4%, 97.0%
  against the 79.20% official top). The ADR withholds the names on
  purpose; do not reconstruct them here.
- Unnamed: the published infrastructure-noise study behind the 3-point
  rule (6-point most-versus-least-resourced gap at p < 0.01, infra error
  rate 5.8% strict to 0.5% uncapped, time-of-day fluctuation, below-3-points
  skepticism recommendation). This is the load-bearing citation for the
  project's headline statistical rule, and it currently cannot be followed.

## ADR-0012 — Apache-2.0, DCO, no open-core split

- Project-observable: the project histories (Cody privatization with the
  "last Apache commit" marker and 2025-07-23 tier end, Continue's
  Apache-derived CLA plus acquisition and wind-down, Roo Code's shutdown
  with paying users) and the license choices of the survivors.
- Project-observable but deliberately unnamed: the FSL-1.1-MIT Go CLI
  (~28k stars, two-year non-compete, GitHub reporting NOASSERTION for it
  and for fine packages alike). Unnamed on purpose; do not name it here.
- Named: the MCP relicense notices (MIT toward Apache-2.0 under a Linux
  Foundation body, docs CC-BY-4.0, un-relicensed contributions still MIT).
- License texts: Apache-2.0 §3 and §6, and the incompatible families on
  the denylist.

## ADR-0013 — Command rules match the requested command

- No outside studies. The evidence is this repository's own live M1 run
  (the `forbid`/`allow` failures against shell-wrapped argv) and the gate
  documentation naming prefix rules as the remedy. It amends ADR-0007's
  mechanism, not its decision.

## ADR-0014 — Windows containment via a Rust sidecar

- Named: Microsoft Learn for the three blocking APIs ("CreateRestrictedToken",
  "Job Objects", "AppContainer isolation" including
  `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` in `STARTUPINFOEX`), and the
  Node.js `child_process.spawn` options documentation for what the current
  runtime cannot express.
- Project-observable: the `WindowsContainmentHelper` seam in
  `packages/sandbox/src/windows.ts` and the `gate-only` enforcement the
  broker reports without one.
- Unattributed: the survey claim inherited from ADR-0007 that no open-source
  agent has a working Windows sandbox.
