#!/usr/bin/env node
/**
 * Mine (prefix-context, next-edit) prototype cases from Adze's own git history.
 *
 * v0 prototype for `nep-bench` (docs/roadmap.md M6). It walks recent commits,
 * takes the FIRST hunk of small file edits as the "next edit" from the
 * pre-image prefix, and writes them as `apply-bench` compatible cases: the
 * full pre-image as `original`, the hunk as one search/replace edit, and the
 * pre-image with only that hunk applied as `expect.content`. For single-hunk
 * changes that equals the commit post-image; for multi-hunk changes it is the
 * honest intermediate after the next edit, with remaining hunks documented as
 * future edits.
 *
 * Honesty properties, stated so a reader does not have to infer them:
 * - Input distribution is real Adze commit sequences, single repo, TypeScript
 *   heavy, horizon single-next-edit, full-file prefix (not a truncated window).
 * - The runner supplies the TRUE edit to the applier, so the number measures
 *   prefix-to-edit reconstruction ability of the APPLIER, not model behavior.
 * - Cases are filtered to exact-unique searches so the v0 set reconstructs
 *   deterministically. A case that fails reconstruction is removed rather than
 *   kept as a failure, which is why the suite passing is a wiring signal and
 *   not a result to publish.
 *
 * Usage:
 *   node bench/suites/nep-bench/scripts/mine.mjs [--max 28] [--out bench/suites/nep-bench/cases/mined-v0.json]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    // Added-file probes fail by design (`git show parent:file` for a file the
    // parent commit does not have). Pipe stderr so those expected failures do
    // not print `fatal:` noise into the miner's own output.
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

/**
 * First-hunk intermediates that do not parse alone.
 *
 * Both are multi-hunk test edits whose opening bracket is closed by a later
 * hunk, so the file after only the first hunk is genuinely broken and the
 * applier rightly refuses it as `parse-broken`. They are excluded from the v0
 * set (which must reconstruct deterministically) rather than kept as
 * failures: a wiring suite that is red by construction stops running. Future
 * miner work is multi-hunk-aware cases; see the suite README.
 */
const EXCLUDED_IDS = new Set([
  'nep-ty-0763055-spec-consistency-test-ts',
  'nep-ty-53aa97e-reachability-test-ts',
]);

function languageForPath(path) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'py':
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'java':
      return 'java';
    case 'c':
    case 'h':
      return 'c';
    case 'sh':
      return 'shell';
    case 'json':
      return 'json';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'yml':
    case 'yaml':
      return 'yaml';
    default:
      return 'unknown';
  }
}

function isWantedPath(path) {
  if (path.includes('bench/.runs/')) return false;
  if (path.includes('bench/reports/')) return false;
  if (path.includes('node_modules/')) return false;
  if (path.includes('/dist/')) return false;
  if (path.endsWith('.lock')) return false;
  if (path.endsWith('.png')) return false;
  return true;
}

function parseArgs(argv) {
  // Canonical v0 size is 30 cases, inside the 20-40 v0 window. The committed
  // `cases/mined-v0.json` is canonical; re-running the miner reproduces an
  // equivalent green set (same filters, same walk order) up to boundary
  // effects at the `--max` cutoff, so review the diff before committing it.
  let max = 30;
  let out = join(repoRoot, 'bench', 'suites', 'nep-bench', 'cases', 'mined-v0.json');
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--max') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 40) {
        throw new Error('--max must be an integer in [1, 40] (v0 cap is 20-40 cases)');
      }
      max = value;
    } else if (arg === '--out') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--out requires a value');
      out = isAbsolute(value) ? value : join(repoRoot, value);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return { max, out };
}

function splitKeep(content) {
  // Preserve the trailing-newline bit exactly: split keeps a final "" when the
  // file ends with "\n", which the case format round-trips losslessly.
  return content.split('\n');
}

function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = 0;
  for (;;) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) return count;
    count++;
    index = found + needle.length;
    if (count > 2) return count;
  }
}

function parseHunks(diffText) {
  const hunks = [];
  const lines = diffText.split('\n');
  let current = null;
  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      if (current !== null) hunks.push(current);
      current = { oldLines: [], newLines: [], removed: 0, added: 0 };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff ')) continue;
    if (line.startsWith('\\ ')) continue;
    const marker = line[0];
    const text = line.slice(1);
    if (marker === ' ') {
      current.oldLines.push(text);
      current.newLines.push(text);
    } else if (marker === '-') {
      current.oldLines.push(text);
      current.removed++;
    } else if (marker === '+') {
      current.newLines.push(text);
      current.added++;
    }
  }
  if (current !== null) hunks.push(current);
  return hunks;
}

/**
 * Mine one commit's files into candidate cases, without quota logic.
 *
 * Returns entries in walk order; the caller applies the v0 quotas. A file the
 * parent commit does not have (added files) is skipped quietly — that probe
 * fails by design.
 */
