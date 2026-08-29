# @adze/providers

The model gateway. Implements `@adze/core`'s `ModelProvider` seam against **Anthropic**,
**OpenAI**, and **any OpenAI-compatible endpoint**.

The third one is what keeps this package finite. OpenRouter, a local llama.cpp or Ollama
server, vLLM, and any corporate gateway all speak that protocol, so pointing Adze at one
is configuration rather than a new adapter to write and maintain.

```ts
import { createGateway } from '@adze/providers';

const { gateway, model } = createGateway({ modelRef: 'anthropic/claude-sonnet-4-5' });
// pass `gateway` as `provider` to `new Engine({ ... })`
```

## Native tool calling, with no fallback

Tools cross as JSON Schema through the AI SDK's native tool-calling path and come back as
parsed arguments. **There is no code path in this package that asks a model to emit JSON
in a string.** ADR-0004 measured that transport at a **7.3% invalid-JSON rejection rate**
on open-weight rollouts, concentrated in exactly the cheap models an open-source tool
competes on, and shipping a fallback would mean shipping a path with a known 7% failure
rate.

A model without native tool calling is `degraded`: the engine reports it, runs the turn
without tools, and every surface says so. The gateway's part of that contract is to report
the fact and to **refuse** rather than degrade quietly if tools are sent to such a model
anyway.

The SDK's own tool loop is disabled (`stopWhen: stepCountIs(1)`) and the tools carry no
`execute`. Dispatch, the permission gate, truncation, hooks, and the linear history all
belong to `@adze/core` — a tool the SDK executed would be a tool that never passed the
gate.

## Usage and cost

Usage is split three ways and the buckets **do not overlap**, so the prompt is
`inputTokens + cachedInputTokens`.

The AI SDK reports `inputTokens` as the *whole* prompt with the cache split in
`inputTokenDetails`. Copying that field across would count every cached token twice, and
at the >85% cache hit rate the epoch design targets that overstates prompt cost by roughly
**1.85×** — plausible-looking, and matching no invoice. `src/usage.ts` does the one
subtraction that avoids it, and `test/usage.test.ts` is what keeps it done.

Prices live in **`src/catalog.json`**, not in code. A contributor correcting a rate edits
one JSON file. The table is parsed with Zod at import, so a duplicated id or a
string-typed price fails at startup rather than producing a cost of `NaN` and a spend
budget that never triggers.

**An unpriced model reports `undefined`, never zero.** That is load-bearing: core refuses
a `maxSpendUsd` budget it cannot compute, and a zero here would turn that refusal into a
ceiling that silently never fires. Every model behind a local endpoint is unpriced, and
saying so is the correct answer rather than a gap.

### What the price table does not model

Stated in `catalog.json` under `notModelled`, and repeated here because it affects any
number you quote:

- **Cache-write premium.** Anthropic bills a 5-minute cache write at 1.25× base input
  (2× for an hour); OpenAI bills writes at 1.25× on the models that charge for them. The
  protocol's `Usage` has three buckets and no fourth, so write tokens are counted at the
  base input rate. Reported cost is therefore a **lower bound on the step that opens a
  cache epoch and exact on every step after it**, short by at most 0.25× of the write
  tokens' base cost. The epoch assembler exists to make the later steps the common case.
- **Long-context tiers.** OpenAI prices a request above 272K input tokens at 2× input and
  1.5× output for the whole request; the table holds short-context rates.
- **Non-standard service tiers.** Batch, Flex, Fast mode, and the 1.1× data-residency
  multiplier are absent. Adze issues standard-tier requests only.
- **Context windows** are recorded only where a first-party page states one. `undefined`
  means unverified, not unlimited — an invented number would be a capability claim with no
  evidence behind it.

## Configuration

Three sources, most specific first: explicit options, then a config file, then the
environment.

