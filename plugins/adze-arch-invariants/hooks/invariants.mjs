/**
 * Architecture Invariants — the package dependency graph, enforced at the edit.
 *
 * `docs/architecture/README.md` draws a graph and `CONTRIBUTING.md` lists the rules a
 * review will enforce:
 *
 * ```
 * protocol → core → sdk → surfaces
 * providers, apply, retrieval, sandbox, mcp, plugin-sdk → core
 * ```
 *
 * Every rule below is one of those, restated as a check on an import specifier. This is
 * the most mechanical policy in this directory and the one whose violations are hardest to
 * spot at review, because a single wrong import compiles, passes tests, and is only visible
 * to someone holding the whole graph in their head.
 *
 * ## Why a hook and not a lint rule
 *
 * A lint rule would be better, and it would run after the edit. This runs before it, which
 * matters for a specific reason: when a model discovers it needs something from a package it
 * is not allowed to import, the useful moment to intervene is while it is still deciding how
 * to get it. A denial at that point, naming the rule and the correct route, is one round of
 * feedback. A lint failure ten minutes later is a debugging session against code that has
 * already been written around the wrong import.
 *
 * ## Scope: added text only
 *
 * The hook sees the `replace` side of an edit, so it judges what is being *added*. An
 * existing violation already in the file is invisible to it, and that is the correct scope
 * for a pre-edit gate — refusing an edit because of a line the edit does not touch would
 * make an unrelated file unmaintainable until someone fixed a separate problem.
 *
 * `"runtime": "js"` means **unsandboxed**; the host must pass `allowUnsandboxedJs`.
 */

/** Surface packages. The engine may not import these (invariant 1). */
const SURFACES = ['cli', 'vscode', 'ide', 'hub'];

/** Individually swappable service packages. They may not import each other. */
const SERVICES = ['providers', 'apply', 'retrieval', 'sandbox', 'mcp'];

/** Where `@adze/sdk` may be imported from: surfaces and examples only. */
const SDK_CONSUMERS = [/^apps\//, /^examples\//, /^packages\/cli\//, /^packages\/ide\//];

/** Every import, re-export, `require`, and dynamic `import()` specifier in a block of text. */
function specifiers(text) {
  const found = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
  let match = pattern.exec(text);
  while (match !== null) {
    found.push(match[1]);
    match = pattern.exec(text);
  }
  return found;
}

/** `packages/core/src/x.ts` -> `core`. `undefined` for anything outside `packages/`. */
function packageOf(path) {
  const match = /^packages\/([^/]+)\//.exec(path.replace(/\\/g, '/').replace(/^\.\//, ''));
  return match === null ? undefined : match[1];
}

/** `@adze/core` -> `core`. `undefined` for anything that is not an Adze package. */
function adzePackage(specifier) {
  const match = /^@adze\/([^/]+)/.exec(specifier);
  return match === null ? undefined : match[1];
}

/** Invariant 1: the engine renders nothing, and imports no surface. */
function engineImportProblem(owner, imported, specifier) {
  if (owner !== 'core' && owner !== 'protocol') return undefined;
  if (imported !== undefined && SURFACES.includes(imported)) {
    return (
      `'@adze/${owner}' may not import '${specifier}'. The engine renders nothing and must ` +
      `not depend on a surface (ADR-0001, invariant 1): an engine that imports the CLI cannot ` +
      `be embedded in the extension. If a surface can do something the engine needs, the ` +
      `missing piece is a message in '@adze/protocol', not an import.`
    );
  }
  if (owner === 'core' && imported === 'sdk') {
    return (
      `'@adze/core' may not import '@adze/sdk'. The dependency runs the other way — ` +
      `'protocol → core → sdk → surfaces' — and reversing it makes the engine depend on its ` +
      `own public wrapper.`
    );
  }
  return undefined;
}

/** `@adze/protocol` depends on nothing but zod. A contract with dependencies is not one. */
function protocolImportProblem(owner, specifier) {
  if (owner !== 'protocol') return undefined;
  if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier === 'zod') {
    return undefined;
  }
  return (
    `'@adze/protocol' may not import '${specifier}'. The protocol depends on nothing but ` +
    `'zod', because a contract with dependencies is not a contract — every surface and every ` +
    `third-party provider has to be able to depend on it without inheriting anything else.`
  );
}

