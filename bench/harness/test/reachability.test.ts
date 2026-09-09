/**
 * Reachability: every declared capability has a producer on a user-run path.
 *
 * Systemic response to plan P1.5. Four instances of built-and-unreachable were
 * found by hand — `@adze/sandbox` with no consumer, `publication.ts` and
 * `statistics.ts` with no caller in the report pipeline, `leakage.ts` with no
 * input to check, and `validator: 'tree-sitter'` with no producer — and the
 * fifth should be found by CI rather than by an audit.
 *
 * Cheapest useful form, as the plan prescribes: assert that each package's
 * public entry transitively reaches its documented capabilities, and that a
 * declared union variant has a producer. The precedent is
 * `packages/retrieval/test/invariants.test.ts`, which pins the same shape for
 * one package; this file pins it repo-wide. Static file reads rather than
 * runtime imports, so the test runs without building and cannot be green while
 * the wiring is broken in source.
 *
 * This also gives D12 somewhere to live. `docs/architecture/README.md` promised
 * a dependency-cruiser check in CI that never existed; the package-dependency
 * rules are enforced here instead, with no new dependency (a heavy graph tool
 * would need a catalog entry, a license review, and an ADR of its own).
 *
 * When a section fails after an intentional change, update the section, not just
 * the code. Each assertion names the decision it encodes — P0.2 for the CLI
 * sandbox wiring, P1.1 for the tree-sitter producer, P1.3 for the deliberately
 * unwired leakage and baseline gates — so a wiring change lands as an explicit
 * test edit rather than silent drift. Known gaps are asserted as gaps: the
 * VS Code surface is still gate-only, and the Tier-1 gates for baselines and
 * max-over-N await a report shape that carries the data.
 *
 * Refs plan P1.5. Governed by ADR-0001 (surfaces through protocol), ADR-0005
 * (validation levels), ADR-0007 (sandbox), ADR-0011 (publication and leakage).
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

async function sourceFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Strip comment lines before scanning.
 *
 * Doc comments contain usage examples importing the package under test. Counting
 * those would report a package importing itself — a false positive that makes
 * the whole file untrusted. Same discipline as the per-package invariant tests.
 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

interface Import {
  readonly file: string;
  readonly specifier: string;
}

async function importSpecifiers(root: string): Promise<readonly Import[]> {
  const found: Import[] = [];
  for (const file of await sourceFiles(root)) {
    const text = stripComments(await readFile(file, 'utf8'));
    const relative = file.slice(root.length + 1).replaceAll('\\', '/');
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier !== undefined) found.push({ file: relative, specifier });
    }
  }
  return found;
}

function srcDir(...segments: readonly string[]): string {
  return join(REPO_ROOT, ...segments, 'src');
}

async function readRepo(...segments: readonly string[]): Promise<string> {
  return readFile(join(REPO_ROOT, ...segments), 'utf8');
}

interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly license?: string;
}

async function manifest(...segments: readonly string[]): Promise<Manifest> {
  const text = await readRepo(...segments, 'package.json');
  return JSON.parse(text) as unknown as Manifest;
}

function adzeImports(imports: readonly Import[]): readonly Import[] {
  return imports.filter((entry) => entry.specifier.startsWith('@adze/'));
}

/** In-scope packages for P1.5, as repo-relative directory segments. */
const IN_SCOPE: readonly (readonly string[])[] = [
  ['packages', 'protocol'],
  ['packages', 'core'],
  ['packages', 'apply'],
  ['packages', 'providers'],
  ['packages', 'retrieval'],
  ['packages', 'sandbox'],
  ['packages', 'mcp'],
  ['packages', 'plugin-sdk'],
  ['packages', 'cli'],
  ['packages', 'sdk'],
  ['apps', 'vscode'],
  ['bench', 'harness'],
];

