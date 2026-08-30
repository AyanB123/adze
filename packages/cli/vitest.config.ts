import { defineConfig } from 'vitest/config';

/**
 * Deterministic styling for the CLI's output assertions.
 *
 * `styleFor(json)` in `src/output.ts` returns `colorStyle` for everything except
 * `--json`, and `picocolors` decides at import time from the ambient environment.
 * Vitest enables colour for its own reporter and propagates `FORCE_COLOR` into the
 * worker, so a command's output arrives wrapped in escapes — `ok` renders as
 * `\u001b[32mok\u001b[39m`. An assertion like `/ok\s+shell/` then cannot match,
 * because `\s+` has to span the `\u001b[39m` sitting between the two columns.
 *
 * That produced a CI failure that reproduced on the Ubuntu runner and not on
 * Windows, purely because the two runners advertise colour support differently. The
 * tests here assert on the *content* of human-facing output, not its styling, so the
 * fix is to pin the environment rather than to write regexes that tolerate escapes.
 *
 * `NO_COLOR` takes precedence over `FORCE_COLOR` inside picocolors, so this holds
 * whatever the runner or the test runner sets. It is also the mechanism `output.ts`
 * already documents, which means these tests exercise the real code path for plain
 * output rather than a test-only branch.
 *
 * Tests that need to assert on styling should inject `plainStyle` or `colorStyle`
 * directly, as `test/agent.test.ts` does.
 */
export default defineConfig({
  test: {
    env: {
      NO_COLOR: '1',
    },
  },
});