| Provider | API key | Base URL |
| --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY`, `ADZE_ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` |
| `openai` | `OPENAI_API_KEY`, `ADZE_OPENAI_API_KEY` | `OPENAI_BASE_URL` |
| `openai-compatible` | `ADZE_COMPATIBLE_API_KEY` | `ADZE_COMPATIBLE_BASE_URL` (required) |

`.adze/providers.json`, read from the user's home directory and then the workspace:

```json
{
  "providers": {
    "openrouter": {
      "kind": "openai-compatible",
      "baseURL": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    },
    "local": {
      "kind": "openai-compatible",
      "baseURL": "http://localhost:11434/v1",
      "defaultModel": "qwen2.5-coder",
      "nativeToolCalling": false
    }
  },
  "defaultModel": "openrouter/anthropic/claude-sonnet-4-5"
}
```

`apiKey` is accepted in the file, but **prefer `apiKeyEnv`** — a variable *name* rather
than the value. A secret in a file inside a git working tree is one `git add -A` from being
public, and the loader cannot prevent that; naming the variable instead of the value can.

An unknown key in the file is rejected rather than ignored, because a silently-ignored typo
is a configuration that does nothing and reports success.

The full `.adze/config.jsonc` system — schema, layering, `AGENTS.md` conventions — is M2.
See `docs/roadmap.md`.

## Credentials never leave

Every provider message passes through `redact()` before it can reach a terminal, a log, or
a trajectory artifact. An `APICallError` carries the request URL, the request body, and
sometimes the response headers, which is the most likely way an API key ends up in a
published benchmark report.

Two mechanisms, and both are needed. **Exact-value redaction** removes the keys this
process holds, wherever and however they are framed, including percent-encoded in a URL.
**Pattern redaction** is the backstop for a key this process was never told about — one
baked into a `baseURL`, or belonging to a different provider and echoed by a proxy.
Patterns cannot be complete, which is why they are second rather than only.

Redaction is one-way. A partially masked key shortens a brute-force search and answers no
debugging question.

## Errors

`ProviderConfigurationError` is raised before any request, for something fixable right
now, and it names the exact environment variable. `ProviderRequestError` is raised after a
request failed and carries a classification, because an expired key and a rate limit need
opposite advice: waiting fixes a 429 and never fixes a 402. Neither ever carries a stack
trace, and neither is built from an unredacted provider error.

Retries use the AI SDK's exponential backoff, driven by the SDK's own
`APICallError.isRetryable` — so 429 and 5xx retry and 401 does not. Reimplementing that
classification here would mean maintaining a second, worse copy of it. `maxRetries`
defaults to 2 and is configurable per provider.

## Tests make no network call

The whole suite runs against the AI SDK's `MockLanguageModelV4`, injected through the
gateway's `languageModel` factory seam. **Zero network, zero keys, zero spend.**
`test/invariants.test.ts` asserts that mechanically: no test imports a real adapter, none
configures a live host as a base URL, and none reads the ambient environment.

`test/engine-integration.test.ts` drives the gateway through the real `@adze/core` turn
machine, because this package is the first consumer of that seam and a mismatch between the
interface as written and as used would otherwise appear for the first time in a live run.

A live run requires your own key and is manual. See the CLI's README.

## Known limitations

- `ModelProvider.nativeToolCalling` is a property of the provider in core's interface, but
  native tool calling is a property of the *model*. The gateway is constructed with the
  model the session will use and reports that model's capability, which is exact in
  practice because the CLI resolves `--model` before building the engine. A per-turn model
  override onto a model with a different capability is **refused** rather than served
  degraded.
- `ModelSelection.effort` maps to OpenAI's `reasoningEffort`. Anthropic exposes a thinking
  *token budget* rather than an effort level, so setting `effort` on an Anthropic model is
  refused instead of silently dropped. Translating one into the other would mean Adze
  inventing the budget, which a reproducible run cannot report honestly.
- Anthropic's 1-hour cache TTL is not used; the breakpoint is the 5-minute ephemeral form.

## Design rationale

- `docs/architecture/adr/0003-agent-loop.md` — the turn machine this plugs into
- `docs/architecture/adr/0004-tool-surface.md` — why native tool calling is mandatory
- `docs/architecture/adr/0011-benchmark-harness.md` — why cache hit rate is a headline
  metric
