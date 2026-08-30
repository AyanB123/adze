# Getting started

Adze is a headless AI coding engine with a CLI in front of it. This guide gets you
from a clone to a working `adze` command, points it at a model — including a free
local one — and tells you what each of the six commands does.

Everything shown below was run against the built binary on Windows 11 with
PowerShell. Where a command's output is quoted, it is that command's real output.
Where something does not work yet, this guide says so and names the milestone in
[the roadmap](../roadmap.md) instead of describing it as working.

> [!WARNING]
> **There is no OS-level sandbox containment. Not on Windows, and not on macOS or
> Linux either.**
>
> Adze has a permission gate that every tool call passes through, and it works. What
> does not exist is a layer *underneath* it that confines a command once the gate has
> allowed it. When the agent runs `rm -rf build` and you approve it, that command
> runs with your user's full privileges against your whole filesystem.
>
> `packages/sandbox` now contains per-OS broker implementations (Seatbelt for macOS,
> bubblewrap for Linux, Docker, and a Windows attempt), but **no surface wires them
> up**: the CLI builds a `NodeSubprocessBroker` from `@adze/core`, and that broker
> never reports OS-level enforcement. On Windows there is no mature open-source
> option to wire even in principle, which is a gap across the entire open-source
> agent ecosystem rather than an Adze-specific one.
>
> Treat every approval as equivalent to typing the command yourself. If you want to
> try Adze without that exposure, read
> [local-testing.md](local-testing.md) first — it sets up a launcher with
> restrictive defaults that refuses to run outside a git repository.
>
> The precise position, and what would close the gap, is
> [ADR-0007](../architecture/adr/0007-sandbox-and-permissions.md).

## Read this before you decide to adopt Adze

These are the limitations most likely to matter to you, stated up front rather than
discovered later.

- **No benchmark result has been published.** The harness exists, the
  [policy](../benchmarks/strategy.md) exists, and it was deliberately written before
  the first number so it could not be bent to fit one. There is no number. Any
  comparison you have seen between Adze and another tool did not come from this
  project.
- **No OS-level sandbox on any platform.** See the warning above and
  [ADR-0007](../architecture/adr/0007-sandbox-and-permissions.md).
- **No live end-to-end `adze run` against a real model has been witnessed.** The code
  path is exercised and its failure handling is tested — this guide includes a real
  provider-unreachable transcript — but nobody has yet published a successful turn
  against a real key. Expect to be early. That is M1's unmet exit criterion.
- **Vector search is deliberately deferred.** Retrieval is `ripgrep` plus
  `tree-sitter` symbols fused with reciprocal rank fusion. `@adze/retrieval` exposes
  a `VectorIndex` seam with no implementation and pulls in no embedding dependency,
  because lexical plus symbol search outperforms vector search on most repositories
  and building vectors first would have inverted the evidence.
  [ADR-0006](../architecture/adr/0006-retrieval.md).
- **The IDE fork is a pipeline only — no binary has been built.** `apps/ide` is a
  Code-OSS patch series and build plan, not a vendored fork and not a download.
  Milestone M4, and only after the extension has users.
  [ADR-0010](../architecture/adr/0010-ide-fork-strategy.md).
- **`apps/hub`, the plugin registry, is intentionally empty.** It stays empty until
  roughly 20+ third-party plugins exist, because a registry with nothing in it is
  worthless and shipping one early is how several projects in this category spent
  their credibility. Milestone M7.
  [ADR-0008](../architecture/adr/0008-plugin-architecture.md).
- **Adze does not and will not use the Visual Studio Marketplace.** Microsoft's terms
  restrict Marketplace extensions to Microsoft's own products and name Code-OSS forks
  specifically. The IDE would use Open VSX, so some proprietary extensions — Pylance,
  C# Dev Kit, Remote-SSH, Live Share — are unavailable.
  [ADR-0009](../architecture/adr/0009-extension-gallery.md) has the substitution
  table.
- **The VS Code extension and MCP support are in progress and not usable yet.**
  Milestone M2.
