/**
 * License Gate — the repository's dependency policy, enforced before the dependency lands.
 *
 * `CONTRIBUTING.md` and the architecture rules require two things of every new dependency:
 * its licence must be read from the actual LICENSE file and must not be copyleft or
 * source-available, and its version must go in the `catalog:` block of
 * `pnpm-workspace.yaml` rather than inline in a package's `package.json`.
 *
 * Both are checkable here, and neither is checkable by the engine.
 *
 * ## This is a fast local pre-check, not the authority
 *
 * `scripts/check-licenses.mjs` is the authority: it walks the installed tree, reads each
 * package's declared licence, and fails CI. This hook fires **before** the dependency is
 * added, which is a strictly better moment to find out and a strictly worse position to
 * judge from — it sees the text of an edit, not an installed package.
 *
 * That asymmetry sets the bias. The forbidden-identifier list below is copied from
 * `scripts/check-licenses.mjs` so the two cannot disagree about what is forbidden, and
 * where this hook is unsure it **allows**, leaving the CI gate to decide. A hook that
 * wrongly denies blocks legitimate work and gets uninstalled; a hook that wrongly allows
 * costs a CI failure at the next push. Those are not symmetric costs.
 *
 * ## Why there is no package-name-to-licence table
 *
 * The tempting implementation carries a list of well-known copyleft npm packages and
 * denies them by name. It is a bad idea in a way worth writing down: such a list is a
 * claim about facts that change without notice — several projects in this ecosystem have
 * relicensed between minor versions, in both directions — and a stale entry either blocks a
 * package that is now permissive or waves through one that is not. A wrong licence claim is
 * worse than no claim, because it gets believed.
 *
 * So this hook checks **licence identifiers that appear in the edit itself**, plus one
 * package this repository has already documented (`ovsx`, EPL-2.0, named in
 * `pnpm-workspace.yaml` as deliberately absent), plus the *process* rule that actually
 * catches licence problems: a dependency added without going through the catalog is a
 * dependency whose LICENSE nobody stopped to read.
 *
 * `"runtime": "js"` means **unsandboxed**; the host must pass `allowUnsandboxedJs`.
 */

/**
 * Forbidden licence identifiers, copied from `scripts/check-licenses.mjs`.
 *
 * Prefix matching rather than exact, because the strings in the wild vary: `GPL-3.0-only`,
 * `GPL-3.0-or-later`, `AGPL-3.0`. LGPL is on the list deliberately — its weak copyleft is
 * often described as safe for dynamic linking, and that argument does not transfer to a
 * bundled JavaScript application where the boundary between linking and inclusion is not
 * meaningful.
 */
const DENIED = [
  'AGPL',
  'LGPL',
  'GPL',
  'EPL',
  'MPL-1',
  'SSPL',
  'BUSL',
  'FSL',
  'COMMONS CLAUSE',
  'COMMONS-CLAUSE',
  'ELASTIC-2',
  'UNLICENSED',
];

/** Packages this repository has already established are unusable, with the reason. */
const KNOWN_UNUSABLE = {
  ovsx: 'EPL-2.0, which this repository forbids. `pnpm-workspace.yaml` records that it is deliberately absent and that publishing to Open VSX invokes it through `pnpm dlx` so it never enters the dependency graph.',
};

/** JSON keys in a `package.json` whose value is a version but not a dependency. */
const NOT_A_DEPENDENCY = new Set([
  'version',
  'packageManager',
  'name',
  'node',
  'pnpm',
  'npm',
  'main',
  'module',
  'types',
  'license',
  'engines',
  'type',
]);

const VERSION_RANGE = /^(?:[\^~]|>=?|<=?|=)?\d+\.\d+/;
const PACKAGE_NAME = /^(?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/;

function isDeniedLeaf(leaf) {
  const upper = leaf
    .trim()
    .toUpperCase()
    .replace(/^\(|\)$/g, '');
  return DENIED.find((denied) => upper.startsWith(denied));
}

/**
 * Classify an SPDX expression.
 *
 * Mirrors `scripts/check-licenses.mjs`: `AND` is checked before `OR`, so
 * `MIT AND GPL-3.0` is denied while `(MIT OR GPL-3.0)` is a genuine choice and permitted.
 * Reading a dual licence as forbidden because one option is would deny a large amount of
 * perfectly usable code.
 *
 * The operators must be **whitespace-delimited**, which is not a detail. SPDX identifiers
 * contain the substring `or`: `AGPL-3.0-or-later` matches `/\bOR\b/i`, and splitting on that
 * yields the leaves `AGPL-3.0-` and `-later`. The first is forbidden and the second is not,
 * so an `OR` reading — one acceptable operand is enough — would classify a strong copyleft
 * licence as permitted. That was a real bug here, caught by the test asserting
 * `AGPL-3.0-or-later` is denied.
 */
function deniedLicence(expression) {
  const text = expression.trim().replace(/^\(|\)$/g, '');
  if (/\s+AND\s+/i.test(text)) {
    return text
      .split(/\s+AND\s+/i)
      .map((leaf) => isDeniedLeaf(leaf))
      .find((hit) => hit !== undefined);
  }
  if (/\s+OR\s+/i.test(text)) {
    const leaves = text.split(/\s+OR\s+/i);
    // Permitted if any option is not forbidden: the choice is the point of a dual licence.
    if (leaves.some((leaf) => isDeniedLeaf(leaf) === undefined)) return undefined;
    return isDeniedLeaf(leaves[0]);
  }
  return isDeniedLeaf(text);
}

function isManifestPath(path) {
  return /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml|LICENSE(?:\.\w+)?)$/i.test(path);
}

function isPackageJson(path) {
  return /(?:^|\/)package\.json$/i.test(path);
}

