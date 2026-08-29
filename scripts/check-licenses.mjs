#!/usr/bin/env node
/**
 * License policy check.
 *
 *   node scripts/check-licenses.mjs [--json] [--all]
 *
 * Fails the build on a denylisted license. Reports `NOASSERTION` and anything else
 * it does not recognise **separately, as neither a pass nor a failure**, because
 * those are the cases where a human has to open the LICENSE file. Treating an
 * unrecognised string as a pass hides a problem; treating it as a failure blocks
 * the build on packages that are perfectly fine, and either way the check stops
 * being read.
 *
 * Reads pnpm's virtual store on disk rather than shelling out to `pnpm licenses`.
 * Two reasons: `pnpm` is a `.cmd` on Windows and Node refuses to `execFile` a batch
 * file since the 18.20/20.12 security fix, and a check that depends on a subprocess
 * is a check that can fail for reasons unrelated to licensing.
 *
 * Policy: ADR-0012. Threat model: SECURITY.md.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Permissive licenses compatible with shipping an Apache-2.0 product.
 *
 * BlueOak-1.0.0 and Python-2.0 are here because they appear in real dependency
 * trees and are permissive; both were read rather than assumed.
 */
const ALLOWED = new Set([
  'APACHE-2.0',
  'MIT',
  'MIT-0',
  'BSD-2-CLAUSE',
  'BSD-3-CLAUSE',
  'ISC',
  'UNLICENSE',
  'CC0-1.0',
  'BLUEOAK-1.0.0',
  'PYTHON-2.0',
  '0BSD',
]);

/**
 * Categorically unusable in an Apache-2.0 product, matched as substrings because
 * the strings in the wild vary ('GPL-3.0-only', 'GPL-3.0-or-later', 'AGPL-3.0').
 *
 * LGPL is on this list deliberately. Its weak copyleft is often described as safe
 * for dynamic linking, and that argument does not transfer cleanly to a bundled
 * JavaScript application where the boundary between linking and inclusion is not
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

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const showAll = args.includes('--all');

/** Split an SPDX expression into leaves, keeping the operator that joined them. */
function parseExpression(raw) {
  const text = raw
    .trim()
    .replace(/^\(|\)$/g, '')
    .trim();
  if (/\bAND\b/i.test(text)) {
    return { operator: 'AND', leaves: text.split(/\s+AND\s+/i).map((s) => s.trim()) };
  }
  if (/\bOR\b/i.test(text)) {
    return { operator: 'OR', leaves: text.split(/\s+OR\s+/i).map((s) => s.trim()) };
  }
  return { operator: 'NONE', leaves: [text] };
}

function classifyLeaf(leaf) {
  const upper = leaf
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/^\(|\)$/g, '')
    .trim();
  const withoutPlus = upper.replace(/\+$/, '');

  for (const denied of DENIED) {
    if (upper.includes(denied)) return 'denied';
  }
  if (ALLOWED.has(withoutPlus)) return 'allowed';
  return 'review';
}

/**
 * Classify a whole expression.
 *
 * `OR` is satisfied by one acceptable operand — a dual-licensed package can be
 * taken under its permissive half. `AND` requires every operand, so one denied
 * operand denies the whole thing. Getting this backwards would either reject
 * `(MIT OR GPL-3.0)`, which is fine to use, or accept `MIT AND GPL-3.0`, which is
 * not.
 */
function classify(raw) {
  if (raw === undefined || raw === null || raw === '') return 'review';
  if (typeof raw !== 'string') return 'review';
  if (/^NOASSERTION$/i.test(raw.trim())) return 'review';
  if (/^SEE LICENSE IN/i.test(raw.trim())) return 'review';

  const { operator, leaves } = parseExpression(raw);
  const verdicts = leaves.map(classifyLeaf);

  if (operator === 'OR') {
    if (verdicts.includes('allowed')) return 'allowed';
    if (verdicts.every((v) => v === 'denied')) return 'denied';
    return 'review';
  }
  // AND, or a single leaf.
  if (verdicts.includes('denied')) return 'denied';
  if (verdicts.every((v) => v === 'allowed')) return 'allowed';
  return 'review';
}

/** `license`, or the legacy `licenses` array some older packages still use. */
function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (
    pkg.license !== null &&
    typeof pkg.license === 'object' &&
    typeof pkg.license.type === 'string'
  ) {
    return pkg.license.type;
  }
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean);
    if (types.length > 0) return types.join(' OR ');
  }
  return undefined;
}

function hasLicenseFile(dir) {
  try {
    return readdirSync(dir).some((f) => /^(LICEN[CS]E|COPYING)/i.test(f));
  } catch {
    return false;
  }
}