describe('D12 — the dependency rules are tested, not only reviewed', () => {
  it('protocol depends on nothing but zod', async () => {
    const pkg = await manifest('packages', 'protocol');
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['zod']);
    expect(adzeImports(await importSpecifiers(srcDir('packages', 'protocol')))).toEqual([]);
  });

  it('core never imports a surface', async () => {
    const surfaces = ['@adze/cli', '@adze/vscode', '@adze/ide', '@adze/hub', '@adze/sdk'];
    const offenders = adzeImports(await importSpecifiers(srcDir('packages', 'core'))).filter(
      (entry) => surfaces.some((surface) => entry.specifier.startsWith(surface)),
    );
    expect(offenders).toEqual([]);
  });

  it('core imports only protocol and apply besides itself', async () => {
    // The documented exception: `edit` routes through `@adze/apply` (ADR-0005).
    // Anything else — retrieval, sandbox, providers — would be a second engine
    // with its own seams, reached around the interfaces core declares.
    const allowed = new Set(['@adze/protocol', '@adze/apply']);
    const offenders = adzeImports(await importSpecifiers(srcDir('packages', 'core'))).filter(
      (entry) => !allowed.has(entry.specifier) && entry.specifier !== '@adze/core',
    );
    expect(offenders).toEqual([]);
  });

  it('service packages never import each other', async () => {
    // Each stays individually swappable and testable. `@adze/core` is the engine
    // interface a service implements and `@adze/protocol` is the contract; the
    // siblings — apply, retrieval, sandbox, mcp, plugin-sdk, providers — are off
    // limits. `@adze/apply` duplicates the grammar convention rather than
    // importing `@adze/retrieval`'s loader for exactly this reason (P1.1).
    const allowed = new Set(['@adze/core', '@adze/protocol']);
    for (const segments of [
      ['packages', 'apply'],
      ['packages', 'retrieval'],
      ['packages', 'sandbox'],
      ['packages', 'providers'],
      ['packages', 'mcp'],
      ['packages', 'plugin-sdk'],
    ] as const) {
      const name = segments.join('/');
      const offenders = adzeImports(await importSpecifiers(srcDir(...segments))).filter(
        (entry) => !allowed.has(entry.specifier) && entry.specifier !== `@adze/${segments[1]}`,
      );
      expect(offenders, name).toEqual([]);
    }
  });

  it('no service, engine, contract, or bench package imports the sdk', async () => {
    // Only surfaces import `@adze/sdk`: it is the public embedding API and its
    // stability guarantees differ. A service reaching for it would take a
    // dependency on an API nobody has tested it against.
    for (const segments of [
      ['packages', 'protocol'],
      ['packages', 'core'],
      ['packages', 'apply'],
      ['packages', 'providers'],
      ['packages', 'retrieval'],
      ['packages', 'sandbox'],
      ['packages', 'mcp'],
      ['packages', 'plugin-sdk'],
      ['bench', 'harness'],
    ] as const) {
      const offenders = adzeImports(await importSpecifiers(srcDir(...segments))).filter((entry) =>
        entry.specifier.startsWith('@adze/sdk'),
      );
      expect(offenders, segments.join('/')).toEqual([]);
    }
  });

  it('nothing in product code imports bench', async () => {
    // Benchmark code must not influence what ships, or the benchmark stops
    // measuring the product. The dependency runs one way: bench imports apply.
    for (const segments of [
      ['packages', 'protocol'],
      ['packages', 'core'],
      ['packages', 'apply'],
      ['packages', 'providers'],
      ['packages', 'retrieval'],
      ['packages', 'sandbox'],
      ['packages', 'mcp'],
      ['packages', 'plugin-sdk'],
      ['packages', 'cli'],
      ['packages', 'sdk'],
      ['apps', 'vscode'],
    ] as const) {
      const offenders = (await importSpecifiers(srcDir(...segments))).filter(
        (entry) => entry.specifier.includes('bench/') || entry.specifier.startsWith('bench'),
      );
      expect(offenders, segments.join('/')).toEqual([]);
    }
  });

  it('bench reaches product code only through apply and retrieval', async () => {
    // Tier 1.5 added `index-bench`, which measures `@adze/retrieval` locally
    // (ripgrep latency, cold/incremental timing, precision@k). The dependency
    // still runs one way — bench imports product code, never the reverse — and
    // service packages still must not import each other; this is the only
    // package allowed two product imports, because it is the only one that
    // measures two layers. Refs ADR-0011, plan Tier 1.5.
    const allowed = new Set(['@adze/apply', '@adze/retrieval']);
    const offenders = adzeImports(await importSpecifiers(srcDir('bench', 'harness'))).filter(
      (entry) => !allowed.has(entry.specifier),
    );
    expect(offenders).toEqual([]);
  });

  it('every dependency version resolves through the catalog or workspace', async () => {
    // One version per dependency across the workspace is what stops fifteen
    // packages drifting onto four versions of the same thing.
    for (const segments of IN_SCOPE) {
      const pkg = await manifest(...segments);
      for (const [name, version] of Object.entries({
        ...pkg.dependencies,
        ...pkg.devDependencies,
      })) {
        expect(version, `${segments.join('/')}: ${name}`).toMatch(/^(?:catalog:|workspace:)/);
      }
    }
  });

  it('every in-scope package is Apache-2.0', async () => {
    for (const segments of IN_SCOPE) {
      const pkg = await manifest(...segments);
      expect(pkg.license, segments.join('/')).toBe('Apache-2.0');
    }
  });
});

