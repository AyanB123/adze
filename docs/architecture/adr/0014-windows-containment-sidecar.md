# 0014 — Windows containment via a Rust sidecar behind the existing seam

**Status:** Proposed
**Date:** 2026-09-09
**Deciders:** @AyanB123

## Context

Windows is the one platform where Adze has no path to OS-level containment
today, and it is our own primary development platform. [ADR-0007](0007-sandbox-and-permissions.md)
accepted that position honestly — the gate and approval policy apply, there is
no OS-level containment — and named a Rust broker sidecar as roadmapped work
with its own ADR. [ADR-0002](0002-language-and-runtime.md) permits Rust for
exactly three things, the Windows sandbox broker first among them, and
requires each sidecar to justify its process boundary in its own ADR
(plan item `N13`). The roadmap's M8 exit criteria require a shipped Windows
sandbox broker, and call the gap ecosystem-wide: no open-source agent has a
working Windows sandbox, with the only prior art a Rust crate inside a
competitor's CLI. This record is that ADR. It changes no behavior; it states
the direction so the implementation is checkable against it.

**Why `child_process.spawn` cannot get there, with the mechanism named.**

Node's `child_process.spawn` calls `CreateProcess` with the current token and
offers no parameter for anything else. The three Windows primitives that would
confine a command are therefore unreachable, each for a specific reason
(Microsoft Learn: "CreateRestrictedToken", "Job Objects",
"AppContainer isolation"; Node.js docs: `child_process.spawn` options):

- **Restricted token.** `CreateRestrictedToken` (deny-only SIDs, privilege
  stripping) plus `CreateProcessAsUser` has no Node binding. The child runs
  with the agent's full token, so it can do anything the user can do.
- **Job object.** `CreateJobObject`, `SetInformationJobObject`, and
  `AssignProcessToJobObject` have no Node binding. No CPU, memory, or handle
  limits, no breakaway denial, and no kernel-guaranteed tree kill. What
  `packages/sandbox/src/windows.ts` does instead — `taskkill /T /F` on
  timeout — bounds *lifetime* on a best-effort basis and nothing else.
- **AppContainer.** Isolation requires an AppContainer SID and capability
  list passed through `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` in a
  `STARTUPINFOEX` attribute list (`InitializeProcThreadAttributeList` /
  `UpdateProcThreadAttribute`). `spawn` cannot express `STARTUPINFOEX`, so
  there is no filesystem isolation and no network isolation.

The path checks in `@adze/sandbox` are arithmetic on strings: they stop the
engine from writing where it should not, never the subprocess. Windows Sandbox
(a `.wsb` via `WindowsSandbox.exe`) is a real VM-backed boundary that hands
back no exit code, stdout, or stderr, so a broker built on it would report
success for every command including failures — worse than no sandbox, and
already rejected in `windows.ts`. `buildWindowsSandboxConfig` stays a
human-use generator, not an `exec` path.

## Decision

**A first-party Rust helper binary, integrated exclusively through the
existing `WindowsContainmentHelper` seam, that earns each confinement flag it
reports. Everything else stays exactly as it is.**

Concretely, and each point is review-checkable:

1. **The sidecar implements the three primitives above**: a restricted token
   (deny-only SIDs, privilege removal), a job object (resource limits,
   breakaway denial, kill-on-close for a kernel-guaranteed tree kill), and an
   AppContainer profile (SID plus a curated capability list) for filesystem
   and network isolation.
2. **The seam does not move.** `packages/sandbox/src/windows.ts` already
   defines the contract: `confinesFilesystem`, `confinesNetwork`,
   `supportsNetworkAllowlist`, `confinesSubprocessTree`, and a `wrap` that
   returns an argv array or `{ error }`. Landing the helper is a new crate
   plus one constructor argument. `policy.ts`'s honesty clamp is untouched:
   `os-level` requires no `containment`-scope degradation plus a filesystem
   boundary that survives into grandchildren, so the helper's own flags
   decide the claim and nothing else can inflate it.
3. **argv-array spawn is kept.** The helper's `wrap` returns `{ file, args }`
   and never constructs a shell string; `programNameRefusal` still applies.
   No `cmd.exe` ever sees a metacharacter, before or after this lands.
4. **Refusal stays refusal.** A helper that cannot express a plan returns
   `{ error }` and the broker refuses with `mechanism-unavailable` rather
   than running the command under a weaker boundary. This is the same
   fail-closed discipline as the network-allowlist rule: breaking a fetch is
   a bug report, silently widening a boundary is a hole.
5. **`taskkill` teardown is retained as the helper-absent fallback.** With a
   helper present the job object owns tree kill; without one, lifetime
   bounding via `taskkill /T /F` is still the only reachable mechanism, and
   the `windows-no-job-object` degradation keeps saying so.
6. **`adze doctor` stays `gate-only` until the helper lands.** This ADR
   changes no enforcement string, no degradation text, and no doctor output.
   The three Windows degradations (`windows-no-restricted-token`,
   `windows-no-job-object`, `windows-no-appcontainer`) remain the accurate
   report, and `on-request` keeps prompting for every command, until a
   reviewed helper genuinely provides the boundary it claims.
