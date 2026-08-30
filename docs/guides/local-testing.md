# Running Adze locally, on Windows, without regretting it

Adze is pre-alpha. It has a `bash` tool and it writes to files. This guide is about
making that **recoverable** rather than making it convenient, because on Windows the
usual containment story does not apply and pretending otherwise would be the one
mistake with real consequences.

Read the caveat below before the instructions. It is the reason the rest of the guide
is shaped the way it is.

---

## The caveat: there is no sandbox on Windows

Per [ADR-0007](../architecture/adr/0007-sandbox-and-permissions.md), Adze has OS-level
containment on two platforms and not on the third:

| Platform | Mechanism | What contains an approved command |
| --- | --- | --- |
| macOS | Seatbelt | The kernel |
| Linux | bubblewrap | The kernel |
| **Windows** | **none** | **Nothing. Only the approval prompt, before it runs.** |

So on Windows the permission gate is a *decision point*, not a *boundary*. Every tool
call still passes through it — that part is real, and there is no code path around it —
but once you answer yes, the command runs with your full user rights. It can read your
documents, delete files outside the project, and reach the network.

**Treat an approval prompt exactly as you would treat pasting that command into your own
terminal.** That is not a figure of speech; it is a precise description of what happens.

`adze doctor` states this too, and the approval prompt repeats it once per turn. This is
a gap across the whole open-source agent ecosystem, not only Adze — which makes it more
important to say plainly, not less.

Because there is no kernel boundary, the safety of this setup rests on two things you
control: **a git commit to fall back to**, and **actually reading the prompts**.

---

## Install

One directory, two `.cmd` files, one entry appended to your **user** PATH. No
administrator rights, no global npm state, nothing written outside your profile.

Point `$repo` at your checkout:

```powershell
$repo   = "C:\path\to\adze"
$binDir = Join-Path $env:LOCALAPPDATA 'adze\bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# The safe launcher: restrictive defaults, refuses to run outside a git repo.
@"
@echo off
node "$repo\scripts\adze-safe.mjs" %*
exit /b %ERRORLEVEL%
"@ | Set-Content -Encoding ASCII (Join-Path $binDir 'adze.cmd')

# The CLI with stock defaults and no guards, for when you trust it.
@"
@echo off
node "$repo\packages\cli\bin\adze.mjs" %*
exit /b %ERRORLEVEL%
"@ | Set-Content -Encoding ASCII (Join-Path $binDir 'adze-raw.cmd')
```

Then add it to the user PATH. Read the **User** value specifically — `$env:Path` is the
machine and user values merged, and writing that back would copy the system PATH into
your user PATH permanently:

```powershell
$userPath = [Environment]::GetEnvironmentVariable('Path','User')
if (($userPath -split ';') -notcontains $binDir) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
}
```

Open a new terminal, then check it:

```powershell
adze --version
adze doctor
```

A shim is used rather than `npm i -g` or `pnpm link --global` for one reason:
**uninstalling is deleting a file.** It also always reflects whatever you last built in
the checkout, so there is no second copy to get out of date. `npm i -g` from this
monorepo does not work at all — the `workspace:*` dependencies do not resolve outside
pnpm.

### Building first

The shim runs the built output, so the CLI and its dependency chain have to be compiled.
Build in dependency order, from inside each package:

```powershell
foreach ($p in 'protocol','apply','core','providers','retrieval','cli') {
  Push-Location "$repo\packages\$p"
  node ../../node_modules/typescript/bin/tsc -p tsconfig.build.json
  Write-Host "$p -> $LASTEXITCODE"
  Pop-Location
}
```

---

## First run

Do it in a throwaway git repository, not in anything you care about:

```powershell
mkdir $HOME\adze-testbed; cd $HOME\adze-testbed
git init
# ... add a couple of files ...
git add -A
git commit -m "before adze"

adze run "fix the failing test"
```

The initial commit is the load-bearing part. With it, everything the agent does is
undoable:

```powershell
git status        # exactly what it touched
git diff          # exactly what it changed
git checkout .    # undo uncommitted changes
git reset --hard  # undo everything, back to the commit
```

---

## What the safe launcher changes, and why

`adze` (via `scripts/adze-safe.mjs`) is not a different program. It is the same CLI with
flags applied, plus two refusals. It prints what it did on every invocation, because a
launcher that silently rewrote a security-relevant flag would leave you believing
something false about your own setup.

### Injected flags

Applied to `run` and `chat` only — the two commands that reach the agent loop. Everything
else (`doctor`, `models`, `validate`, `apply`, `--help`) passes straight through, since
injecting an approval flag into a read-only diagnostic would just turn it into a usage
error.

| Flag | Stock default | Why the change |
| --- | --- | --- |
| `--approval untrusted` | `on-request` | `on-request` asks only about what the sandbox *would* block. On Windows the sandbox blocks nothing at the OS level, so the honest set of things worth seeing is every tool call. |
| `--sandbox workspace-write` | same | Confines writes to the workspace root, which is what makes the git requirement meaningful. **`full-access` is never a default.** |
| `--max-steps 25` | none | Bounds a loop that runs away by taking turns. |
| `--max-tokens 200000` | none | Bounds one that runs away by generating. |
| `--max-time 300` | none | Bounds one that runs away by hanging. |

`--max-spend` is deliberately *not* injected: core refuses that flag for a model with no
entry in the price catalog, and every local endpoint is unpriced, so injecting it would
break exactly the free setup this guide encourages.