describe('sandbox containment is wired into the CLI, not only built', () => {
  it('the CLI declares the sandbox dependency', async () => {
    const pkg = await manifest('packages', 'cli');
    expect(pkg.dependencies?.['@adze/sandbox']).toMatch(/^(?:catalog:|workspace:)/);
  });

  it('the CLI selects a broker from the sandbox package', async () => {
    const text = stripComments(await readRepo('packages', 'cli', 'src', 'agent', 'sandbox.ts'));
    expect(text).toContain("from '@adze/sandbox'");
    expect(text).toContain('createSandbox');
  });

  it('the selected broker is required, and reaches the permission gate', async () => {
    // The defect, stated as an assertion. The seam used to be an optional
    // `broker?` override that nothing supplied, so every run silently fell back
    // to core's gate-only broker. An optional containment seam is how the
    // package came to be unreachable, so this one cannot be omitted.
    const text = stripComments(await readRepo('packages', 'cli', 'src', 'agent', 'setup.ts'));
    expect(text).toContain('readonly containment: CliSandbox');
    expect(text).toContain('broker: options.containment.broker');
  });

  it('doctor reports the plan the broker produced, not the platform', async () => {
    // The old display derived containment from the platform and said `os-level`
    // on macOS and Linux whether or not anything wired a mechanism — for as long
    // as nothing did. The plan cannot make that mistake: it is built by the
    // broker that will run the command.
    const text = stripComments(await readRepo('packages', 'cli', 'src', 'commands', 'doctor.ts'));
    expect(text).toContain('createCliSandbox');
  });

  it('the CLI never falls back to a gate-only core broker', async () => {
    // Both files that touch the broker are pinned: neither may construct the
    // subprocess broker core ships for seams with no implementation. Selecting
    // either of core's brokers is how the product had no containment anywhere.
    const setup = stripComments(await readRepo('packages', 'cli', 'src', 'agent', 'setup.ts'));
    expect(setup).not.toContain('new NodeSubprocessBroker');
    const sandbox = stripComments(await readRepo('packages', 'cli', 'src', 'agent', 'sandbox.ts'));
    expect(sandbox).not.toContain('new NodeSubprocessBroker');
  });

  it('the VS Code surface is still gate-only, and says so', async () => {
    // Known gap, asserted as a gap rather than left to drift. The extension host
    // builds core's subprocess broker and derives enforcement from the platform,
    // which is the pre-P0.2 arrangement the CLI has left. Wiring it means adding
    // the sandbox dependency, selecting a broker per host, and updating this
    // test — which is the point: the change lands explicitly, not silently.
    const pkg = await manifest('apps', 'vscode');
    expect(pkg.dependencies?.['@adze/sandbox']).toBeUndefined();
    const host = stripComments(await readRepo('apps', 'vscode', 'src', 'engine', 'host.ts'));
    expect(host).toContain('new NodeSubprocessBroker');
    expect(host).not.toContain('@adze/sandbox');
  });
});

