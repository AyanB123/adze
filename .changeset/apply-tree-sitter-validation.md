---
'@adze/apply': minor
---

`validator: 'tree-sitter'` is now producible. When a compiled grammar resolves from the configured directory (`GrammarOptions.directory`, else `$ADZE_GRAMMAR_DIR`, else `<root>/.adze/grammars`), validation is a real tree-sitter parse that rejects on error and missing nodes; without grammars it falls back to the structural checker exactly as before and reports `structural`, never `tree-sitter`. `validate()` stays synchronous and structural-only, and the new async `validateAsync()` entry plus `ApplyOptions.grammarOptions` carry the grammar configuration. This completes the validation half of ADR-0005, so no new ADR.

Refs plan P1.1.
