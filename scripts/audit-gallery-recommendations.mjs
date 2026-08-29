#!/usr/bin/env node
/**
 * Audit the VS Code extension recommendations in `product.json`.
 *
 *   node scripts/audit-gallery-recommendations.mjs [--product <path>] [--namespaces <path>] [--json]
 *
 * ### The vulnerability this closes
 *
 * A Code-OSS fork inherits seven recommendation maps from upstream `product.json`,
 * every entry of which names a Microsoft Marketplace publisher. Pointed at a
 * different registry — which ADR-0009 requires, because the Marketplace Terms of Use
 * prohibit fork access — those become recommendations for publisher namespaces that
 * nobody has claimed on the new registry. Anyone can claim one and ship an update to
 * users who were told to install it by the editor itself. That is the exact vector
 * used against four commercial VS Code forks in late 2025.
 *
 * So this is a build gate, not a report: a recommended ID whose namespace we have not
 * claimed fails the build.
 *
 * ### Why the check is offline
 *
 * It resolves against a committed manifest of namespaces we have claimed, rather than
 * querying the gallery over the network. Three reasons, in order of weight:
 *
 *  1. Local-first is a product promise, and a build step that reaches the network
 *     needs a reason rather than a convenience.
 *  2. The question being asked is "have *we* claimed this namespace?", and we are
 *     the authority on that. A network round-trip would not make the answer more
 *     true, only slower and flakier.
 *  3. A gate that fails when a registry is briefly unreachable gets disabled.
 *
 * Keeping the manifest current is part of operating a self-hosted gallery, and a
 * stale manifest surfaces here as a failure rather than as silence.
 *
 * ### Today
 *
 * There is no `product.json` until milestone M4 — the IDE surface does not exist and
 * `apps/ide/vscode/` is a gitignored upstream checkout that nothing populates. So
 * this script exercises its real logic against committed fixtures and reports that,
 * rather than exiting 0 without doing anything. A gate that is trivially green before
 * it is needed is a gate nobody trusts when it turns red.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_PRODUCT = join(repoRoot, 'apps', 'ide', 'vscode', 'product.json');
const DEFAULT_NAMESPACES = join(repoRoot, 'apps', 'ide', 'branding', 'gallery-namespaces.json');
const FIXTURES = join(repoRoot, 'scripts', 'fixtures', 'gallery');

/**
 * Every field in `product.json` that can name an extension.
 *
 * Listed exhaustively and by name, from ADR-0009. A heuristic sweep over the whole
 * document would be shorter and would silently stop covering a field upstream
 * renames; a hard-coded list fails loudly instead, which is what a security gate
 * should do.
 */
const RECOMMENDATION_FIELDS = [
  'extensionRecommendations',
  'configBasedExtensionTips',
  'exeBasedExtensionTips',
  'languageExtensionTips',
  'keymapExtensionTips',
  'remoteExtensionTips',
  'webExtensionTips',
];

/** `publisher.name` — anything else is not a resolvable extension identifier. */
const EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Pull every extension id out of a recommendation structure.
 *
 * Upstream's shapes vary by field: a flat array of ids, an object keyed by id, and
 * objects with nested `recommendations` arrays all occur. Walking generically covers
 * all of them, and covers whatever shape upstream invents next.
 */
function collectIds(node, into) {
  if (typeof node === 'string') {
    if (EXTENSION_ID.test(node)) into.add(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectIds(item, into);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      // An object keyed by extension id: the key is the recommendation.
      if (EXTENSION_ID.test(key)) into.add(key);
      collectIds(value, into);
    }
  }
}

export function extractRecommendations(product) {
  const ids = new Set();
  for (const field of RECOMMENDATION_FIELDS) {
    if (Object.hasOwn(product, field)) collectIds(product[field], ids);
  }
  return [...ids].sort();
}

export function namespaceOf(extensionId) {
  return extensionId.slice(0, extensionId.indexOf('.'));
}

/**
 * The pure audit. Separated from all I/O so it can be exercised against fixtures,
 * which is the only reason the self-test below is meaningful.
 */
