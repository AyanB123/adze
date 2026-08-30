# `@adze/sandbox`

OS-level containment behind Adze's permission gate.

`@adze/core` decides **whether** a command may run. This package decides **what it can
touch** once running — on the platforms where that is possible, and it states plainly
where it is not. The two stay separate because ADR-0007 keeps them separate: a sandbox
exists to reduce approval fatigue, and collapsing the two axes means the only way to get
fewer prompts becomes less containment.

```ts
import { createSandbox } from '@adze/sandbox';

const { broker, plan } = await createSandbox({
  sandbox: { mode: 'workspace-write', writableRoots: [workspaceRoot] },
});

// Hand `broker` to PermissionGateOptions.broker in a surface. It satisfies core's
// SandboxBroker structurally, so there is no adapter and no change to core.
//
// plan.enforcement is 'os-level' only where it genuinely is.
// plan.degradations lists everything that will not be enforced.
```

## What is enforced, by platform

| Platform | Filesystem | Network | Subprocess tree | Reported |
| --- | --- | --- | --- | --- |
| macOS with `sandbox-exec` | writes outside the writable roots denied | denied | contained | `os-level` |
| Linux with usable `bwrap` | read-only bind, roots bound writable | denied | contained | `os-level` |
| Docker (opt-in) | only mounted paths exist | denied | contained | `os-level` |
| **Windows** | **nothing** | **nothing** | lifetime only, via `taskkill` | `gate-only` |
| anything else | **nothing** | **nothing** | lifetime only | `gate-only` |

The **syscall surface is unrestricted in every row.** These mechanisms contain an agent
doing damage; they are not a boundary against code actively trying to escape. Every plan
carries that as a degradation rather than leaving it to be assumed.

## Windows: exactly where the line falls

ADR-0007 records that no open-source coding agent has a working sandbox on Windows. This
package does not change that. It does say precisely what it does and does not do.

**Applied today:**

- argv-array spawning, so no `cmd.exe` ever sees a metacharacter
- process-tree teardown on timeout and cancellation, via `taskkill /T /F`
- a credential-scrubbed environment
- `windowsHide`, so a spawned process cannot steal focus
- policy refusals — a `forbid` prefix rule and an approval policy of `never` — before
  anything spawns

**Not applied. Not partially, not approximately: not at all.**

- **No restricted token.** `CreateRestrictedToken` plus `CreateProcessAsUser` has no Node
  binding. The child runs with the full rights of the current user.
- **No job object.** No CPU, memory, handle, or breakaway limit, and no
  kernel-guaranteed tree kill.
- **No AppContainer.** It needs `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` in
  `STARTUPINFOEX`, which `child_process.spawn` cannot express. There is therefore **no
  filesystem isolation and no network isolation.**
- **Windows Sandbox is detected and deliberately unused for `exec`.** It is a real
  VM-backed boundary and it hands back no exit code, no stdout, and no stderr, so a
  broker built on it would report success for every command including the ones that
  failed. `buildWindowsSandboxConfig` generates a `.wsb` for a human to use by hand.

`WindowsBroker.enforcement()` returns `gate-only` for both containment modes, and no
combination of inputs makes it return `os-level`. `WindowsContainmentHelper` is the
interface a native broker — ADR-0002 permits a Rust sidecar — plugs into, and supplying
one is the only thing that will ever change that answer.

## Honesty rules this package is built around

- **A plan cannot claim `os-level` while admitting a containment gap.** That is enforced
  by how the plan is constructed, not by a rule someone has to remember.
- **Found is not the same as works.** Capability detection reports `verified: false`
  unless a mechanism was actually run. Finding `/usr/bin/bwrap` proves a file exists.
- **Unavailable degrades with the specific reason.** "No OS-level containment" is not
  actionable; "`bwrap` is installed but `/proc/sys/kernel/unprivileged_userns_clone` is
  0" is.
- **Network fails closed.** When a per-host allowlist is requested and the mechanism is
  all-or-nothing, access stays denied and the unhonoured allowlist is reported. Denying
  more than requested breaks a fetch, which is a bug report; allowing more is a hole
  nobody notices.

## The two axes

Sandbox mode says what is permitted. Approval policy says when the user is asked.

| Mode | Filesystem | Network |
| --- | --- | --- |
| `read-only` | read within the workspace, write nothing | denied |
| `workspace-write` | write within `writableRoots` | denied unless allowlisted |
| `full-access` | unrestricted | unrestricted |

| Policy | Behaviour |
| --- | --- |
| `untrusted` | approve every action |
| `on-request` | approve only what the sandbox would block **(default)** |
| `never` | never prompt; **refuse** rather than escalate |

`never` cannot escalate structurally: `planFor` takes no approval-policy argument, so the
boundary is not a function of the policy and no policy value can widen it. The broker
re-checks `never` and `forbid` even though the gate already ran, because the safe response
to a possible gate bug upstream is not to run the command.

Command-prefix rules (`allow` / `prompt` / `forbid`) let `npm test` be permitted without
widening the boundary. The longest matching prefix wins, so `git push` can override a
broader `git` rule.

`read-only` genuinely cannot build most projects, because it writes nothing — including
`/tmp`. That is the mode working as specified rather than a defect.

## Git worktrees

`worktreeAddArgs`, `createWorktree`, and `removeWorktree` support cheap isolation of
parallel agents. **A worktree is not a security boundary** — it is a second checkout
running as the same user with the same rights. What it solves is two agents interleaving
edits in one checkout. Combined with writable roots set to that worktree, an agent's
*intended* writes are confined to it, which is containment from the permission model
rather than from git. Every worktree is created detached, because a worktree on a branch
claims it exclusively and two agents asked to work on `main` would collide.

## Docker

A complete broker, never a default, even when Docker is installed. ADR-0007 rejects a
container prerequisite because it is a documented adoption barrier for someone trying a
CLI on a laptop. It requires `enabled: true` and an image name, both written explicitly.

## Dependencies

None. Node builtins only.

The seam types mirror core's `SandboxBroker` structurally rather than importing it,
because a service package may not import `@adze/protocol` and core's seam is written in
terms of protocol's types. The cost is that nothing type-checks the mirror against the
original; see the comment at the top of `src/types.ts`.

## Reference

- `docs/architecture/adr/0007-sandbox-and-permissions.md` — the decision this implements
- `docs/architecture/adr/0002-*` — permits a native sidecar for the Windows work
- `SECURITY.md` — the threat model
