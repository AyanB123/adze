# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private reporting: **[Report a vulnerability](https://github.com/AyanB123/adze/security/advisories/new)**.
If that is unavailable to you, email **security@adze.dev**.

Please include: what you found, how to reproduce it, the affected version or
commit, and what an attacker gains. A proof of concept helps a great deal.

**What to expect.** Acknowledgement within 72 hours. An initial assessment with
a severity judgement within 7 days. We will tell you our intended fix and
disclosure timeline, and we will credit you in the advisory unless you ask us not
to. If we disagree that something is a vulnerability we will explain why rather
than going quiet.

We do not currently run a paid bounty program. We will say so plainly rather than
implying one exists.

## Supported versions

Adze is pre-1.0. Only the latest release on `main` receives security fixes. Once
we reach 1.0 this section will list a real support window.

## Threat model

An AI coding agent is an unusually attractive target: it reads your entire
codebase, holds provider credentials, and executes commands. Being specific about
what we defend against — and what we do not — is more useful than a general
assurance.

### What Adze defends against

**Agent-initiated destructive actions.** Every tool call passes a permission gate
before execution. The gate combines a sandbox mode (`read-only`,
`workspace-write`, `full-access`) with an approval policy (`untrusted`,
`on-request`, `never`) and an explicit set of writable roots. Escalation is
always an explicit user decision, never an inference from context. There is no
code path that bypasses the gate, including for built-in tools.

**Prompt injection reaching the shell.** Content the agent reads — source files,
web pages, tool output, MCP responses — is untrusted input and is treated as
data, not instruction. Commands proposed after reading untrusted content are
still subject to the same gate. We do not claim to *detect* prompt injection;
we claim that a successful injection still cannot execute an unapproved command.

**Credential exfiltration.** Provider credentials are held by the model gateway
and never placed in the model's context, tool arguments, or trajectory logs.
Benchmark and trajectory artifacts are scrubbed before they are written.

**Silent file corruption.** The three-tier edit applier validates that a file
still parses after an edit, and refuses the edit rather than writing a broken
file. This is a correctness feature that is also a security feature: a corrupted
build script is a code-execution vector.

**Malicious plugins, partially.** Plugin hooks and context providers run under a
timeout and, where the plugin ships as WebAssembly, inside a WASM sandbox. MCP
servers are subprocesses and are sandboxed like any other subprocess.

### What Adze does not defend against

Stated plainly, because a threat model that claims everything is worthless.

- **A model that is simply wrong.** Approving an edit means you accept it. Review
  diffs.
- **A plugin you explicitly grant `full-access`.** Granting full access is
  granting full access. We surface what is being asked for; we cannot make the
  decision safe.
- **A compromised model provider.** If your provider is malicious, it controls
  what the agent proposes. The permission gate limits blast radius; it does not
  eliminate it.
- **Native plugin code you install deliberately.** WASM plugins are sandboxed.
  Native ones are not, and we label them as such.
- **Windows sandboxing, today.** This is a known gap across the entire
  open-source agent ecosystem, not just Adze. On Windows the permission gate and
  approval policy still apply, but there is no OS-level containment yet. See
  [ADR-0007](docs/architecture/adr/0007-sandbox-and-permissions.md). We would
  rather document this than let you assume otherwise.

## Supply chain

The extension-marketplace ecosystem has had real, recent, in-the-wild incidents,
and Adze's design responds to specific ones.

**Install scripts are denied by default.** `pnpm-workspace.yaml` carries an
`onlyBuiltDependencies` allowlist. Adding a package that needs a postinstall
script requires review, because a postinstall script is the cheapest possible
supply-chain attack.

**Extension recommendations are audited in CI.** VS Code forks ship
recommendation maps in `product.json` inherited from the Microsoft Marketplace.
Pointed at a different registry, those become recommendations for publisher
namespaces that nobody has claimed — which is exactly how researchers were able
to target users of Cursor, Windsurf, Antigravity, and Trae in late 2025. Our
build fails if any recommended extension ID does not resolve on our gallery with
a claimed namespace. See `scripts/audit-gallery-recommendations.mjs`.

**Invisible-Unicode scanning.** The first self-propagating worm on Open VSX hid
its payload in invisible Unicode characters, so reviewers saw blank lines. We
scan for non-printable and bidirectional-control characters in source and in
plugin manifests, and treat a hit as a build failure rather than a warning.

**Publishing uses OIDC, not long-lived tokens.** Releases are published from CI
via trusted publishing with npm provenance attestations. No long-lived
publish token exists to steal.

**Licenses are scanned, not assumed.** `pnpm licenses:check` runs in CI against
an explicit allowlist. GitHub's license API reports `NOASSERTION` for a number of
packages whose actual licenses range from perfectly fine to categorically
unusable, so the LICENSE file gets read rather than the API field trusted.

## Disclosure

We prefer coordinated disclosure. Default embargo is 90 days or until a fix
ships, whichever comes first. If a vulnerability is being actively exploited we
will move faster and say so. Advisories are published on the GitHub Security
Advisories page with a CVE where warranted.