- **Plugins cannot be installed from the CLI.** Eight first-party plugins exist and
  load through `@adze/plugin-sdk` programmatically, but `adze plugin dev` — the
  command `plugins/README.md` shows — is not implemented. See
  [plugins.md](plugins.md). Milestone M3.

## Requirements

Node 22.12 or newer, pnpm 10 or newer, and Git. Docker is needed only for
benchmarks; Rust only if you build the IDE.

On Windows, one extra thing matters: the `bash` tool runs `bash -lc <command>`, so
the agent cannot run *any* command unless a working `bash` is on `PATH`. Git for
Windows supplies one. `bash` on `PATH` is often WSL's launcher, which fails when no
healthy distribution is installed — `adze doctor` detects exactly this and says so.

## Install and build

```bash
git clone https://github.com/AyanB123/adze.git
cd adze
pnpm install
pnpm build
```

`pnpm build` is not optional before `pnpm typecheck` or `pnpm test`: packages resolve
each other's types through their built `dist/` output, so a dependency must be built
before a dependent can be checked. The turbo task graph declares that ordering, so
`pnpm check` handles it for you.

There is no published npm package and no installer. Building from source is the only
way to run Adze today.

Two equivalent ways to invoke the CLI afterwards:

```bash
pnpm adze --help                        # the root script
node packages/cli/bin/adze.mjs --help   # the binary directly
```

This guide uses the second form, because it is what a script or a CI job would use
and it does not depend on your shell's working directory being the repository root.

If you run the binary before building, it tells you so rather than throwing a module
resolution error:

```
adze: @adze/cli has not been built yet.

  pnpm install
  pnpm build

Expected: <repo>/packages/cli/dist/cli.js
```

## Check the environment first

`adze doctor` reports what this machine can and cannot do. It makes no network call —
it tells you what is *configured*, not what is reachable.

```console
$ node packages/cli/bin/adze.mjs doctor
adze doctor

Adze
  cli                    0.0.1
  protocol               0.1

Environment
  ok   node       v25.5.0
  ok   platform   win32 x64
  ok   pnpm       10.20.0
  ok   git        git version 2.49.0.windows.1
  ok   ripgrep    on PATH (...\@vscode\ripgrep\bin\rg.EXE)
  warn shell      found but cannot run a command (C:\WINDOWS\system32\bash.EXE)
                  The `bash` tool runs `bash -lc <command>` and cannot work until this does. ...
  ok   provider   1 usable (openai)

Model providers
  warn anthropic  anthropic · no credential
  ok   openai     openai · key from OPENAI_API_KEY
  default model          none set

  Reported as configured, not as reachable: doctor makes no network call.

Sandbox
  default mode           workspace-write
  default approvals      on-request
  OS containment         none on this platform

  There is no OS-level sandbox on Windows. The permission gate and the
  approval policy still apply, and every tool call still passes through them —
  but nothing stops an approved command from touching the filesystem outside
  the workspace. Treat an approval here as you would treat running the command
  yourself.

  This is a gap across the whole open-source agent ecosystem, not only Adze.
  Closing it is roadmapped: docs/architecture/adr/0007-sandbox-and-permissions.md
```

The `shell` warning above is the real state of the machine this guide was written on,
and it is worth understanding rather than skipping: with `bash` broken, the agent can
still read, edit, glob, grep, and use `symbols`, but every command it tries will
fail.

`adze doctor --json` emits the same information as a machine-readable document,
including a `sandbox` object with `enforcement` and `osLevelContainment` fields. Use
that in CI rather than parsing the text.

## Configure a provider

Adze needs a model. Three transports exist: `anthropic`, `openai`, and
`openai-compatible` — the last of which covers Ollama, llama.cpp, vLLM, OpenRouter,
and any gateway that speaks the OpenAI HTTP shape.

With nothing configured, every command that needs a model refuses with instructions
rather than a stack trace:

