# Configuration

Two things decide what an Adze agent is allowed to do: **sandbox mode** — what is
permitted — and **approval policy** — when you are asked. They are separate axes on
purpose, and understanding why they are separate is most of understanding the model.

Everything in this guide was checked against the implementation in
`packages/core/src/permissions.ts`, `packages/cli/src/agent/flags.ts`, and
`packages/providers/src/config.ts`, and then against the running binary. Where a
setting is not reachable from the CLI, this guide says so instead of showing a flag
that does not exist.

The reasoning behind the model is
[ADR-0007](../architecture/adr/0007-sandbox-and-permissions.md).

## Why two axes instead of one dial

A single "safety level" slider looks simpler and is worse. On a one-dial design the
only way to reduce prompts is to reduce containment, so a user annoyed by prompts
ends up with a less contained agent. Worse, users who click through prompts blindly
end up in a worse position than users who were never prompted at all, because the
clicking manufactures confidence that a human reviewed something.

Splitting the axes means you can run an agent with very low approval friction inside
a narrow boundary, or with high friction inside a wide one, and the two decisions do
not contaminate each other.

## Axis 1 — sandbox mode

`-s, --sandbox <mode>`, default `workspace-write`.

| Mode | Files | Commands | Network |
| --- | --- | --- | --- |
| `read-only` | read inside the workspace; **any write needs approval** | need approval | needs approval unless the host is allowlisted |
| `workspace-write` | read and write inside the writable roots; a write outside them needs approval | need approval | needs approval unless the host is allowlisted |
| `full-access` | anything | anything | anything |

Three details that are easy to get wrong:

**Reads are wider than writes.** A read is permitted anywhere the agent may also
write, plus the workspace root. Under `workspace-write` that means the workspace plus
every entry in `writableRoots`.

**`full-access` is not a sandbox mode with a wide boundary; it is the absence of
one.** It reports `not-applicable` for enforcement, and it emits a second warning of
its own (`network-unrestricted`) alongside the no-sandbox one.

**An invalid value is refused, never defaulted.** A typo silently becoming
`workspace-write` would grant more than you asked for, invisibly:

```console
$ adze run --sandbox read-onyl "x"
adze: --sandbox 'read-onyl' is not a sandbox mode
  One of: read-only, workspace-write, full-access.
  read-only and workspace-write are containment modes; full-access asks for none.
```

Exit code `2`.

### `writableRoots`

Absolute paths the agent may write to under `workspace-write`. An empty list means
the workspace root only. It exists as an explicit list rather than something derived,
so a caller can widen *writes* without widening the *mode* — letting the agent write
a build directory outside the repository does not have to mean granting full access.

When a write lands outside those roots, the refusal names them:

```
writing '<path>' needs approval: it is outside the writable roots (<roots>)
```

> [!IMPORTANT]
> **`writableRoots` is not reachable from the CLI.** `packages/cli/src/agent/setup.ts`
> constructs the sandbox config with `writableRoots: []` and there is no flag to
> change it, so under the CLI the writable set is always exactly the workspace root.
> The same is true of `allowedNetworkHosts`.
>
> Both are real, honoured fields — `@adze/core` and `@adze/sdk` read them, and
> `@adze/sdk` validates that every root is absolute — so an embedder can set them
> today. See [embedding.md](embedding.md). From the CLI, the intended tool for
> widening one specific capability is a command-prefix rule, below.

### `allowedNetworkHosts`

Hosts reachable when the mode would otherwise deny network access. Matched by exact
host string. Same CLI caveat as `writableRoots`.

## Axis 2 — approval policy

`-a, --approval <policy>`, default `on-request`.

| Policy | Behaviour |
| --- | --- |
| `untrusted` | ask about every tool call that declares an effect |
| `on-request` | ask only about what the sandbox would block (default) |
| `never` | **refuse** instead of asking |

### `never` refuses; it does not escalate

This is the most important sentence in this guide. Under `--approval never`, an
action that would require approval is **denied**. It is not quietly permitted, and
the sandbox is not quietly widened to accommodate it.

That is deliberate, and it is the behaviour the gate is most explicitly tested for. A
policy that granted more than it advertised would make the entire permission model
untrustworthy — once you cannot trust one setting to mean what it says, you cannot
reason about any of them. The cost is that some tasks simply fail under `never`. That
is the correct outcome, and it is why `never` is the policy to use in CI.

The same rule applies when no approval channel is wired up at all: no channel means
no approval, which means refusal. Defaulting to allow there would turn a missing
surface callback into a silent full-access mode.

### What `untrusted` does not prompt for

`untrusted` asks about every effect, including ones the sandbox would have allowed —
that is what the mode means. But **a call that declares no effects is never prompted,
even under `untrusted`.**