### Two refusals

- **Not inside a git repository → stop.** A commit is what makes the agent's writes
  undoable, and with no OS sandbox it is the strongest remaining safety property. A
  warning here would get scrolled past. Override with `ADZE_SAFE_ALLOW_NO_GIT=1` if you
  must; prefer running `git init`.
- **Workspace is a drive root or your user profile root → stop.** `workspace-write` over
  your entire account is `full-access` wearing a different label.

---

## Escalating, once you trust it

Injected defaults are **prepended**, and commander resolves a repeated option to the last
one. So your own flag always wins, and the escalation is visible in your shell history —
which is the point. A safe default you cannot turn off just gets worked around by
abandoning the launcher, and then nothing is applying a default at all.

```powershell
# Stop being asked about everything; still confined to the workspace.
adze run "..." --approval on-request

# Pre-approve one command instead of widening the sandbox for everything.
adze run "..." --allow "node --test" --allow "git status"

# Refuse a command outright. Never offered for approval, even to you.
adze run "..." --forbid "git push" --forbid "rm"

# Read-only, and deny anything needing approval rather than asking. Good for CI.
adze run "..." --sandbox read-only --approval never

# Stock behaviour, no injected flags, no git check.
adze-raw run "..."
```

`--approval never` **refuses instead of escalating**: an action that would need approval
is denied, never silently granted. That makes it the right policy for anything
unattended.

Two things worth knowing before you widen anything:

- **`adze apply` is not gated.** It is a direct editing command — you invoking the
  applier yourself, like `sed` — and it will happily write to an absolute path outside
  the workspace. The permission gate governs tool calls made by the *model*, not this.
- **A refusal is the applier working.** `adze apply` exits 1 and writes nothing when a
  search block matches more than once, or when the result would not parse. That is the
  designed behaviour, not a bug to work around.

---

## Pointing it at a different model

Provider config lives in `.adze/providers.json`, either next to your project or in
`$HOME\.adze\providers.json`. The nearer file wins per key.

**Never put a key in this file.** Name the environment variable that holds it. A secret
in a working tree is one `git add -A` from being published, and the loader cannot prevent
that — naming the variable instead of the value can. The file is strict JSON with no
comment keys: an unknown key is rejected rather than ignored, so a typo cannot silently
do nothing.

A local endpoint — free, and nothing leaves the machine:

```json
{
  "providers": {
    "local": {
      "kind": "openai-compatible",
      "baseURL": "http://localhost:11434/v1",
      "nativeToolCalling": false
    }
  },
  "defaultModel": "local/qwen2.5-coder:7b"
}
```

Use `http://localhost:1234/v1` for LM Studio, `:8080/v1` for llama.cpp, `:8000/v1` for
vLLM. `openai-compatible` needs no credential.

Set `nativeToolCalling` honestly. It is the only way to tell Adze that a local model
cannot call tools; with `false`, the engine runs it without tools and every surface
reports the model as `degraded`. Leaving it wrong produces a model that appears to work
and silently never edits anything.

A hosted provider, with the key coming from the environment:

```json
{
  "providers": {
    "anthropic": { "kind": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" }
  },
  "defaultModel": "anthropic/claude-sonnet-4-5"
}
```

Check what resolved, without making a network call:

```powershell
adze models    # providers, credential source, and which models have prices
adze doctor    # the same, plus the environment and the sandbox report
```

Neither probes an endpoint. "Configured" is not "reachable" — a wrong `baseURL` and a
stopped server both look identical here, and the first `adze run` is where you find out.

---

## Uninstall, completely

Delete one directory and remove one PATH entry. Nothing else was touched.

```powershell
$binDir = Join-Path $env:LOCALAPPDATA 'adze\bin'
Remove-Item -Recurse -Force $binDir

$userPath = [Environment]::GetEnvironmentVariable('Path','User')
$kept = ($userPath -split ';' | Where-Object { $_ -and $_ -ne $binDir }) -join ';'
[Environment]::SetEnvironmentVariable('Path', $kept, 'User')
```

Then, if you want them gone:

```powershell
Remove-Item -Recurse -Force $HOME\adze-testbed     # the throwaway workspace
Remove-Item -Recurse -Force $HOME\.adze            # user-level provider config
Remove-Item -Recurse -Force C:\path\to\adze        # the checkout itself
```

There is no installer, no service, no registry key beyond that single user PATH value,
and no global npm or pnpm state. That is the whole footprint, and it is why the shim was
chosen over a global link.

---

## Known limitations

Stated here rather than discovered later:

- **No OS-level sandbox on Windows.** The subject of this whole guide.
- **`adze apply` has no workspace confinement.** It is a direct tool, not a gated one.
- **There is no config file for approval, sandbox, or budgets yet.** They are CLI flags,
  which is why the launcher exists. The layered `.adze/config.jsonc` system is M2 — see
  [the roadmap](../roadmap.md).
- **The validator degrades honestly, and often to `structural`.** `adze validate` reports
  `tree-sitter` only when a real parse ran, `structural` when only the delimiter and
  indentation check ran, and `skipped` when the language was unknown. A `structural` pass
  is a weaker guarantee than a parse, and it says so instead of rounding up.
- **No TUI.** Plain text by design, so it stays scriptable ([ADR-0001](../architecture/adr/0001-engine-first-architecture.md) §6.6).