```console
$ node packages/cli/bin/adze.mjs run "say hello"
adze: no model provider is configured

  Set one of: ANTHROPIC_API_KEY, ADZE_ANTHROPIC_API_KEY, OPENAI_API_KEY, ADZE_OPENAI_API_KEY.
  PowerShell:  $env:ANTHROPIC_API_KEY = "sk-ant-..."
  bash/zsh:    export ANTHROPIC_API_KEY="sk-ant-..."
  Or point Adze at a local or third-party endpoint in .adze/providers.json:
    { "providers": { "local": { "kind": "openai-compatible", "baseURL": "http://localhost:11434/v1", "defaultModel": "qwen2.5-coder" } } }
  Run `adze models` to see what is configured, and `adze doctor` for the whole environment.

  `adze doctor` reports what is configured.
```

Exit code is `2` — a usage error, not a crash.

### Option A: a hosted provider by environment variable

The vendor-standard variable name is checked first, so an environment that already
works with other tools works with Adze and needs no Adze configuration at all:

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."     # PowerShell
```

```bash
export ANTHROPIC_API_KEY="sk-ant-..."     # bash / zsh
```

`ADZE_ANTHROPIC_API_KEY` and `ADZE_OPENAI_API_KEY` are checked second, for when you
want Adze to bill a different key than your other tools.

### Option B: a local endpoint — free, no API key

This is the recommended way to try Adze. It costs nothing, sends nothing off your
machine, and needs no account.

Install [Ollama](https://ollama.com), pull a coding model, and confirm it is serving:

```bash
ollama pull qwen2.5-coder
ollama serve                 # usually already running as a service
```

Then create `.adze/providers.json` in your workspace:

```json
{
  "providers": {
    "ollama": {
      "kind": "openai-compatible",
      "baseURL": "http://127.0.0.1:11434/v1",
      "nativeToolCalling": true
    }
  },
  "defaultModel": "ollama/qwen2.5-coder"
}
```

Three things about that file:

- **`kind` is required** unless the entry's own id happens to name a transport. The
  id `ollama` is not a transport, so `"kind": "openai-compatible"` is what makes it
  work. An unknown key is rejected rather than ignored, so a typo cannot silently do
  nothing.
- **`nativeToolCalling`** is the only way to tell Adze whether a model the price
  catalog has never heard of supports tool calling. Setting it to `false` marks the
  model `degraded`: the engine runs it without tools and every surface says so.
  Leaving it out means Adze does not know, which is a different thing from `false`.
- **Put no API key in this file if you can avoid it.** The schema accepts `apiKey`,
  but prefer `apiKeyEnv` — the *name* of a variable to read. A secret in a file
  inside a git working tree is one `git add -A` away from being public, and the
  loader cannot prevent that.

Adze looks for that file in two places, user-level first and then the workspace, so
the nearer file wins per key:

| Location | Purpose |
| --- | --- |
| `~/.adze/providers.json` | your machine-wide default |
| `<workspace>/.adze/providers.json` | this repository's override |

Verify it was picked up. `adze models` reads configuration and makes no network call:

```console
$ node <repo>/packages/cli/bin/adze.mjs models
adze models

Providers
  anthropic              no credential (set ANTHROPIC_API_KEY or ADZE_ANTHROPIC_API_KEY)
  openai                 key from OPENAI_API_KEY
  ollama                 no credential — optional for openai-compatible (set ADZE_COMPATIBLE_API_KEY or OPENAI_COMPATIBLE_API_KEY if the endpoint needs one)
                         http://127.0.0.1:11434/v1

Models
  openai/gpt-5.6-sol                           priced · vision
  ...
  openai/o4-mini                               priced · vision

  default model          ollama/qwen3-coder:30b
  prices sourced on      2026-08-29
  config read from       ...\.adze\providers.json
