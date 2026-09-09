---
'@adze/cli': minor
---

Resolve the full `.adze/config.jsonc` system: engine, sandbox, approvals, command rules, plugins, workflows, and gallery.

Until now only the provider slice of configuration existed (`.adze/providers.json`,
strict JSON). `run` and `chat` now resolve every other setting through one chain —
CLI flags, then environment, then workspace `.adze/config.jsonc`, then
`~/.adze/config.jsonc`, then documented defaults — so an absent flag resolves to the
config chain rather than the default. The file is JSONC (`//` and `/* */` comments
allowed); `chat /init` scaffolds it with every section documented and stamps
`engines.adze` with the running engine version, and a committed
`config.schema.json` backs the `$schema` reference the scaffold points at.

`sandbox.writableRoots` and `sandbox.allowedNetworkHosts` are reachable from the CLI
for the first time (config file or `ADZE_WRITABLE_ROOTS` / `ADZE_ALLOWED_HOSTS`);
the workspace root stays in the writable set and config entries widen it rather than
replacing it. `adze doctor` grows a `Config` section reporting every resolved value
with its source, the files read, and every warning — and its `Sandbox` section is
built from those same resolved values, so it reports the boundary in force. The
`run` preamble and `chat` banner print config warnings (unknown keys, narrowed
values, dropped rules) next to the effective sandbox/approval line they change.

Fail-closed throughout: unknown keys warn per file with a dotted path and are
stripped, never silently ignored; a typo'd `sandbox.mode` narrows to `read-only`
and a typo'd `approvals.policy` to `never`; a malformed file refuses the run with
exit code 2 while `doctor` reports it as unreadable. A `forbid` from any layer
drops an overlapping `allow` with a warning — a refusal is never weakened into a
grant, whatever the layer. A Microsoft Marketplace gallery URL is rejected per
ADR-0009. Approval/sandbox semantics (ADR-0007) and prefix matching against the
requested command (ADR-0013) are unchanged.
