---
'@adze/cli': minor
'@adze/plugin-sdk': minor
---

Add local-only `adze plugin` management: `validate`, `list`, `dev`, `add`, `remove`.

`adze plugin validate <path>` runs every static gate without executing plugin
code: the manifest parses (unicode scan + schema), the license is allowlisted
for an Apache-2.0 product, `engines.adze` satisfies the running engine, every
environment variable a tool reads is declared in `permissions.env`, hook
`tools`/`paths` filters and provider patterns compile as globs, referenced
files exist and parse, and no command or agent collides with the installed set.
Exit 0 passes, 1 fails, 2 is a usage error, and `--json` emits the gates.

`adze plugin add <local-path | git-url>` shows the plugin's id, license,
namespace, permissions, and contributions, then asks for consent before
recording anything — pass `--yes` in CI — and executes nothing before that
consent. `list` shows the installed set and the dev override, `dev <path>`
points a live override at a directory (shadowing the installed same id, read on
every load, bannered in `doctor` and run trajectories), and `remove <id>`
removes one. State lives in `.adze/plugins/` (gitignored); there is no registry
service, per ADR-0008.

Hook entries may now scope themselves with `tools` (tool names) and `paths`
(edit-path globs in the same syntax as context-provider patterns). The host
applies both before guest dispatch — OR within each list, AND across the two —
an invalid glob is a load error, and a skipped dispatch is recorded as a
`skipped` hook record rather than silently dropped.

Slash-command and subagent names are now checked across plugins the way
`@`-triggers already were: `buildCommandRegistry` and `buildAgentRegistry` are
the single funnels every surface assembles from, the first loaded entry wins,
and the later one is refused with a `duplicate-name` diagnostic.

The WASM position is unchanged: `wasm32-wasip2` is a seam, not a runtime, so a
`.wasm` module refuses loudly with `module-unloadable`, and `runtime: "js"`
still needs the `allowUnsandboxedJs` host opt-in. Refs plan P1.2.