function mineCommit(commit) {
  let parent;
  try {
    parent = git(['rev-parse', `${commit}^`]).trim();
  } catch {
    return [];
  }
  let subject = '';
  try {
    subject = git(['log', '-1', '--format=%s', commit]).trim().slice(0, 90);
  } catch {
    subject = '';
  }
  let files = [];
  try {
    files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter(isWantedPath)
      .sort();
  } catch {
    return [];
  }
  const entries = [];
  for (const file of files) {
    const entry = mineOneFile(commit, parent, subject, file);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

function fitsFileCap(isCode, oldContent, newContent) {
  // Code files run larger than prose, so the size cap is per-kind: the hunk
  // cap below is what keeps the edit small, not the file cap.
  if (isCode) {
    return oldContent.length <= 30_000 && newContent.length <= 30_000;
  }
  return oldContent.length <= 15_000 && newContent.length <= 15_000;
}

function fitsLineCap(isCode, oldContent) {
  const lines = oldContent.split('\n').length;
  return isCode ? lines <= 600 : lines <= 300;
}

/**
 * The first hunk of a file diff as a search/replace pair, or null.
 *
 * v0 horizon is single-next-edit: the FIRST hunk is the "next edit" from the
 * pre-image prefix, and remaining hunks are future edits the prefix has not
 * seen. Code gets wider context so the search block stays unique in larger
 * files; prose stays at three lines to keep edits small.
 */
function firstHunkEdit(parent, commit, file, isCode) {
  let diffText;
  try {
    diffText = isCode
      ? git(['diff', '-U5', parent, commit, '--', file])
      : git(['diff', '-U3', parent, commit, '--', file]);
  } catch {
    return null;
  }
  const hunks = parseHunks(diffText);
  if (hunks.length < 1) return null;
  const hunk = hunks[0];
  if (hunk === undefined) return null;
  const changed = hunk.removed + hunk.added;
  const hunkCap = isCode ? 26 : 12;
  const spanCap = isCode ? 36 : 16;
  if (changed < 1 || changed > hunkCap) return null;
  if (hunk.oldLines.length < 1 || hunk.oldLines.length > spanCap) return null;
  if (hunk.newLines.length < 1 || hunk.newLines.length > spanCap) return null;
  return { hunk, hunkCount: hunks.length };
}

/** One file's (prefix, next-edit) pair, or null when it fails any filter. */
function mineOneFile(commit, parent, subject, file) {
  const language = languageForPath(file);
  if (language === 'unknown') return null;
  const isCode = language === 'typescript' || language === 'javascript';
  let oldContent;
  let newContent;
  try {
    oldContent = git(['show', `${parent}:${file}`]);
    newContent = git(['show', `${commit}:${file}`]);
  } catch {
    return null;
  }
  if (oldContent === newContent) return null;
  if (!fitsFileCap(isCode, oldContent, newContent)) return null;
  if (!fitsLineCap(isCode, oldContent)) return null;
  const first = firstHunkEdit(parent, commit, file, isCode);
  if (first === null) return null;
  const { hunk, hunkCount } = first;
  const search = hunk.oldLines.join('\n');
  const replace = hunk.newLines.join('\n');
  if (search === replace || search.trim().length === 0) return null;
  if (countOccurrences(oldContent, search) !== 1) return null;
  // The expected post-image is the pre-image with ONLY the first hunk applied.
  // For single-hunk changes this equals the commit post-image; for multi-hunk
  // changes it is the honest intermediate after the next edit.
  const expectedContent = oldContent.replace(search, replace);
  if (expectedContent === oldContent) return null;

  const short = commit.slice(0, 7);
  const base = file
    .split('/')
    .pop()
    ?.replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .toLowerCase();
  let id = `nep-${language.slice(0, 2)}-${short}-${base}`;
  if (id.length > 60) id = id.slice(0, 60);
  if (EXCLUDED_IDS.has(id)) return null;

  const isTest = file.includes('test') || file.includes('spec');
  const hunkNote =
    hunkCount === 1
      ? 'single hunk'
      : `first hunk of ${hunkCount} (remaining hunks are future edits)`;
  return {
    id,
    description: `Mined from ${short}: ${subject} — ${file} (${hunkNote}, ${hunk.removed} removed / ${hunk.added} added).`,
    path: file,
    original: splitKeep(oldContent),
    edits: [{ search, replace }],
    expect: { kind: 'output', content: splitKeep(expectedContent) },
    tags: ['nep', 'mined', language, ...(isTest ? ['test'] : [])],
    source: `commit ${commit} file ${file} language ${language}`,
  };
}

function main() {
  const { max, out } = parseArgs(process.argv);
  const commits = git(['log', '--format=%H', '--no-merges']).split('\n').filter(Boolean);
  const seenIds = new Set();
  // v0 quota keeps the set TypeScript-heavy (the feature is a code-edit
  // feature) while retaining a small mixed tail for the per-language
  // breakdown. Both caps fit the 20-40 v0 window.
  const tsQuota = Math.min(20, max - 4);
  const tsCases = [];
  const otherCases = [];

  function pushCase(entry) {
    if (seenIds.has(entry.id)) {
      let n = 2;
      while (seenIds.has(`${entry.id}-${n}`)) n++;
      entry.id = `${entry.id}-${n}`;
    }
    seenIds.add(entry.id);
    if (entry.tags.includes('typescript') || entry.tags.includes('javascript')) {
      if (tsCases.length < tsQuota) tsCases.push(entry);
    } else if (tsCases.length + otherCases.length < max) {
      otherCases.push(entry);
    }
  }

  for (const commit of commits) {
    if (tsCases.length + otherCases.length >= max) break;
    const mined = mineCommit(commit);
    for (const entry of mined) {
      if (tsCases.length + otherCases.length >= max) break;
      pushCase(entry);
    }
  }

  const cases = [...tsCases, ...otherCases];
  if (cases.length < 20) {
    process.stderr.write(
      `mine: only ${cases.length} cases mined, below the v0 floor of 20. Loosen filters or walk further back.\n`,
    );
    process.exit(2);
  }

  // Deterministic order: by id, so regeneration diffs are reviewable.
  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ cases }, null, 2)}\n`, 'utf8');

  const byLanguage = new Map();
  for (const c of cases) {
    const language = languageForPath(c.path);
    byLanguage.set(language, (byLanguage.get(language) ?? 0) + 1);
  }
  process.stdout.write(
    `mine: wrote ${cases.length} cases to ${out} (${[...byLanguage.entries()].map(([k, v]) => `${k}:${v}`).join(', ')})\n`,
  );
}

main();