```

Note what the `Models` list does and does not contain. It lists models Adze knows
**prices** for, from `packages/providers/src/catalog.json`. Your local model is not
in it and will not appear there — that is expected, not a failure. A local endpoint
is unpriced, and Adze reports its cost as `unknown` rather than as zero, because
reporting zero would read as free.

Model references are always `provider/model`. A reference with no slash is refused
rather than guessed: `gpt-5.4` through a proxy and through OpenAI are different
endpoints, different keys, and different prices.

## Your first run

```bash
node <repo>/packages/cli/bin/adze.mjs run --sandbox read-only --approval never \
  "summarise what this repository does"
```

`--sandbox read-only --approval never` is the safest possible first invocation: the
agent may read inside the workspace, and anything requiring approval is **refused**
rather than escalated.

Here is a real transcript from a machine where the configured local endpoint was not
actually running — the most likely first-run failure, and worth recognising:

```console
$ node <repo>/packages/cli/bin/adze.mjs run --sandbox read-only --approval never \
    --max-steps 2 --max-time 25 "say hello"
ollama/qwen3-coder:30b · read-only · approvals: never
warning [no-os-sandbox] broker 'node-subprocess' provides no OS-level containment on win32. The permission gate and approval policy still apply, but an approved command runs unconfined.

warning [no-os-sandbox] sandbox mode 'read-only' is enforced by the permission gate only: there is no OS-level containment on this platform, so a command that is approved is not confined once it runs
  docs/architecture/adr/0007-sandbox-and-permissions.md
stopped: error — model request failed: ollama/qwen3-coder:30b: Cannot connect to API: connect ECONNREFUSED 127.0.0.1:11434
  No route to the provider. Check connectivity, and any proxy or firewall.
  If you are pointing at a local server, confirm it is listening on the configured base URL.

Summary
  model                  ollama/qwen3-coder:30b
  stop reason            error
  steps                  0
  wall clock             6.2s

Tokens
  input (full rate)      0
  input (cached)         0
  output                 0
  total                  0
  cache hit rate         0.0%

Cost
  total                  unknown

  No prices for 'ollama/qwen3-coder:30b' in the table.
  Add them to packages/providers/src/catalog.json — it is data, not code.
```

Two things to take from that output beyond the error. **The sandbox warning is
printed before the turn, not after** — a user about to approve a command needs that
fact before deciding. And **the summary is printed even on failure**, with the token
split and cache hit rate, because cache economics move effective cost by more than
10× and a summary that omitted them would not be usable for cost reasoning.

Exit codes for `run`:

| Code | Meaning |
| --- | --- |
| `0` | the turn reached `end-turn` |
| `1` | the agent did not finish: a budget ceiling, a refusal, a cancellation, or a provider error. A refusal is the permission gate working, not a crash. |
| `2` | usage error, including no configured model provider |

For a scriptable run, `--json` emits one JSON event per line on stdout followed by a
summary document:

```bash
node <repo>/packages/cli/bin/adze.mjs run --max-steps 20 --max-spend 0.50 --json \
  "add a changeset" > events.jsonl
```

## The six commands

### `run` — one task, non-interactive

Runs a single task to completion and exits. Takes the prompt as an argument. This is
the command for scripts and CI. All the agent flags below are shared with `chat`;
[configuration.md](configuration.md) explains each one.

### `chat` — an interactive session

Plain text, one session across every prompt, so the conversation accumulates and the
cached prefix stays reusable. There is no TUI, deliberately — plain output first keeps
`adze` scriptable, and a TUI added later cannot take that away
([ADR-0001](../architecture/adr/0001-engine-first-architecture.md) §6.6).

Five slash commands, verified against the running binary:

```console
$ node <repo>/packages/cli/bin/adze.mjs chat
adze chat — ollama/qwen3-coder:30b
workspace-write · approvals: on-request · /help for commands
warning [no-os-sandbox] broker 'node-subprocess' provides no OS-level containment on win32. ...

  /usage    tokens, cost, and cache hit rate for this session
  /model    the model and its capabilities
  /clear    start a new session, discarding the conversation
  /help     this list
  /exit     leave (Ctrl-D also works)
