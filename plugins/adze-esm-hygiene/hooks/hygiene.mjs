/**
 * ESM Hygiene — the module-system half of the code conventions, enforced at the edit.
 *
 * This repository is ESM-only on Node 22+ with `moduleResolution: nodenext`: every
 * relative import carries its `.js` extension, and there is no `require`, no
 * `module.exports`, and no `__dirname`. Each of those compiles in isolation and then
 * fails at runtime or under the typechecker in a way that points nowhere near the
 * import, which is why the check lives here rather than in a post-hoc lint.
 *
 * ## Scope: added text only, source files only
 *
 * The hook judges the `replace` side of an edit, so an existing violation already in
 * the file is invisible to it. Refusing an edit because of a line it does not touch
 * would make an unrelated file unmaintainable until someone fixed a separate problem.
 * Markdown files quoting forbidden syntax are documentation, not code, and are ignored.
 *
 * ## Two events, one rule
 *
 * `edit.pre` carries `edits[].replace` and, for whole-file writes, `content`
 * (plugins/FINDINGS.md finding 1). `tool.pre` on `write` is the deliberate backstop:
 * redundant under the default edit-tool mapping, kept because a host can remap which
 * tools derive `edit.pre` and a hygiene gate should fail to allow rather than fail
 * to deny. Both read only tool-agnostic fields, never tool-specific argument names.
 *
 * `"runtime": "js"` means **unsandboxed**; the host must pass `allowUnsandboxedJs`.
 * A published build would compile this policy to `wasm32-wasip2` and need no flag.
 */

function isSource(path) {
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(path);
}

function normalize(path) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function problemIn(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined;

  if (/\brequire\s*\(\s*['"]/.test(text)) {
    return (
      `this adds 'require(...)' to an ESM-only codebase (Node 22+, moduleResolution ` +
      `nodenext). Use 'import ... from ...' instead (policy: adze.esm-hygiene).`
    );
  }
  if (/\bmodule\.exports\b/.test(text) || /(?:^|\s)exports\.\w+/.test(text)) {
    return (
      `this adds 'module.exports' or 'exports.*' to an ESM-only codebase. Export with ` +
      `'export' syntax instead (policy: adze.esm-hygiene).`
    );
  }
  if (/\b__dirname\b/.test(text) || /\b__filename\b/.test(text)) {
    return (
      `this uses '__dirname' or '__filename', which do not exist in ESM. Derive the path ` +
      `from 'import.meta.url' instead (policy: adze.esm-hygiene).`
    );
  }
  const bareImport = /(?:\bfrom\s*|\bimport\s*\(\s*|\bexport\s+[^;]*?\bfrom\s+)['"](\.[^'"]+)['"]/g;
  let match = bareImport.exec(text);
  while (match !== null) {
    const specifier = match[1];
    if (!/\.[A-Za-z0-9]+$/.test(specifier)) {
      return (
        `this adds the relative import '${specifier}' without a file extension. This ` +
        `repository uses nodenext resolution, so relative imports carry the '.js' extension ` +
        `even when the source file is TypeScript (policy: adze.esm-hygiene).`
      );
    }
    if (/\.ts$/.test(specifier)) {
      return (
        `this adds the relative import '${specifier}' with a '.ts' extension. Import the ` +
        `compiled '.js' specifier instead (policy: adze.esm-hygiene).`
      );
    }
    match = bareImport.exec(text);
  }
  return undefined;
}

function editPre(input) {
  const path = normalize(typeof input.path === 'string' ? input.path : '');
  if (!isSource(path)) return { kind: 'allow' };
  const edits = Array.isArray(input.edits) ? input.edits : [];
  for (const edit of edits) {
    const problem = problemIn(typeof edit?.replace === 'string' ? edit.replace : '');
    if (problem !== undefined) return { kind: 'deny', reason: problem };
  }
  if (typeof input.content === 'string') {
    const problem = problemIn(input.content);
    if (problem !== undefined) return { kind: 'deny', reason: problem };
  }
  return { kind: 'allow' };
}

function toolPre(input) {
  if (input.name !== 'write') return { kind: 'allow' };
  const args = input.arguments ?? {};
  const path = normalize(typeof args.path === 'string' ? args.path : '');
  if (!isSource(path)) return { kind: 'allow' };
  const problem = problemIn(typeof args.content === 'string' ? args.content : '');
  return problem === undefined ? { kind: 'allow' } : { kind: 'deny', reason: problem };
}

export function invoke(functionName, input) {
  switch (functionName) {
    case 'edit.pre':
      return editPre(input);
    case 'tool.pre':
      return toolPre(input);
    default:
      return { kind: 'allow' };
  }
}
