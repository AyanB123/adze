# 0013 — Command rules match the requested command, not the executed argv

**Status:** Accepted
**Date:** 2026-08-30
**Deciders:** @AyanB123

## Context

The permission gate supports command-prefix rules — `allow`, `prompt`, `forbid` —
so a specific command can be permitted or refused without moving the whole sandbox
boundary. [ADR-0007](0007-sandbox-and-permissions.md) makes them load-bearing:
because no platform ships OS-level containment today, every command reaches the
gate as `gate-only` and is prompted, and the gate's own documentation names prefix
rules as the intended remedy, with `npm test` as the worked example.

They did not work.

The `bash` tool declares its effect with the argv it will execute, which wraps the
model's command in a shell:

```ts
{ kind: 'command', command: ['bash', '-lc', args.command], cwd }
```

and the gate matched rules against that argv joined with spaces. So a rule's prefix
was always compared against a string beginning `bash -lc`. Two consequences, both
found by the first end-to-end agent run against a real model:

- **`--forbid "rm "` could not refuse `rm -rf /`.** The flag's help promises to
  "refuse a command prefix outright, never offered for approval", and against a
  shell command it could refuse nothing. Anything the model ran through `bash` was
  outside the reach of every `forbid` rule.
- **`--allow "npm test"` never fired.** The documented remedy was inert, so the only
  way to make a rule match at all was to write `--allow "bash -lc"` — which grants
  every shell command, the opposite of the narrow permission the user was asking
  for. During the live run this was the only way to get past the approval prompt.

The `forbid` case is the serious one. A user who writes a prohibition and gets
silence has been told a boundary exists where none does, which is the specific
failure mode ADR-0007 exists to avoid.

## Decision

**Rules match the command the model asked to run.**

The `command` effect gains an optional `requested` field carrying the command as the
model requested it, before any shell wrapper. `classifyCommand` matches rules
against `requested` when present and against the joined argv otherwise, so a tool
that executes a program directly is unaffected.

The argv keeps its existing roles unchanged: it is what gets executed, what is shown
in an approval prompt, and what forms the approval-cache key. Only rule matching
moves.

This is a behaviour change, not only a fix. `--allow "bash -lc"` previously matched
every shell command and now matches nothing. That is intended: it was never a
permission anyone meant to grant, only the accidental way to make matching work.

## Alternatives considered

### Match against both the argv and the requested command — rejected

Superficially safer for `forbid`, since either could trigger a refusal. But rule
selection is longest-prefix-wins, so `--allow "bash -lc"` (9 characters) would
outrank `--forbid "rm "` (3) and a user's own broad allow would silently defeat
their narrow prohibition. A policy whose outcome depends on which of two strings
happened to be longer is not one anybody can reason about while it matters.

### Strip the shell prefix inside the gate — rejected

The gate would look for a known wrapper in the argv and match against the remainder.
It works today and is fragile by construction: the shell prefix is configurable
(`BashToolOptions.shellPrefix`), so the gate would be pattern-matching on a
convention owned by a tool. The tool already knows what the model asked for and can
simply say so.

### Leave matching alone and document the wrapper — rejected

Telling users to write `--allow "bash -lc npm test"` makes the argv part of the
public interface, makes rules break if the shell prefix ever changes, and leaves
`forbid` unable to express "never run `rm`". It documents a defect rather than
removing it.

### Have the gate refuse rules it cannot apply — rejected as insufficient

Erroring on a rule that matches nothing would at least surface the problem instead
of failing silently, and it is a real improvement over the old behaviour. But it
still leaves the user with no way to express the policy they wanted.

## Consequences

### Good

- `forbid` can express a prohibition on shell commands, which is what it claims.
- The remedy ADR-0007 documents now functions, so a no-containment platform has a
  usable narrow-permission story.
- Rules are written against what the user reads in the approval prompt, not against
  an implementation detail of the `bash` tool.
- Tools that execute a program directly need no changes.

### Bad

- A behaviour change to the permission model before 1.0. Anyone relying on
  `--allow "bash -lc"` loses a blanket grant, and they will notice as extra prompts.
- Two notions of a command now exist in the effect type. `requested` needs its
  docstring read to be used correctly.

### Costs we accept

- **A tool can influence its own policy subject** by choosing what it puts in
  `requested`. That is a real widening of trust in the tool layer, and it is
  acceptable because tools are first-party code in the engine, whereas rules exist
  to constrain the *model*. A plugin-supplied tool must never set `requested`
  itself; if plugins ever declare command effects, that needs its own ADR.

## Revisit when

- Plugins can contribute tools that declare command effects. The trust note above
  becomes load-bearing and needs enforcing rather than documenting.
- OS-level containment ships on a platform, which lowers how much weight prefix
  rules have to carry.
