---
'@adze/sandbox': minor
---

Add OS-level containment behind the permission gate.

`@adze/core` decides whether a command may run; this package decides what it can touch
once running. Every broker satisfies core's `SandboxBroker` structurally, so wiring one
in is a constructor argument in a surface and no change to core.

**macOS** uses Seatbelt through `sandbox-exec`. Writes outside the declared writable
roots and all network access are denied for the process and every descendant, because a
Seatbelt profile is inherited across `fork` and `exec` — so `bash` running `npm install`
running a postinstall script running `curl` is one boundary rather than four. The profile
starts from `(allow default)` and denies writes and network rather than enumerating every
operation a toolchain performs, because a `(deny default)` profile produces build failures
that look like bugs in the user's project and gets switched off.

**Linux** uses bubblewrap. The filesystem is bound read-only in a fresh mount namespace
with the writable roots bound back, and the network namespace is unshared. Availability
is detected rather than assumed: `bwrap` on `PATH` plus
`/proc/sys/kernel/unprivileged_userns_clone` and `/proc/sys/user/max_user_namespaces`,
with the Ubuntu 23.10+ AppArmor restriction on unprivileged user namespaces reported as a
caveat. When it is unusable the broker degrades to no containment with the specific
sysctl named, rather than crashing or claiming a boundary the first `bwrap` call would
disprove.

**Windows gets no filesystem or network containment, and the code says so.** What is
applied: argv-array spawning so no `cmd.exe` ever sees a metacharacter, process-tree
teardown through `taskkill /T` on timeout and cancellation, a credential-scrubbed
environment, and policy refusals before spawn. What is not applied, at all: a restricted
token, a job object, and an AppContainer, because `CreateRestrictedToken`,
`AssignProcessToJobObject`, and `STARTUPINFOEX` security capabilities have no Node
binding. `enforcement()` returns `gate-only` for both containment modes and no input can
make it return `os-level`. `WindowsContainmentHelper` is the seam a native broker plugs
into and is the only thing that will ever change that answer. Windows Sandbox is detected
and deliberately not used for `exec`: it returns no exit code, stdout, or stderr, so a
broker built on it would report success for commands that failed.

Docker is a complete broker and is never selected automatically, even when installed —
ADR-0007 keeps it an escape hatch because requiring a container runtime is an adoption
barrier. Git worktrees are supported for cheap isolation of parallel agents and are
documented as not being a security boundary.

Every plan carries the complete list of what will **not** be enforced, and a plan cannot
report `os-level` while admitting a containment gap — that is a property of how the plan
is constructed, not a rule someone has to remember. Network is denied by default under
`read-only` and `workspace-write`; when a per-host allowlist is requested and the
mechanism cannot express one, access stays denied and the unhonoured allowlist is
reported, because failing closed breaks a fetch while failing open is a hole nobody
notices.

`never` refuses rather than escalating, and the boundary is not a function of the
approval policy at all — the plan builder takes no policy argument — so no policy value
can widen it. The broker re-checks `never` and `forbid` even though the gate already ran,
because the safe response to a possible gate bug upstream is not to run the command.
