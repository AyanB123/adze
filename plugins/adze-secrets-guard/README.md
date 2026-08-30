# Secrets Guard

**Denies any edit or file write that would commit a credential, and denies unreviewed
changes to CI workflow files.**

Surfaces used: **hooks** (`edit.pre`, `tool.pre`).

## What it does

| Rule | Event | Outcome |
| --- | --- | --- |
| A search/replace block adds a recognisable credential | `edit.pre` | `deny` |
| A whole-file `write` contains a recognisable credential | `tool.pre` | `deny` |
| A `bash` command contains a recognisable credential | `tool.pre` | `deny` |
| A CI workflow file is edited without human approval | `edit.pre` | `deny` |

Recognised credential shapes: OpenAI-style `sk-` keys (including `sk-proj-` and
`sk-ant-`), GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` tokens, AWS `AKIA`/`ASIA` access
key ids, PEM private-key headers, Slack `xox*` tokens, Google `AIza` keys, live Stripe
keys, and npm access tokens.

CI paths: `.github/workflows/`, `.github/actions/`, `.gitlab-ci.yml`,
`.circleci/config.yml`, `Jenkinsfile`, `azure-pipelines.yml`.

## Why it exists

This is the plugin [ADR-0008](../../docs/architecture/adr/0008-plugin-architecture.md)
is arguing for. A deny-capable hook means a team encodes "no credentials in the repo"
and "workflow files need review" as about eighty lines of policy, rather than waiting
for the engine to ship a secrets feature and rather than maintaining a fork. Nothing in
`@adze/core` knows what an AWS key looks like, and after installing this it does not
need to.

The CI rule is the less obvious half and the more important one. Every other file in a
repository *uses* privileges; a workflow file *grants* them. A workflow can be given
secrets access, `contents: write`, or a new trigger, and an agent that can edit one
unattended has a privilege-escalation path regardless of what it intended. That is a
policy question, not an engine question, which is exactly why it belongs in a plugin.

## Why two events instead of one

`edit.pre` is the correct event and it is not sufficient.

Its payload carries `edits: [{ search, replace }]`. That is everything for the `edit`
tool and **nothing for the `write` tool** — `@adze/plugin-sdk`'s `readCoreWriteArgs`
reports a whole-file write as `{ path, edits: [], wholeFile: true }`, so the bytes being
written are not in the declared payload at all. A guard registered only on `edit.pre`
would refuse a credential added by `edit` and allow the identical credential written by
`write`, which is the worse case because `write` replaces the whole file.

So the whole-file check runs on `tool.pre`, where `arguments` is a declared payload field
and `arguments.content` is the actual content. The same handler covers `bash`, because
`echo <key> > .env` never touches an edit tool.

This is a gap in the specified `edit.pre` contract rather than a quirk of this plugin.
See [FINDINGS.md](../FINDINGS.md#1-editpre-cannot-see-the-content-of-a-whole-file-write).

## The escape hatch

A line containing `adze:allow-secret` is exempt.

A repository with credential-shaped test fixtures needs some way to say so, or this
plugin is unusable in precisely the codebases most likely to want it. The exemption is a
per-line marker rather than a `test/**` path allowlist on purpose: the marker appears in
the diff a reviewer reads, whereas a path allowlist is invisible at review and quietly
grows until it covers the directory where the real credential lands.

## What it does not catch

Stated plainly, because a guard whose limits are unknown gets trusted for things it does
not do:

- **It is a structural check, not entropy analysis.** Every pattern requires a known
  issuer prefix and a plausible length. A bespoke internal token format — an opaque
  32-character session id from your own auth service — passes.
- **It sees proposed text, not resolved files.** An `edit.pre` hook fires at dispatch,
  before `@adze/apply` has matched anything, so it inspects what the model wrote rather
  than what the file will contain. A credential already in the file and left untouched by
  the edit is not seen.
- **A hook that hangs does not block the action.** Per `docs/plugins/spec.md`, a plugin
  hook timeout is treated as `allow` and logged loudly. An operator who prefers the
  opposite sets `onFailure: 'deny'` on the host.

## Installing

```bash
adze plugin dev ./plugins/adze-secrets-guard
```

The hook is `runtime: "js"`, which is **unsandboxed** — it runs in the Adze process with
full privileges, so the host must opt in with `allowUnsandboxedJs`. That is not a
property of this plugin being trusted; it is the honest state of the SDK, which ships the
`wasm32-wasip2` host interface and no WASM runtime. A published build would compile to
WebAssembly and need no flag.

## Tests

`plugins/test/secrets-guard.test.ts` drives every denial above through
`dispatchToolCall` from `@adze/core` — the real dispatcher, a real `HookBus`, a real
`PermissionGate` — and asserts the tool body never ran. The spy tools declare no effects
so the gate has nothing to refuse, which means a `denied` outcome can only have come from
this plugin.
