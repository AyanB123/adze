---
'@adze/cli': minor
---

`adze validate` now reports `tree-sitter` when a compiled grammar resolves, instead of always reporting the structural fallback. It calls `validateAsync` from `@adze/apply`, which prefers a real parse and falls back to the delimiter-and-indentation checker with `structural` when no grammar is present. Without grammars the output is unchanged; with grammars the command reports the level that actually ran rather than implying only the fallback exists.

Refs plan P1.5.