/** Directories inside one `.pnpm/<entry>/node_modules`, scoped names unwrapped. */
function packageDirsIn(nested) {
  const out = [];
  for (const name of readdirSync(nested)) {
    const full = join(nested, name);
    if (!name.startsWith('@')) {
      out.push(full);
      continue;
    }
    try {
      for (const sub of readdirSync(full)) out.push(join(full, sub));
    } catch {
      // Not a readable directory. Skip.
    }
  }
  return out;
}

function readPackage(dir) {
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return undefined;
  try {
    if (!statSync(manifest).isFile()) return undefined;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof pkg.name !== 'string') return undefined;
    return { name: pkg.name, version: pkg.version ?? 'unknown', license: licenseOf(pkg), dir };
  } catch {
    // A malformed package.json in the store is not a license verdict. Skipped rather
    // than treated as a failure, and it will surface elsewhere.
    return undefined;
  }
}

/**
 * Enumerate every package in pnpm's virtual store.
 *
 * `node_modules/.pnpm/<name>@<version>/node_modules/<name>` is the canonical
 * location of every installed version, including transitive ones, which is exactly
 * the set that matters: a denylisted license three levels down still ships.
 */
function collectPackages() {
  const store = join(repoRoot, 'node_modules', '.pnpm');
  if (!existsSync(store)) return [];

  const found = new Map();
  for (const entry of readdirSync(store)) {
    if (entry === 'node_modules' || entry === 'lock.yaml') continue;
    const nested = join(store, entry, 'node_modules');
    if (!existsSync(nested)) continue;

    for (const dir of packageDirsIn(nested)) {
      const pkg = readPackage(dir);
      if (pkg === undefined) continue;
      const key = `${pkg.name}@${pkg.version}`;
      if (!found.has(key)) found.set(key, pkg);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const packages = collectPackages();

const allowed = [];
const denied = [];
const review = [];

for (const pkg of packages) {
  const verdict = classify(pkg.license);
  const record = {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license ?? 'NOASSERTION',
    ...(verdict === 'review' ? { hasLicenseFile: hasLicenseFile(pkg.dir) } : {}),
  };
  if (verdict === 'allowed') allowed.push(record);
  else if (verdict === 'denied') denied.push(record);
  else review.push(record);
}

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: denied.length === 0,
        totals: {
          packages: packages.length,
          allowed: allowed.length,
          denied: denied.length,
          needsHumanReview: review.length,
        },
        denied,
        needsHumanReview: review,
        ...(showAll ? { allowed } : {}),
      },
      null,
      2,
    )}\n`,
  );
} else {
  if (packages.length === 0) {
    process.stderr.write(
      'check-licenses: node_modules/.pnpm not found. Run `pnpm install` first.\n',
    );
    process.exit(2);
  }

  process.stdout.write(`Scanned ${packages.length} installed package(s).\n\n`);
  process.stdout.write(`  allowed              ${allowed.length}\n`);
  process.stdout.write(`  denied               ${denied.length}\n`);
  process.stdout.write(`  needs human review   ${review.length}\n\n`);

  if (denied.length > 0) {
    process.stdout.write('DENIED — incompatible with shipping an Apache-2.0 product:\n');
    for (const p of denied) {
      process.stdout.write(`  ${p.name}@${p.version}  ${p.license}\n`);
    }
    process.stdout.write('\n');
  }

  if (review.length > 0) {
    // Deliberately not a failure and deliberately not silent. The registry's
    // license field is not a verdict: it reports NOASSERTION for packages ranging
    // from perfectly fine to categorically unusable, so the only correct response
    // is for a person to read the LICENSE file.
    process.stdout.write(
      'NEEDS HUMAN REVIEW — the declared license is missing or unrecognised.\n' +
        'This is neither a pass nor a failure. Open the LICENSE file and decide.\n\n',
    );
    for (const p of review) {
      const marker = p.hasLicenseFile ? 'has LICENSE file' : 'NO LICENSE FILE';
      process.stdout.write(`  ${p.name}@${p.version}  ${p.license}  (${marker})\n`);
    }
    process.stdout.write('\n');
  }

  if (showAll) {
    for (const p of allowed) {
      process.stdout.write(`  ok  ${p.name}@${p.version}  ${p.license}\n`);
    }
    process.stdout.write('\n');
  }

  process.stdout.write(
    denied.length === 0
      ? 'No denylisted licenses. Policy: docs/architecture/adr/0012-licensing-and-governance.md\n'
      : `${denied.length} denylisted license(s). This fails the build.\n`,
  );
}

process.exitCode = denied.length === 0 ? 0 : 1;
