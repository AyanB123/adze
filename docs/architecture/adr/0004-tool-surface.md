# 0004 — Bash-first tools with native tool calling

**Status:** Accepted
**Date:** 2026-08-29
**Deciders:** @AyanB123

## Context

Two independent questions get conflated: *what* capabilities the model gets, and
*how* it invokes them. The evidence points in opposite directions on the two.

**On capabilities: fewer, more general tools win.** The minimal reference harness
exposes exactly one tool — bash — and scores above 74% on SWE-bench Verified. Its
authors' argument is that instead of implementing a custom tool for every action,
the model should use the shell to its full potential. It also means the sandbox
needs nothing installed but bash.

**On invocation format: the transport matters a lot.** A harness that makes the
model emit each action as an escaped JSON string incurs a measured **7.3%
invalid-JSON rejection rate on open-weight model rollouts**, with up to four
rejections in a single run, concentrated in exactly the cheap models we care about
on cost. Native tool calling pays that tax zero times. Separately, text-only
terminal harnesses lose image-bearing tasks to vision-capable harnesses by
roughly 12 to 1.

So: keep the tool catalog small, but do not economize on how tools are called.

## Decision

**Bash-first, with a small set of structured tools that each justify their
existence. Native tool calling, mandatory. Vision as a first-class path.**

| Tool | Justification for not being plain shell |
| --- | --- |
| `bash` | The workhorse. Stateless: one subprocess per call, no session drift. |
| `read` | Line-addressed with a token budget. `cat` on a 40k-line file destroys the context window. |
| `edit` | Routes through `@adze/apply` for parse validation. `sed` cannot refuse to corrupt a file. |
| `write` | Whole-file create/replace, gate-checked and atomic. |
| `glob` | ripgrep-backed, ranked, structured. |
| `grep` | ripgrep-backed with structured match objects instead of stdout scraping. |
| `symbols` | tree-sitter symbol lookup. Precise answer to "where is X defined" for a fraction of the tokens grep costs. |
| `todo` | Explicit plan state. Measurably improves long-horizon coherence and is visible to the user. |
| `task` | Subagent with a narrowed tool allowlist. The delegation primitive. |
| `fetch` | Network reads through the gate, so a URL cannot bypass the sandbox's network policy. |

Rules:

1. **Native tool calling required.** A provider without it is `degraded`, and the
   CLI says so. We do not ship a JSON-in-a-string fallback path, because that
   path is where the 7.3% tax lives.
2. **Tool results are structured and truncated** by the engine, with an explicit
   `truncated` marker and a way to request more. Unbounded stdout is a
   context-window denial-of-service.
3. **Vision is not optional.** Images flow through the protocol as typed
   attachments to both user messages and tool results.
4. **No tool bypasses the permission gate**, including built-ins.
5. **Adding a core tool requires justification against `bash`.** The default
   answer to "should this be a tool?" is no.

## Alternatives considered

**Bash only, nothing else** — rejected. Purity costs real safety and real tokens:
`sed` cannot parse-validate an edit, and `cat` cannot budget tokens. The tools
above each buy something the shell cannot.

**Large bespoke tool catalog (the ACI thesis)** — rejected. Purpose-built tools
with linting and windowed viewers were superseded by their own authors' minimal
harness.

**MCP for everything, including built-ins** — rejected. MCP is the right *plugin*
transport but adds subprocess and serialization overhead per call. Built-ins stay
in-process; plugins use MCP.

**Persistent shell session** — rejected. Feels better (working directory and
environment persist) and is a reliability disaster: hung processes, leaked state
between calls, and unreproducible failures. Stateless subprocesses are the single
biggest stability win the reference harness reports. Working directory is passed
explicitly per call instead.

## Consequences

**Good.** Small surface to secure and document. Works with any tool-calling model.
Stateless execution makes containerization and parallelism trivial. Structured
results keep token usage predictable.

**Bad.** Models must be shell-fluent; weaker models do worse than they would with
guardrail tools. Stateless calls mean re-establishing context (`cd`) each time.
Requiring native tool calling excludes some local models.

**Costs we accept.** Losing users of models without native tool calling, rather
than shipping a code path with a known 7% failure rate. And rejecting tools that
would make weak models look better, because that optimizes for the demo rather
than the user.

## Revisit when

- A measured task class fails specifically for lack of a tool, reproduced in
  `bench`.
- Native tool calling becomes universal, making the `degraded` tier moot.