7. **Syscall confinement is explicitly out of scope, now and after.** The
   sidecar confines through token integrity, job limits, and AppContainer
   ACLs — not syscall filtering. There is no seccomp/Seatbelt-call-filter
   equivalent in this design, so the syscall surface stays unrestricted on
   every platform, Windows included. Plans carry that as an explicit
   degradation, consistent with the roadmap's first stated gap. The threat
   model is an agent doing damage, not code actively trying to escape
   through a kernel exploit.

**The process-boundary justification ADR-0002 demands.** The boundary is
forced by the OS interface, not by language preference: the required
process-creation attributes cannot be expressed from Node at all, so the
code that sets them must live in a process that calls the Win32 API
directly. Out-of-process (rather than an in-process addon) isolates a
helper crash or handle leak from the extension host, and avoids the native
rebuild matrix across Electron ABI × OS × arch that ADR-0002 cites for
preferring sidecars over addons. The helper is first-party Rust under the
same license discipline as everything else — no new runtime dependency, no
vendored binary, license review at implementation time per the existing
dependency rules.

## Alternatives considered

### Node FFI / N-API addon calling advapi32 and kernel32 directly — rejected

Reintroduces the exact cost ADR-0002 prices out: a native addon rebuilt
across Electron ABI × OS × arch, inside the extension host process, where a
crash or leaked handle takes down the surface rather than failing one
command. FFI into process-creation security attributes from JavaScript also
widens the memory-safety and supply-chain surface (a foreign-function
bridge plus the native libraries it loads) while still needing the same
`STARTUPINFOEX` plumbing the sidecar does — it saves no design work and
spends robustness to do it. An out-of-process helper that speaks argv over
a pipe is duller, and dull is the point.

### PowerShell constrained endpoints / JEA — rejected

Needs per-machine administrator provisioning, which is the same adoption
barrier ADR-0007 already rejects for Docker-as-default: a containment story
that requires setup before the first command is not the default path. The
guarantees are also version- and configuration-dependent (language-mode
bypass history is real), and an endpoint still launches native binaries
under the user token with no job-object or AppContainer boundary around
arbitrary executables. Per-command endpoint sessions add latency for less
confinement than the sidecar, with weaker argv and exit-code fidelity than
the broker contract needs.

### Vendored prebuilt sandbox binaries — rejected

A third-party executable we did not compile is a supply-chain dependency we
cannot review line by line, with provenance to verify per release, version
skew against OS behavior to track, and the project's install-script and
`onlyBuiltDependencies` discipline to satisfy — for something that still
needs the identical seam integration on our side. It saves no design work
while adding a trust dependency at the most sensitive layer in the system.
First-party Rust keeps the boundary auditable end to end, under the same
DCO and license review as the rest of the tree.

(Windows Sandbox wired into `exec` is not re-litigated here: `windows.ts`
and ADR-0007 already reject it — no exit code, no stdio — and nothing since
has changed that interface.)

## Consequences

### Good

- Closes an ecosystem-wide gap the roadmap names as an M8 requirement, on
  the maintainers' own primary platform — unusually visible work that no
  competitor has shipped in the open.
- The honest-reporting architecture is unchanged: the gate, `policy.ts`,
  and the protocol need no modifications, and `os-level` on Windows becomes
  earnable through the same clamp that governs every other mechanism.
- argv discipline and fail-closed refusal survive the transition; no shell
  string is constructed at any point, and an inexpressible plan refuses
  rather than weakening silently.
- The helper-absent path (today's broker, `taskkill` fallback, three
  degradations) keeps working untouched, so the sidecar can land
  incrementally behind detection rather than as a flag day.

### Bad

- A second toolchain, a second build matrix, and distribution weight: the
  helper must ship with the CLI and the extension on Windows and be found
  at runtime, which is packaging work with no TS equivalent to copy.
- Per-command spawn overhead through a broker process; to be measured, not
  assumed, against the agent loop's latency budget.
- AppContainer capability curation is ongoing, unglamorous work: too tight
  breaks legitimate builds, too loose is theater, and the right set drifts
  as toolchains change.
- Windows-only native code that CI must exercise — the real-containment
  tests skip on machines without the mechanism, so coverage depends on the
  Windows runner actually running them.

### Costs we accept

- **Maintaining Rust alongside TypeScript**, the cost ADR-0002 pre-approved
  for exactly this sidecar and no other current work.
- **No syscall filtering**, stated in the decision rather than discovered
  later: a kernel-exploit escape is outside the threat model, on Windows as
  everywhere else.
- **Continued `gate-only` reporting until the helper is reviewed and
  landed.** The weaker guarantee stays visible in `doctor` for as long as
  it is true, because implying protection that is not there is the failure
  ADR-0007 exists to prevent.

## Revisit when

- The helper lands with real-containment tests running on the Windows CI
  runner. That implementation — not this record — is what moves the
  enforcement claim, and its landing gets a follow-up ADR that supersedes
  ADR-0007's Windows-gap paragraph. This record is superseded by nothing
  and supersedes nothing.
- The upstream sandbox runtime ADR-0007 builds on adds Windows support.
  Adopting it would make a first-party sidecar unnecessary — a good
  outcome, and ADR-0007 already names it.
- Windows gains a scriptable per-command sandbox with exit-code and stdio
  fidelity (or Node gains `STARTUPINFOEX` / job-object bindings), which
  would remove the reason the boundary lives out-of-process.
