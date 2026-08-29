# 0007 — Two-axis permission model; Windows containment as a known gap

**Status:** Accepted
**Date:** 2026-08-29
**Deciders:** @AyanB123

## Context

An agent that runs commands needs containment. The design failure to avoid is
**approval fatigue**: prompt for everything and users click through blindly,
which is worse than not prompting because it manufactures false confidence.

The best current design in this space separates two things that are usually
collapsed together: *what the process is allowed to do* (a sandbox) and *when the
user is asked* (a policy). Codex configures these independently —
`read-only` / `workspace-write` / `danger-full-access` crossed with
`untrusted` / `on-request` / `never`, plus explicit writable roots and
command-prefix rules — and states plainly that the sandbox exists to reduce
approval fatigue. That framing is correct and we adopt it.

**Platform reality, checked:**

| Platform | Mechanism | Availability |
| --- | --- | --- |
| macOS | Seatbelt (`sandbox-exec`) | Mature. Contains the whole subprocess tree. |
| Linux | bubblewrap | Mature. Needs unprivileged user namespaces; AppArmor friction on some Ubuntu releases. |
| **Windows** | — | **No OSS agent has a working sandbox.** The only prior art is a Rust crate inside a competitor's CLI. |

There is an Apache-2.0 sandbox runtime purpose-built for this, covering Seatbelt
and bubblewrap with proxy-based network filtering, explicitly designed to also
sandbox MCP servers. It does not cover Windows.

## Decision

**Two orthogonal axes, an explicit writable-root list, command-prefix rules, and
an honest statement about Windows.**

### Sandbox mode — what is permitted

| Mode | Filesystem | Network |
| --- | --- | --- |
| `read-only` | read within workspace, write nothing | denied |
| `workspace-write` | write within `writableRoots` | denied unless allowlisted |
| `full-access` | unrestricted | unrestricted |

### Approval policy — when the user is asked

| Policy | Behavior |
| --- | --- |
| `untrusted` | approve every action |
| `on-request` | approve only what the sandbox would block **(default)** |
| `never` | never prompt; **refuse** rather than escalate |

`never` refusing rather than escalating is deliberate. A policy that silently
grants more than it says would make the whole model untrustworthy.

### Command-prefix rules

`allow` / `prompt` / `forbid` on command prefixes, so `npm test` can be permitted
without widening the sandbox boundary for everything.

### Implementation

- macOS and Linux: adopt the Apache-2.0 sandbox runtime rather than writing
  Seatbelt profiles and bubblewrap plumbing ourselves.
- **Windows: the gate and approval policy apply, but there is no OS-level
  containment.** The CLI and extension say so explicitly at startup when running
  in `workspace-write` on Windows. We will not let a user infer containment that
  does not exist.
- Git worktrees for cheap isolation of parallel agents.
- Docker as an escape hatch, never a default — a Docker requirement is a
  documented adoption barrier for laptop users.

### Windows containment is roadmapped as a differentiator

This is a gap across the entire open-source agent ecosystem. Closing it is
unusually visible work, and the maintainers of this project develop on Windows.
Approach under evaluation: a Rust broker sidecar using restricted tokens, job
objects, and AppContainer, with Windows Sandbox where available. It gets its own
ADR.

## Alternatives considered

**Docker-first for everything** — rejected as a default. Maximum portability and
a real adoption barrier: it is a heavyweight prerequisite for someone who wants to
try a CLI. Supported, not required.

**Single "safety level" dial** — rejected. Collapsing the axes is exactly what
produces approval fatigue, because the only way to reduce prompts becomes reducing
containment.

**Prompt for everything** — rejected. Trains users to click through, which is a
worse security posture than a well-chosen default.

**No sandbox, warnings only** — rejected. That is what "the agent deleted my
files" stories are made of.

**Firecracker / gVisor** — rejected for local use. Right answer for cloud agents,
wrong weight class for a laptop. Reconsider if we ship a hosted runner.

## Consequences

**Good.** Low approval friction without giving up containment, on the two
platforms where containment is available. Reusing a maintained Apache-2.0 sandbox
avoids writing security-critical code we are not best placed to write. Prefix
rules let teams encode real policy.

**Bad.** Windows users get a weaker guarantee than macOS and Linux users, and we
have to say so repeatedly. Two axes take longer to explain than one dial. Sandbox
setup on Linux has real distro-specific friction.

**Costs we accept.** **Shipping with a documented security gap on our own primary
development platform**, because the alternative is implying protection that is not
there. And a permission model that requires a paragraph of documentation rather
than a single toggle.

## Revisit when

- The Windows broker lands. This ADR gets superseded.
- The upstream sandbox runtime adds Windows support, which would make our work
  unnecessary — a good outcome.
