# ESM Hygiene

Denies CommonJS syntax and extensionless relative imports in source files, before the
edit lands.

Denied in `packages/`, `apps/`, and `bench/` source: `require(...)`,
`module.exports`, `__dirname` / `__filename`, a relative import without an extension,
and a relative import ending in `.ts`. The fix is always named: use `import`, use
`export`, derive the path from `import.meta.url`, and write the `.js` specifier that
`moduleResolution: nodenext` resolves.

The hook reads `edits[].replace` and whole-file `content` on `edit.pre`, with a
`tool.pre` backstop on `write`. The `edit.pre` entry carries a host-side `paths`
filter so the guest is never entered for documentation. The module is a `.mjs` dev
module: `runtime: "js"` runs unsandboxed and needs `allowUnsandboxedJs`. A published
build would compile to `wasm32-wasip2`.