ADR-0007 words the policy as "approve every action"; the implementation narrows that
to every action that *does* something. `todo` changes session state, and `task` runs
a subagent whose own calls are each authorized under this same policy. Prompting for
those asks you to decide something with no security content, and manufacturing
prompts nobody can act on is how approval fatigue starts — which ADR-0007 names as
worse than not prompting. The call still passes through the gate; it simply has
nothing to weigh.

### When you are asked, what you can answer

A surface can return four decisions:

| Decision | Effect |
| --- | --- |
| `allow-once` | permit this one call |
| `allow-session` | permit this exact effect for the rest of the session |
| `deny` | refuse; the agent sees the refusal and can adapt |
| `abort` | refuse and end the turn |

`deny` and `abort` are distinct on purpose. A denial is not a failure: the turn
continues, the model adapts, and the run can still reach `end-turn`. Conflating the
two would let a denied action appear in a trajectory as an execution.

The CLI's approval prompt shows the summary, the rule that triggered it, and the
**exact argv** that would run — not the string the model wrote. A surface that
displayed the model's string would be asking for consent to something else.

## Why commands are prompted even in `read-only`

A command cannot be inspected for what it will do, so whether it needs approval
depends on whether anything is *containing* it.

When the broker reports OS-level enforcement, `on-request` lets commands run — the
sandbox is what would stop them. When it reports `gate-only`, the gate is all there
is, so the command is prompted. **Every platform reports `gate-only` today**, because
the CLI builds a `NodeSubprocessBroker` from `@adze/core` and that broker never
reports OS-level containment. You can confirm it on your own machine:

```console
$ adze doctor --json
...
  "sandbox": {
    "defaultMode": "workspace-write",
    "defaultApprovalPolicy": "on-request",
    "enforcement": "gate-only",
    "osLevelContainment": false,
    "reference": "docs/architecture/adr/0007-sandbox-and-permissions.md"
  }
```

That is more conservative on a gate-only platform than on a contained one, and it is
the honest ordering. The alternative is claiming a boundary that does not exist.

## Command-prefix rules

Rules are the intended remedy for a gate-only platform: permit the one command the
agent needs without widening the mode for everything else.

```bash
adze run --allow "pnpm test" --allow "pnpm lint" "make the failing test pass"
adze run --forbid "git push" --forbid "rm -rf" "clean up the imports"
```

Both flags are repeatable and accumulate rather than overwrite.

| Action | Meaning |
| --- | --- |
| `allow` | runs without asking |
| `forbid` | refused outright, **never offered for approval** |
| `prompt` | always ask — exists in the protocol, not emitted by the CLI |

Four things about how rules resolve, all read from the implementation:

**Matched as a prefix of the argv-joined command string.** The tool's argv is joined
with single spaces and `startsWith` is applied. `--allow "pnpm test"` matches
`pnpm test --filter core`. It does not match `cd x && pnpm test`, because that string
does not start with the prefix.

**Longest matching prefix wins**, not declaration order. So `--forbid "git push"`
overrides a broader `--allow "git"`. Taking the first match in declaration order
would make policy depend on config ordering, which nobody can reason about at the
moment it matters.

**`forbid` beats every mode, including `full-access`.** An explicit prohibition is
the most specific statement of intent available, and prompting to override it would
make the rule advisory.

**An empty prefix is a usage error**, not a match-everything rule:

```console
$ adze run --allow "" "x"
adze: --allow needs a command prefix
```

## Budgets

Four ceilings, all enforced by the engine and all reported in the summary.

| Flag | Unit | Stops when |
| --- | --- | --- |
| `--max-steps <n>` | model round-trips | the step count is reached |
| `--max-tokens <n>` | total tokens | the total is reached |
| `--max-time <seconds>` | wall clock | the elapsed time is reached |
| `--max-spend <usd>` | estimated USD | estimated spend is reached |

Each must be a positive number:

```console
$ adze run --max-steps 0 "x"
adze: --max-steps '0' is not a positive whole number
```

Hitting a budget ends the turn with exit code `1` and a stop reason naming which
ceiling was hit. That is not a crash; it is the ceiling working.

### `--max-spend` on an unpriced model is refused

If the model has no prices in the catalog, the spend budget cannot be computed, so
the turn is **refused rather than run**:

```console
$ adze run --max-spend 0.5 --sandbox read-only --approval never "hi"
ollama/qwen3-coder:30b · read-only · approvals: never
warning [no-os-sandbox] broker 'node-subprocess' provides no OS-level containment on win32. ...

adze: budget.maxSpendUsd was set but provider 'ollama (openai-compatible)' has no prices for model 'qwen3-coder:30b', so the budget could not be enforced. Configure prices or remove the spend budget.
```