describe("validator 'tree-sitter' is producible and reachable", () => {
  it('has exactly one producer outside the type declaration', async () => {
    // Widening `structural` to `tree-sitter` must require editing one obvious
    // function. `types.ts` declares the union; `tree-sitter.ts` earns it with a
    // completed parse. Anything else naming the value is a claim without a parse.
    const files = await sourceFiles(srcDir('packages', 'apply'));
    const holders: string[] = [];
    for (const file of files) {
      const text = stripComments(await readFile(file, 'utf8'));
      if (/validator:\s*'tree-sitter'/.test(text)) holders.push(file.split(/[/\\]/).pop() ?? file);
    }
    expect(holders.sort()).toEqual(['tree-sitter.ts', 'types.ts']);
    const producer = stripComments(await readRepo('packages', 'apply', 'src', 'tree-sitter.ts'));
    expect(producer.match(/validator:\s*'tree-sitter'/g)).toHaveLength(1);
  });

  it('the async validation entry prefers a real parse', async () => {
    const validate = stripComments(await readRepo('packages', 'apply', 'src', 'validate.ts'));
    expect(validate).toContain('validateTreeSitter');
    const applier = stripComments(await readRepo('packages', 'apply', 'src', 'applier.ts'));
    expect(applier).toContain('validateAsync');
  });

  it('the public entry exports the async path', async () => {
    const index = stripComments(await readRepo('packages', 'apply', 'src', 'index.ts'));
    expect(index).toContain('validateAsync');
  });

  it('the protocol declares the variant the producer earns', async () => {
    const primitives = await readRepo('packages', 'protocol', 'src', 'primitives.ts');
    expect(primitives).toContain("'tree-sitter'");
    expect(primitives).toContain('ValidatorLevelSchema');
  });

  it('the bench suite can assert the level that ran', async () => {
    const schema = await readRepo('bench', 'harness', 'src', 'case-schema.ts');
    expect(schema).toContain("'tree-sitter'");
    const runner = await readRepo('bench', 'harness', 'src', 'runner.ts');
    expect(runner).toContain('wrong-validator');
    const reportSchema = await readRepo('bench', 'harness', 'src', 'report-schema.ts');
    expect(reportSchema).toContain("'tree-sitter'");
  });

  it('both CLI edit paths reach the applier that can parse', async () => {
    // `adze apply` runs `applyEdit`, which awaits the async validation entry.
    // `adze validate` used to call the synchronous structural-only entry, which
    // made the level unreachable for single files despite P1.1 — now it awaits
    // the same async path.
    const apply = stripComments(await readRepo('packages', 'cli', 'src', 'commands', 'apply.ts'));
    expect(apply).toContain('applyEdit');
    const validate = stripComments(
      await readRepo('packages', 'cli', 'src', 'commands', 'validate.ts'),
    );
    expect(validate).toContain('validateAsync');
    expect(validate).not.toContain('detectLanguage, validate }');
  });
});

describe('leakage assertions are tested, exported, and intentionally unwired', () => {
  it('the public entry exports the assertions for the first adapter with data', async () => {
    const index = stripComments(await readRepo('bench', 'harness', 'src', 'index.ts'));
    for (const name of ['checkPromptLeakage', 'checkHistoryIsolation', 'redactTaskRecord']) {
      expect(index, name).toContain(name);
    }
  });

  it('the assertions are exercised against fixtures, so they work on arrival day', async () => {
    const test = await readRepo('bench', 'harness', 'test', 'leakage.test.ts');
    expect(test).toContain('checkPromptLeakage');
    expect(test).toContain('checkHistoryIsolation');
  });

  it('no run invokes them, because the committed suites have no input to check', async () => {
    // P1.3, encoded so the fifth audit does not re-wire it by accident. Calling
    // either function from `runSuite` — hand-written edits in memory, no task
    // record, no payload, no checkout — would return clean on every run: the
    // appearance of enforcement without the substance. The same holds for
    // `runIndexSuite`: hand-written queries against a fixture copy, still no
    // record, no payload, and no repository with history. The wiring belongs in
    // the first adapter that prepares a task from a dataset, where the payload is
    // built and before it is handed over.
    const runner = stripComments(await readRepo('bench', 'harness', 'src', 'runner.ts'));
    expect(runner).not.toContain('leakage');
    expect(runner).not.toContain('checkPromptLeakage');
    expect(runner).not.toContain('checkHistoryIsolation');
    const indexBench = stripComments(await readRepo('bench', 'harness', 'src', 'index-bench.ts'));
    expect(indexBench).not.toContain('checkPromptLeakage');
    expect(indexBench).not.toContain('checkHistoryIsolation');
    const leakage = await readRepo('bench', 'harness', 'src', 'leakage.ts');
    expect(leakage).toContain('does not import');
  });

  it('every generated audit restates the gap, so it is visible in the artifact', async () => {
    const audit = await readRepo('bench', 'harness', 'src', 'audit.ts');
    expect(audit).toContain('checkPromptLeakage');
    expect(audit).toContain('checkHistoryIsolation');
  });
});