export function auditRecommendations(product, claimed) {
  const ids = extractRecommendations(product);
  const claimedSet = new Set(claimed.map((n) => n.toLowerCase()));

  const unclaimed = [];
  for (const id of ids) {
    const namespace = namespaceOf(id);
    if (!claimedSet.has(namespace.toLowerCase())) {
      unclaimed.push({ id, namespace });
    }
  }

  const gallery = product.extensionsGallery ?? {};
  const serviceUrl = typeof gallery.serviceUrl === 'string' ? gallery.serviceUrl : undefined;
  // Not a namespace problem, and worse than one: it means the fork is pointed at a
  // registry it is contractually prohibited from using at all.
  const pointsAtMicrosoft =
    serviceUrl !== undefined && /marketplace\.visualstudio\.com/i.test(serviceUrl);

  return {
    ok: unclaimed.length === 0 && !pointsAtMicrosoft,
    total: ids.length,
    unclaimed,
    ...(serviceUrl === undefined ? {} : { serviceUrl }),
    pointsAtMicrosoft,
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseArgs(argv) {
  const out = { product: DEFAULT_PRODUCT, namespaces: DEFAULT_NAMESPACES, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--product') out.product = argv[++i];
    else if (arg === '--namespaces') out.namespaces = argv[++i];
    else {
      process.stderr.write(`audit-gallery-recommendations: unknown option ${arg}\n`);
      process.exit(2);
    }
  }
  return out;
}

/**
 * Run the audit against committed fixtures.
 *
 * Two cases, and the failing one matters more: a fixture that must be rejected proves
 * the gate can actually turn red. A self-test containing only the passing case would
 * pass just as happily against a function that always returns ok.
 */
function selfTest() {
  const checks = [];

  const clean = auditRecommendations(
    readJson(join(FIXTURES, 'product.clean.json')),
    readJson(join(FIXTURES, 'namespaces.json')).claimed,
  );
  checks.push({
    name: 'a product.json whose recommendations are all claimed passes',
    ok: clean.ok === true && clean.total > 0 && clean.unclaimed.length === 0,
    detail: `${clean.total} recommendation(s), ${clean.unclaimed.length} unclaimed`,
  });

  const squatted = auditRecommendations(
    readJson(join(FIXTURES, 'product.squatted.json')),
    readJson(join(FIXTURES, 'namespaces.json')).claimed,
  );
  const caught = squatted.unclaimed.map((u) => u.id).sort();
  checks.push({
    name: 'an unclaimed publisher namespace is caught',
    ok: squatted.ok === false && caught.includes('ms-python.python'),
    detail: `caught ${caught.length}: ${caught.join(', ')}`,
  });
  checks.push({
    name: 'ids are found in every recommendation field, not only the flat list',
    ok:
      caught.includes('ms-vscode-remote.remote-ssh') && caught.includes('ms-dotnettools.csdevkit'),
    detail: 'nested and object-keyed shapes are walked',
  });
  checks.push({
    name: 'a gallery pointed at the Microsoft Marketplace fails outright',
    ok:
      auditRecommendations(readJson(join(FIXTURES, 'product.marketplace.json')), [])
        .pointsAtMicrosoft === true,
    detail: 'prohibited by the Marketplace Terms of Use for forks',
  });

  return checks;
}

const args = parseArgs(process.argv.slice(2));

if (!existsSync(args.product)) {
  const checks = selfTest();
  const failed = checks.filter((c) => !c.ok);

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: failed.length === 0,
          state: 'no-gallery-configured',
          milestone: 'M4',
          productPath: relative(repoRoot, args.product),
          selfTest: checks,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `No gallery configured yet (M4).\n\n` +
        `  ${relative(repoRoot, args.product)} does not exist. The IDE surface is a\n` +
        `  milestone-M4 deliverable and apps/ide/vscode/ is a gitignored upstream\n` +
        `  checkout that nothing populates yet — see docs/roadmap.md.\n\n` +
        `Verified the audit logic against fixtures instead:\n\n`,
    );
    for (const c of checks) {
      process.stdout.write(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}\n         ${c.detail}\n`);
    }
    process.stdout.write(
      failed.length === 0
        ? '\nThe gate works. It becomes load-bearing when product.json lands.\n'
        : `\n${failed.length} self-test(s) failed — the gate itself is broken.\n`,
    );
  }

  process.exitCode = failed.length === 0 ? 0 : 1;
} else {
  if (!existsSync(args.namespaces)) {
    // Cannot audit without the authority list, and defaulting to "everything is
    // claimed" would turn a security gate into decoration.
    process.stderr.write(
      `audit-gallery-recommendations: ${relative(repoRoot, args.product)} exists but\n` +
        `${relative(repoRoot, args.namespaces)} does not.\n\n` +
        'The claimed-namespace manifest is what recommendations are resolved against.\n' +
        'Without it there is nothing to check, and assuming every namespace is claimed\n' +
        'is precisely the vulnerability this script exists to prevent.\n',
    );
    process.exit(1);
  }

  const product = readJson(args.product);
  const manifest = readJson(args.namespaces);
  const claimed = Array.isArray(manifest.claimed) ? manifest.claimed : [];
  const result = auditRecommendations(product, claimed);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Audited ${result.total} extension recommendation(s) in ${relative(repoRoot, args.product)}\n` +
        `against ${claimed.length} claimed namespace(s).\n\n`,
    );
    if (result.pointsAtMicrosoft) {
      process.stdout.write(
        'FAIL  extensionsGallery.serviceUrl points at the Microsoft Marketplace.\n' +
          '      Prohibited for forks by the Marketplace Terms of Use §2(b) and §3.\n' +
          '      See docs/architecture/adr/0009-extension-gallery.md.\n\n',
      );
    }
    if (result.unclaimed.length > 0) {
      process.stdout.write(
        `FAIL  ${result.unclaimed.length} recommendation(s) name a namespace we have not claimed:\n\n`,
      );
      for (const u of result.unclaimed) {
        process.stdout.write(`        ${u.id}  (namespace '${u.namespace}')\n`);
      }
      process.stdout.write(
        '\n      Either claim the namespace on our gallery, or prune the recommendation.\n' +
          '      Shipping it unpruned recommends a publisher anyone can register.\n',
      );
    }
    if (result.ok) {
      process.stdout.write('Every recommended extension resolves to a claimed namespace.\n');
    }
  }

  process.exitCode = result.ok ? 0 : 1;
}