```

### `apply` — apply one edit through the three-tier applier

Useful on its own, and the fastest way to understand how Adze treats edits. It reads
a file from disk and writes it back unless `--dry-run`.

```console
$ node <repo>/packages/cli/bin/adze.mjs apply --file greet.ts --search "hello" --replace "hi" --dry-run
applied greet.ts
  tier                   search-replace
  match strategy         exact
  validator              structural (delimiter and indentation check)
  tiers attempted        1
  bytes changed          3
  edits                  1
dry run — nothing written; drop --dry-run to apply
```

Now the same file with a search string that matches twice:

```console
$ node <repo>/packages/cli/bin/adze.mjs apply --file greet.ts --search "name" --replace "who" --dry-run
refused greet.ts
  reason                 ambiguous

edit 1: search text matched 2 times (lines 1, 2). Add more surrounding context, or set 'occurrence' to disambiguate.

candidate matches
  line 1  (exact, offsets 22-26)
  line 2  (exact, offsets 64-68)

Add surrounding context to make the block unique, or pass --occurrence <n>.

A refusal is the applier working: the alternative was writing a file it had broken.
```

That refusal is the single most important behaviour in the applier. An ambiguous
match is never resolved by guessing, because silently taking the first match produces
corruption that is invisible and unreproducible. `--occurrence 2` resolves it
explicitly:

```console
$ node <repo>/packages/cli/bin/adze.mjs apply --file greet.ts --search "name" --replace "who" --occurrence 2 --dry-run
applied greet.ts
  tier                   search-replace
  match strategy         exact
  validator              structural (delimiter and indentation check)
  tiers attempted        1
  bytes changed          1
  edits                  1
```

For a multi-edit block, `--edits <path>` takes a JSON file of the shape
`{ "edits": [{ "search", "replace", "occurrence"? }], "replacement"? }`. `--json`
adds full telemetry — tier, match strategy, and validator level — which is what makes
apply success rate per model per tier a publishable number later.

Exit codes: `0` applied, `1` refused, `2` usage error.

### `validate` — parse-validate files, honestly

```console
$ node <repo>/packages/cli/bin/adze.mjs validate greet.ts a.py b.js broken.js notes.txt
ok       greet.ts  (structural)
ok       a.py  (structural)
ok       b.js  (structural)
skipped  notes.txt  (no validator for 'txt' — not checked)

3 validated, 1 skipped, 1 invalid
A skipped file was not checked at all. 'validate' reports the level that ran rather than implying a parse.
invalid  broken.js  (structural)
          unclosed '{' opened at line 1 at line 1
```

The parenthesised word is a claim about evidence, and reading it correctly matters:

| Level | What actually happened |
| --- | --- |
| `tree-sitter` | a real parse |
| `structural` | a delimiter and indentation balance check — conservative, reports a problem only when the text is definitely malformed |
| skipped | the language was unknown and nothing was checked. Reported as skipped, never as a pass. |

On the machine this guide was written on, **every validated file reported
`structural`, not `tree-sitter`** — no real parse happened for TypeScript, Python, or
JavaScript. That is the validator being honest about a degraded environment rather
than a defect in the report, but it does mean parse validation is weaker in practice
than "three-tier applier with parse validation" implies. Use `--json` and read the
`validator` field if you need to depend on this.

Exit codes: `0` nothing invalid (files may have been skipped), `1` at least one file
invalid or unreadable, `2` usage error.

### `doctor` — the environment, and what the sandbox does not do

Covered above. `--json` for machine-readable output.

### `models` — what is configured and what is priced

Covered above. `--json` for machine-readable output; `--all` also lists catalog models
whose provider has no credential configured.

## Where to go next

- [configuration.md](configuration.md) — the two-axis permission model, budgets, and
  every flag in detail.
- [local-testing.md](local-testing.md) — running Adze on Windows without regretting
  it, including a safe launcher with restrictive defaults.
- [plugins.md](plugins.md) — the eight first-party plugins and how to write one.
- [embedding.md](embedding.md) — building your own surface on `@adze/sdk`.
- [../roadmap.md](../roadmap.md) — what is actually usable this week.