/** Service packages stay individually swappable, so they may not import each other. */
function serviceImportProblem(owner, imported, specifier) {
  if (owner === undefined || !SERVICES.includes(owner)) return undefined;
  if (imported === undefined || !SERVICES.includes(imported) || imported === owner) {
    return undefined;
  }
  return (
    `'@adze/${owner}' may not import '${specifier}'. Service packages depend on '@adze/core' ` +
    `and never on each other, so each one stays individually swappable and testable. If they ` +
    `genuinely need to share something, it belongs in core or in a new package they both ` +
    `depend on.`
  );
}

/** Nothing in product code may import from `bench/`. */
function benchImportProblem(path, specifier) {
  if (path.startsWith('bench/')) return undefined;
  if (!/(?:^|\/)bench\//.test(specifier) && !specifier.startsWith('@adze/bench')) {
    return undefined;
  }
  return (
    `'${path}' may not import '${specifier}'. Nothing under 'bench/' may be imported by ` +
    `product code: benchmark code that can influence what ships means the benchmark has ` +
    `stopped measuring the product (ADR-0011).`
  );
}

/** Only surfaces and examples import `@adze/sdk`. */
function sdkImportProblem(path, imported, specifier) {
  if (imported !== 'sdk') return undefined;
  if (SDK_CONSUMERS.some((allowed) => allowed.test(path))) return undefined;
  if (path.startsWith('packages/sdk/')) return undefined;
  return (
    `'${path}' may not import '${specifier}'. '@adze/sdk' is the public embedding API and is ` +
    `imported by surfaces only. A package inside the engine reaching for it is a sign the ` +
    `thing it wants belongs in core.`
  );
}

/** The literal escape byte, built at runtime so this source file contains no control character. */
const ESC = String.fromCharCode(27);

/**
 * Invariant 1's other half: the engine emits no display output.
 *
 * Terminal escapes and colour libraries are the detectable form. A `console.log` is not
 * checked here — Biome's `noConsole` rule already covers it, and duplicating a lint rule in
 * a policy hook means two places to update when the rule changes.
 */
function renderingProblem(owner, text) {
  if (owner !== 'core' && owner !== 'protocol') return undefined;
  const colour = specifiers(text).find((specifier) =>
    ['chalk', 'picocolors', 'kleur', 'ansi-colors', 'colorette', 'cli-color'].includes(specifier),
  );
  if (colour !== undefined) {
    return (
      `'@adze/${owner}' may not import '${colour}'. The engine returns structured events and ` +
      `surfaces render them (ADR-0001, invariant 1). Colour in an engine string reaches a ` +
      `VS Code webview as escape bytes.`
    );
  }
  // Two forms. `\u001b[` written as source text is what appears in a diff; the literal
  // escape byte is the form that is invisible in one, which is why both are checked and
  // why the byte is compared rather than matched — a control character inside a regex
  // literal is itself a lint error, for the same reason it is worth detecting here.
  const asSource = /\\u001[bB]\[|\\x1[bB]\[/.test(text);
  if (asSource || text.includes(`${ESC}[`)) {
    return (
      `'@adze/${owner}' may not emit a terminal escape sequence. The engine renders nothing; ` +
      `return a structured event and let each surface decide how to show it.`
    );
  }
  return undefined;
}

/** Every rule, against one block of added text destined for one path. */
function problemIn(path, text) {
  const owner = packageOf(path);

  const rendering = renderingProblem(owner, text);
  if (rendering !== undefined) return rendering;

  for (const specifier of specifiers(text)) {
    const imported = adzePackage(specifier);
    const problem =
      engineImportProblem(owner, imported, specifier) ??
      protocolImportProblem(owner, specifier) ??
      serviceImportProblem(owner, imported, specifier) ??
      benchImportProblem(path, specifier) ??
      sdkImportProblem(path, imported, specifier);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** Only source files carry imports. A markdown file quoting one is documentation. */
function isSource(path) {
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(path);
}

function normalize(path) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function editPre(input) {
  const path = normalize(typeof input.path === 'string' ? input.path : '');
  if (!isSource(path)) return { kind: 'allow' };

  const edits = Array.isArray(input.edits) ? input.edits : [];
  for (const edit of edits) {
    const problem = problemIn(path, typeof edit?.replace === 'string' ? edit.replace : '');
    if (problem !== undefined) return { kind: 'deny', reason: problem };
  }
  return { kind: 'allow' };
}

/** Whole-file writes, whose content `edit.pre` cannot see. See plugins/FINDINGS.md. */
function toolPre(input) {
  if (input.name !== 'write') return { kind: 'allow' };
  const args = input.arguments ?? {};
  const path = normalize(typeof args.path === 'string' ? args.path : '');
  if (!isSource(path)) return { kind: 'allow' };

  const problem = problemIn(path, typeof args.content === 'string' ? args.content : '');
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