describe('publication statistics are reachable from the report pipeline', () => {
  it('the public entry exports the rules and the statistics', async () => {
    const index = stripComments(await readRepo('bench', 'harness', 'src', 'index.ts'));
    for (const name of [
      'compareToBaseline',
      'checkCitation',
      'estimatePassRate',
      'formatMeanSem',
      'looksLikeMaxOverN',
      'solvesPerMillionCompletionTokens',
    ]) {
      expect(index, name).toContain(name);
    }
  });

  it('the report gate enforces provenance through the citation rule', async () => {
    // `checkReportPolicy` builds the report's own first-party-harness citation
    // and refuses a report that cannot cite its own run. Rendering runs the gate
    // itself, so no clean-looking report.md can come out of a violating run.
    const policy = stripComments(await readRepo('bench', 'harness', 'src', 'report-policy.ts'));
    expect(policy).toContain('checkCitation');
    expect(policy).toContain('harnessCitation');
    const report = stripComments(await readRepo('bench', 'harness', 'src', 'report.ts'));
    expect(report).toContain('checkReportPolicy');
  });

  it('the baseline and max-over-N gates wait for a report shape carrying the data', async () => {
    // Same construction as the leakage section, for the same reason.
    // `compareToBaseline` needs a published baseline and `looksLikeMaxOverN`
    // needs per-attempt rates; a Tier-1 report carries neither. Calling either
    // on absent data would manufacture enforcement, so the policy declines and
    // says so at the length the decision warrants.
    const policy = stripComments(await readRepo('bench', 'harness', 'src', 'report-policy.ts'));
    expect(policy).not.toContain('compareToBaseline(');
    expect(policy).not.toContain('looksLikeMaxOverN(');
    // Prose, so read raw: the module header records what is not enforced and why,
    // at the length the decision warrants. Stripped text drops comment lines.
    const policyRaw = await readRepo('bench', 'harness', 'src', 'report-policy.ts');
    expect(policyRaw).toContain('Not enforced');
  });

  it('the audit names the validator levels that did not run', async () => {
    const audit = await readRepo('bench', 'harness', 'src', 'audit.ts');
    for (const level of ['tree-sitter', 'structural', 'none']) {
      expect(audit, level).toContain(level);
    }
  });
});

describe('surfaces reach the engine through the contract', () => {
  it('the CLI builds its flags and versions from the protocol', async () => {
    const flags = stripComments(await readRepo('packages', 'cli', 'src', 'agent', 'flags.ts'));
    expect(flags).toContain('@adze/protocol');
    const cli = stripComments(await readRepo('packages', 'cli', 'src', 'cli.ts'));
    expect(cli).toContain('PROTOCOL_VERSION');
  });

  it('the VS Code host constructs the engine and the gateway', async () => {
    const host = stripComments(await readRepo('apps', 'vscode', 'src', 'engine', 'host.ts'));
    expect(host).toContain("from '@adze/core'");
    expect(host).toContain("from '@adze/providers'");
    expect(host).toContain('new Engine(');
    expect(host).toContain('createGateway');
  });

  it('retrieval and search stay behind the seam, not a direct import', async () => {
    // Core declares `SearchBackend`; the CLI injects `@adze/retrieval` behind
    // it. The import below is the injection, in the surface, which is where it
    // belongs — core itself imports no retrieval implementation.
    const search = stripComments(await readRepo('packages', 'cli', 'src', 'agent', 'search.ts'));
    expect(search).toContain("from '@adze/retrieval'");
    const coreRetrieval = stripComments(await readRepo('packages', 'core', 'src', 'retrieval.ts'));
    expect(coreRetrieval).not.toContain("from '@adze/retrieval'");
  });
});
