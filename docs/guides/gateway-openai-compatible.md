# Pointing Adze at an OpenAI-compatible gateway

Adze talks to any endpoint that speaks the OpenAI `/v1/chat/completions` wire format
through the `openai-compatible` provider kind. That covers OpenRouter, llama.cpp's
server, Ollama, vLLM, LiteLLM, and in-house gateways. No adapter code is needed —
`@adze/providers` already implements the transport.

This guide records a verified end-to-end configuration against a local gateway, and it
is deliberately explicit about one thing that is easy to get wrong: **a gateway may
serve several models under different wire formats behind a single OpenAI-shaped URL.**

## Check the wire format before you configure anything

A gateway's `/v1/models` is the cheapest way to find out what you are actually talking
to, and it is worth reading rather than assuming. The response is not required to be
uniform:

```bash
curl -s http://127.0.0.1:8790/v1/models | jq '.data[] | {id, api_format}'
```

On the gateway this guide was verified against, the same host returned both:

```json
{ "id": "grok-4.5",           "api_format": "openai-completions" }
{ "id": "claude-sonnet-4-5",  "api_format": "anthropic-messages" }
```

An `anthropic-messages` entry behind a `/v1/` path is not a misconfiguration on the
gateway's part — it is a routing hint. Some gateways translate, some do not. Adze's
`openai-compatible` kind sends OpenAI-shaped requests, so a model advertising
`anthropic-messages` will work only if the gateway itself translates. Test it with one
minimal request before wiring it up, rather than discovering it mid-run:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://127.0.0.1:8790/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_KEY_HERE' \
  -H 'Content-Type: application/json' \
  -d '{"model":"MODEL_ID","messages":[{"role":"user","content":"say ok"}],"max_tokens":5}'
```

`200` means Adze can drive it. Anything else means this model needs a different
provider kind, and no amount of Adze configuration will change that.

### The model verified here

`grok-4.5` on the reference gateway reports:

| Field            | Value                |
| ---------------- | -------------------- |
| `api_format`     | `openai-completions` |
| `reasoning`      | `true`               |
| `context_window` | 200000               |
| `max_tokens`     | 128000               |

`POST /v1/chat/completions` with `model: "grok-4.5"` returned **HTTP 200**. The response
carried `usage.prompt_tokens_details.cached_tokens`, which is the field Adze reads for
cache-hit reporting, and `completion_tokens_details.reasoning_tokens`.

## Configuration

Two pieces are needed: a provider entry that declares the kind and the base URL, and a
credential. Today the entry must come from a config file — see
[Environment variables](#environment-variables) for why the environment alone is not
enough.

Create `.adze/providers.json` in the workspace (or `~/.adze/providers.json` for a
machine-wide default):

```json
{
  "providers": {
    "bloome": {
      "kind": "openai-compatible",
      "apiKeyEnv": "ADZE_COMPATIBLE_API_KEY",
      "baseURL": "http://127.0.0.1:8790/v1"
    }
  },
  "defaultModel": "bloome/grok-4.5"
}
```

The provider id (`bloome` here) is yours to choose; it is the left half of every
`provider/model` reference. `kind` is what selects the transport, so it is required for
any id that is not itself one of `anthropic`, `openai`, `openai-compatible`.

Prefer `apiKeyEnv` — a variable *name* — over `apiKey`, which takes the literal secret.
A key in a file inside a git working tree is one `git add -A` away from being public,
and the loader cannot prevent that.

Then export the key for the session only:

```powershell
# PowerShell
$env:ADZE_COMPATIBLE_API_KEY = "YOUR_KEY_HERE"
```

```bash
# bash/zsh
export ADZE_COMPATIBLE_API_KEY="YOUR_KEY_HERE"
```

Verify with the two commands that make no network call:

```bash
adze doctor    # provider row should read: bloome  openai-compatible · key from ADZE_COMPATIBLE_API_KEY
adze models    # lists configured providers, the resolved baseURL, and the default model
```

Both report **configured, not reachable**. Neither probes the endpoint, because
invariant 5 forbids an outbound call the user did not ask for. A green `doctor` means
the credential resolved and the URL parsed — not that the gateway answered.

## Environment variables

| Variable                                                   | Purpose                                    |
| ---------------------------------------------------------- | ------------------------------------------ |
| `ADZE_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`      | Credential for `openai-compatible` entries |
| `ADZE_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_BASE_URL`    | Base URL, when no `baseURL` is in the file  |

For comparison, the first-party kinds: `ANTHROPIC_API_KEY` / `ADZE_ANTHROPIC_API_KEY`
and `OPENAI_API_KEY` / `ADZE_OPENAI_API_KEY`, with `ANTHROPIC_BASE_URL` and
`OPENAI_BASE_URL` to redirect them.

The vendor-standard name is consulted first so an existing environment works with no
Adze configuration at all, then the `ADZE_`-prefixed name for someone who wants Adze to
use a different key than their other tools.

> **A config file is currently required, even when both variables are set.**
> `anthropic` and `openai` exist as provider entries with no configuration at all, so
> exporting `ANTHROPIC_API_KEY` is sufficient for them. `openai-compatible` has no
> built-in entry, so `ADZE_COMPATIBLE_BASE_URL` and `ADZE_COMPATIBLE_API_KEY` resolve
> against an entry that does not exist and have no effect on their own: `adze doctor`
> lists only `anthropic` and `openai`. Declare the entry in `.adze/providers.json` as
> shown above.

## Precedence

Most specific first: options passed by an embedder, then the config file, then the
environment. Environment last is deliberate — a checked-out repository's config file
should not be able to silently redirect an agent at a different endpoint than the one
the operator exported.

User-level `~/.adze/providers.json` is read before the workspace file, so the nearer
file wins per key.

## Models a gateway serves are not in the price table

`adze models` lists what the bundled price table knows, which is the first-party
catalog. A gateway model will not appear there, and that is not a failure — it means
cost reporting for that model has no source. The provider row still shows, and
`provider/model` still resolves.

## Native tool calling

ADR-0004 makes native tool calling mandatory: there is no JSON-in-a-string fallback. If
a gateway model does not support it, say so in the entry rather than letting Adze find
out mid-run:

```json
{ "kind": "openai-compatible", "baseURL": "...", "nativeToolCalling": false }
```

That marks the model `degraded` — the engine runs it without tools and every surface
reports it. This is a config key rather than a probe because there is no reliable way to
detect the capability without making a request.

## See also

- [configuration.md](configuration.md) — the wider configuration surface
- [local-testing.md](local-testing.md) — running against a local model server
- [ADR-0004](../architecture/adr/0004-tool-surface.md) — why native tool calling is required