/** A `"license": "<expr>"` or `license: <expr>` line whose expression is forbidden. */
function licenceProblem(text, path) {
  for (const line of text.split('\n')) {
    const match = /["']?licen[cs]e["']?\s*:\s*["']?([^"',\n]+)["']?/i.exec(line);
    if (match === null) continue;
    const hit = deniedLicence(match[1]);
    if (hit === undefined) continue;
    return (
      `this would record the licence '${match[1].trim()}' in '${path}'. ${hit} is on this ` +
      `repository's forbidden list (scripts/check-licenses.mjs): copyleft and ` +
      `source-available licences are incompatible with shipping an Apache-2.0 product. ` +
      `Find a permissively licensed alternative — Apache-2.0, MIT, BSD, ISC, Unlicense, or ` +
      `CC0 — or implement the part you need.`
    );
  }
  return undefined;
}

/** A dependency added with an inline version instead of `catalog:`. */
function catalogProblem(text, path) {
  if (!isPackageJson(path)) return undefined;
  for (const line of text.split('\n')) {
    const match = /^\s*"([^"]+)"\s*:\s*"([^"]+)"/.exec(line);
    if (match === null) continue;
    const [, key, value] = match;
    if (NOT_A_DEPENDENCY.has(key) || !PACKAGE_NAME.test(key)) continue;
    if (!VERSION_RANGE.test(value)) continue;

    const known = KNOWN_UNUSABLE[key];
    if (known !== undefined) {
      return `'${key}' is ${known} Do not add it as a dependency.`;
    }
    return (
      `'"${key}": "${value}"' pins a version inline in '${path}'. This repository keeps every ` +
      `dependency version in the 'catalog:' block of pnpm-workspace.yaml and references it as ` +
      `'catalog:', so fifteen packages cannot drift onto four versions of the same library. ` +
      `Add '${key}: ${value}' to the catalog and write '"${key}": "catalog:"' here. Read the ` +
      `package's actual LICENSE file before you do — the GitHub licence API reports ` +
      `'NOASSERTION' for packages ranging from fine to categorically unusable, so the API ` +
      `field is not a verdict.`
    );
  }
  return undefined;
}

function editPre(input) {
  const path = typeof input.path === 'string' ? input.path : '';
  if (!isManifestPath(path)) return { kind: 'allow' };

  const edits = Array.isArray(input.edits) ? input.edits : [];
  for (const edit of edits) {
    const text = typeof edit?.replace === 'string' ? edit.replace : '';
    const licence = licenceProblem(text, path);
    if (licence !== undefined) return { kind: 'deny', reason: licence };
    const catalog = catalogProblem(text, path);
    if (catalog !== undefined) return { kind: 'deny', reason: catalog };
  }
  return { kind: 'allow' };
}

/**
 * `bash`: a package manager command that adds a dependency.
 *
 * Denied rather than rewritten. `pnpm add <pkg>` writes an inline version into the nearest
 * `package.json`, which is the thing the catalog rule exists to prevent, and there is no
 * rewrite that turns it into the correct two-step workflow — the correct workflow involves
 * reading a LICENSE file, which is a human step and not a flag.
 *
 * `write` is handled here too, because a whole-file replacement of a `package.json` does
 * not carry its content in the `edit.pre` payload. See plugins/FINDINGS.md finding 1.
 */
function toolPre(input) {
  const args = input.arguments ?? {};

  if (input.name === 'write') {
    const path = typeof args.path === 'string' ? args.path : '';
    if (!isManifestPath(path)) return { kind: 'allow' };
    const text = typeof args.content === 'string' ? args.content : '';
    const licence = licenceProblem(text, path);
    if (licence !== undefined) return { kind: 'deny', reason: licence };
    const catalog = catalogProblem(text, path);
    return catalog === undefined ? { kind: 'allow' } : { kind: 'deny', reason: catalog };
  }

  if (input.name !== 'bash') return { kind: 'allow' };
  const command = typeof args.command === 'string' ? args.command : '';
  // Flags are skipped before the package name, so `pnpm add -D ovsx` is recognised. A
  // pattern that required the package to be the first token after the subcommand read
  // `-D` as the package and then matched nothing, which allowed exactly the invocation a
  // developer is most likely to type for a dev dependency.
  const add =
    /(?:^|\s|&&|;)(?:pnpm|npm|yarn|bun)\s+(?:add|install|i)((?:\s+-{1,2}[\w-]+(?:=\S+)?)*)\s+([^-\s]\S*)/.exec(
      command,
    );
  if (add === null) return { kind: 'allow' };

  // Strip a version suffix: `some-library@^2.0.0` -> `some-library`, while leaving the
  // leading `@` of a scoped name alone.
  const requested = add[2].replace(/(?<=.)@[^@/]*$/, '');
  const known = KNOWN_UNUSABLE[requested];
  if (known !== undefined) {
    return { kind: 'deny', reason: `'${requested}' is ${known} Do not add it as a dependency.` };
  }

  return {
    kind: 'deny',
    reason:
      `adding '${requested}' from the command line writes an inline version into a ` +
      `package.json and skips two required steps. Read the package's actual LICENSE file ` +
      `first — Apache-2.0, MIT, BSD, ISC, Unlicense, and CC0 are allowed; GPL, AGPL, LGPL, ` +
      `EPL, SSPL, BUSL, FSL, and Commons Clause are not, and the GitHub licence API's ` +
      `'NOASSERTION' is not a verdict either way. Then put the version in the 'catalog:' ` +
      `block of pnpm-workspace.yaml and reference it as '"${requested}": "catalog:"'. If the ` +
      `package needs an install script, it also has to be listed in 'onlyBuiltDependencies' ` +
      `and justified in the PR.`,
  };
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