Accepting a spend ceiling and then not applying it is the same
"silently grants more than it says" failure the permission model refuses to make,
applied to money. Every local and OpenAI-compatible endpoint is unpriced, so if you
are running against Ollama, omit `--max-spend` and bound the run with `--max-steps`
or `--max-time` instead.

> [!NOTE]
> That refusal is currently rendered through the CLI's unexpected-error path — it
> prints "This is unexpected. Please report it" and exits `1` — even though it is a
> deliberate, tested refusal and reads more naturally as a usage error (`2`). The
> refusal itself is correct; only its presentation is wrong.

## Model selection

| Flag | Purpose |
| --- | --- |
| `-m, --model <provider/model>` | which model, e.g. `anthropic/claude-sonnet-4-5` |
| `--effort <level>` | `minimal`, `low`, `medium`, `high` (OpenAI-style) |
| `--temperature <n>` | 0 to 2 |
| `--max-output-tokens <n>` | cap one response's length |

A model reference must contain a slash. A bare `gpt-5.4` is refused rather than
defaulted, because the same model id through a proxy and through OpenAI is a
different endpoint, a different key, and a different price — guessing would
eventually charge someone on the wrong account. The split is on the *first* slash
only, so an OpenAI-compatible id that itself contains one
(`meta-llama/llama-3.1-70b-instruct`) survives intact.

`--effort` is OpenAI-style and Anthropic models do not accept it:

```console
$ adze run --effort ultra "x"
adze: --effort 'ultra' is not a reasoning effort
  One of: minimal, low, medium, high.
  Anthropic models do not accept an effort level; omit the flag for those.
```

Resolution order for which model is used, most specific first: `--model`, then
`defaultModel` in a providers file, then the provider entry's own `defaultModel`.

## Session flags

| Flag | Purpose |
| --- | --- |
| `-C, --cwd <path>` | workspace root; defaults to the current directory |
| `--instructions <text>` | extra system instructions for this session |
| `-q, --quiet` | suppress tool and progress lines, keep assistant text |
| `--json` | on `run`: one JSON event per line, then a summary document |

Every flag on this page is registered from one function shared by `run` and `chat`,
so the two commands cannot drift. A `--sandbox` value one accepted and the other
silently ignored would be a security display that is wrong in one of two places, with
no way for you to tell which.

## The shell the agent uses

The `bash` tool runs `bash -lc <command>`, resolving `bash` on `PATH`. Two
environment variables override that:

| Variable | Meaning | Default |
| --- | --- | --- |
| `ADZE_SHELL` | Program to run commands with. Taken **verbatim**, so a path containing spaces needs no quoting. | `bash` |
| `ADZE_SHELL_FLAG` | Flag that makes the program take a command string. | `-lc` |

```powershell
# Windows: point at Git for Windows' bash rather than WSL's launcher
$env:ADZE_SHELL = 'C:\Program Files\Git\bin\bash.exe'
```

This exists for one specific and common failure. On Windows, `bash` on `PATH` is
frequently WSL's launcher, which is present whether or not a healthy distribution
sits behind it and exits non-zero for **every** command when one does not. The agent
can still read, edit, glob, grep and use symbols in that state, but every command it
tries fails — so a task that needs to run a test cannot finish.

`adze doctor` probes the shell the agent will actually use, including the override,
and reports which one it came from:

```
warn shell      not found
     The `bash` tool runs `C:\wrong\path.exe -lc <command>` and cannot work until
     this does. This shell came from ADZE_SHELL, so the override is what needs
     correcting rather than PATH.
```

Two variables rather than one command string is deliberate: splitting
`ADZE_SHELL="C:\Program Files\Git\bin\bash.exe -lc"` on whitespace would break on
exactly the path this feature exists to support. An empty value is treated as unset,
because `ADZE_SHELL=` in a dotenv file is how a variable gets cleared.

## The configuration file

Adze reads provider configuration from `.adze/providers.json`, in two locations,
user-level first and then the workspace, so the nearer file wins per key:

```
~/.adze/providers.json              # machine-wide default
<workspace>/.adze/providers.json    # this repository's override
```

`adze models` prints which files it read, under `config read from`. Strict JSON —
no JSONC, no comments, no dependency on a parser.

### Full shape

```json
{
  "providers": {
    "<id>": {
      "kind": "anthropic | openai | openai-compatible",
      "apiKeyEnv": "NAME_OF_A_VARIABLE",
      "apiKey": "the key itself — prefer apiKeyEnv",
      "baseURL": "https://...",
      "headers": { "X-Thing": "value" },
      "defaultModel": "model-id",
      "nativeToolCalling": true,
      "maxRetries": 2
    }
  },
  "defaultModel": "<id>/<model-id>"
}
```

| Key | Notes |
| --- | --- |
| `kind` | required unless the entry id itself names a transport (`anthropic`, `openai`, `openai-compatible`) |
| `apiKeyEnv` | the **name** of an environment variable. Prefer this. |
| `apiKey` | the literal key. Works, but see below. |
| `baseURL` | required for `openai-compatible`; overrides the vendor default otherwise |
| `headers` | extra request headers. Never logged. |
| `defaultModel` | used when a selection names this provider without a model |
| `nativeToolCalling` | declare tool-calling support for a model the catalog has never heard of. `false` marks the model `degraded`: run without tools, and every surface says so. |
| `maxRetries` | 0–10, default 2 |

**An unknown key is rejected, not ignored**, so a typo cannot silently do nothing:

```
<path> does not match the providers schema: ...
  The file is `{ "providers": { "<id>": { "kind": "...", "apiKeyEnv": "..." } } }`.
  An unknown key is rejected rather than ignored, so a typo cannot silently do nothing.
```

Invalid JSON gets its own message telling you to fix the syntax or delete the file to
fall back to environment variables.

### Prefer `apiKeyEnv` over `apiKey`

`apiKey` is accepted because someone with several accounts needs somewhere to put
them. Every code path prefers the environment, and the schema's own documentation
says to use `apiKeyEnv`, for one reason: a secret in a file inside a git working tree
is one `git add -A` from being public, and the loader cannot prevent that. Naming the
variable instead of the value can.

Nothing in resolution reads the network and nothing logs. A resolved key is held in
memory, registered with the redactor, and never written anywhere by the package.

### Credential precedence

Three sources, most specific first: explicit options passed by an embedder, then the
config file, then the environment.

Environment **last** is deliberate. A checked-out repository's config file should not
be able to silently redirect an agent at a different endpoint than the one the
operator exported.

Within a single provider entry, the key is resolved as: `apiKeyEnv`'s variable, then
the entry's literal `apiKey`, then the standard variables. The literal sits in the
middle so someone who names a variable gets the variable, and someone who pasted a
key still works.

Standard variables per transport, in order:

| Transport | API key | Base URL |
| --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY`, `ADZE_ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` |
| `openai` | `OPENAI_API_KEY`, `ADZE_OPENAI_API_KEY` | `OPENAI_BASE_URL` |
| `openai-compatible` | `ADZE_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_API_KEY` | `ADZE_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_BASE_URL` |

The vendor name comes first so an environment that already works with other tools
works with Adze and needs no Adze configuration at all. The `ADZE_`-prefixed name is
second, for when you want Adze to use a different key than your other tools.

`anthropic` and `openai` always appear in the provider list even with no credential,
so `adze doctor` can report "no key" rather than omitting the provider — a provider
absent from the list is indistinguishable from one Adze does not support, and that
ambiguity is exactly why a user cannot tell which variable to set.
`openai-compatible` is *not* in that default set: it has no default endpoint, so an
unconfigured entry would be a provider that cannot work and says nothing about why.

> [!NOTE]
> **This is the provider slice of configuration, not all of it.** The full
> `.adze/config.jsonc` system — schema, layering, and `AGENTS.md` conventions — is
> milestone M2 in [the roadmap](../roadmap.md). What exists today is
> `.adze/providers.json` and the flags on this page. There is no config file for
> sandbox mode, approval policy, budgets, or command rules; pass those as flags, or
> wrap the CLI in a launcher script the way
> [local-testing.md](local-testing.md) does.

## Recipes

Read-only review, no prompts, nothing can be modified — the CI shape:

```bash
adze run --sandbox read-only --approval never --max-steps 15 \
  "review the diff on this branch and list problems"
```

Let it work in the repository, run the test command without asking, but never push:

```bash
adze run --allow "pnpm test" --forbid "git push" --max-time 900 \
  "make the failing test in packages/apply pass"
```

Maximum friction, for a task you do not trust yet:

```bash
adze run --sandbox read-only --approval untrusted "explain the retrieval package"
```

A machine-readable run with hard ceilings:

```bash
adze run --json --max-steps 20 --max-tokens 200000 --max-time 600 \
  "add a changeset for the applier fix" > events.jsonl
```

## Where to go next

- [getting-started.md](getting-started.md) — install, providers, and what each
  command does.
- [local-testing.md](local-testing.md) — a launcher that applies restrictive defaults
  for you and refuses to run outside a git repository.
- [embedding.md](embedding.md) — setting `writableRoots`, `allowedNetworkHosts`, and
  the approval channel from your own code.
- [ADR-0007](../architecture/adr/0007-sandbox-and-permissions.md) — the model, and
  what is and is not enforced today.
