/**
 * The two rules from `docs/benchmarks/strategy.md`, written as code.
 *
 * ADR-0011 puts them in an ADR rather than a style guide because they must be
 * non-negotiable by a maintainer who wants a launch. This module is the same
 * intention one level down: the rules are return values rather than prose, and there
 * is no parameter that relaxes either one.
 *
 * **Not yet wired into the reporter.** `renderReportMarkdown` does not call anything
 * here, and this module is not exported from `src/index.ts`. Every function below is
 * therefore a gate that a caller must choose to pass through, not one the report
 * generator already passes through. That wiring is the next step, and until it lands,
 * the honest description of these two rules is enforceable rather than enforced.
 *
 * **Rule 1 — no win claimed inside 3 percentage points.** `compareToBaseline`
 * returns a verdict, and `within-noise` is a verdict rather than a warning. There is
 * no `noiseFloor` argument, no `force`, and no `strict: false`. Getting a 2-point
 * lead described as a win takes editing this file and deleting a test, which is the
 * point. The floor is 3 points because a published study measured a 6-point
 * (p < 0.01) gap between most- and least-resourced container configurations — larger
 * than the gap between top leaderboard models — and naive binomial intervals already
 * span 1–2 points before that confounder stacks on top.
 *
 * **Rule 2 — no aggregator citations, ever.** `checkCitation` is default-deny.
 * A leaderboard host must be on a registry a maintainer curated by hand, and the
 * registry ships **empty**: no host is trusted until somebody verifies it and adds
 * it. That is deliberately inconvenient, and it is the only construction that
 * actually blocks the failure it was written for. During research for this project a
 * cluster of SEO aggregators was found publishing 96%, 96.4%, and 97.0% for the same
 * model on the same benchmark whose official leaderboard topped out at 79.20% — a
 * ~17-point gap between primary and secondary sources. A denylist of their names
 * would not have helped, because the names are disposable and the next cluster has
 * different ones. Default-deny does not care what they are called.
 */

import type { PassRateEstimate } from './statistics.js';
import { formatMeanSem, MIN_ATTEMPTS } from './statistics.js';

/**
 * Percentage points below which a difference is not a result.
 *
 * Not configurable, and not read from a config file. See the module comment.
 */
export const NOISE_FLOOR_POINTS = 3;

/**
 * Multiple of the combined standard error a difference must also clear.
 *
 * A second, independent reason to refuse. The infrastructure floor is a fixed 3
 * points regardless of how the run went; this one responds to how noisy *our* run
 * actually was. A difference has to clear both, and stating them separately means a
 * report says which one it failed.
 */
export const SEM_MULTIPLE = 2;

export type ComparisonVerdict =
  /** Our result is enough above the baseline to say so. */
  | 'ahead'
  /** The baseline is enough above ours to say so. Published anyway. */
  | 'behind'
  /** Inside the noise floor, or inside the statistical interval. Not a result. */
  | 'within-noise'
  /** Fewer than three attempts, or a baseline with no number. No comparison exists. */
  | 'insufficient-evidence';

/** A published number we are comparing against. */
export interface Baseline {
  /** The agent or system, e.g. `Cursor`. */
  readonly label: string;
  /** Their reported pass rate in [0, 1]. */
  readonly passRate: number;
  /** Their reported SEM in [0, 1], when they publish one. */
  readonly sem?: number;
  /** How many attempts theirs is over, when stated. */
  readonly attempts?: number;
  /** Where the number came from. Validated by `checkCitation`. */
  readonly citation: Citation;
}

export interface Comparison {
  readonly verdict: ComparisonVerdict;
  /** Ours minus theirs, in percentage points. `null` when there is no comparison. */
  readonly deltaPoints: number | null;
  /**
   * Whether a directional claim may be made in prose. False for `within-noise` and
   * `insufficient-evidence`, and the renderer refuses the word "beats" without it.
   */
  readonly claimable: boolean;
  /** Which gate refused, in a sentence fit to print in a report. */
  readonly explanation: string;
  /** Approved wording. The only phrasing a generated report is allowed to use. */
  readonly wording: string;
}

/**
 * Compare our estimate to a published baseline under both gates.
 *
 * Order matters. Insufficient evidence is reported before anything about the size of
 * the difference, because with two attempts the difference is not a quantity yet.
 */
export function compareToBaseline(ours: PassRateEstimate | null, baseline: Baseline): Comparison {
  if (ours === null) {
    return {
      verdict: 'insufficient-evidence',
      deltaPoints: null,
      claimable: false,
      explanation:
        'No estimate for Adze on this suite, so there is nothing to compare. ' +
        `An estimate requires at least ${MIN_ATTEMPTS} attempts.`,
      wording: `Adze has no published result on this suite. ${baseline.label} reports ${(
        baseline.passRate * 100
      ).toFixed(1)}%.`,
    };
  }

  const deltaPoints = (ours.mean - baseline.passRate) * 100;
  const magnitude = Math.abs(deltaPoints);
  const direction = deltaPoints > 0 ? 'ahead of' : 'behind';

  const combinedSem = Math.sqrt(ours.sem ** 2 + (baseline.sem ?? 0) ** 2) * 100 * SEM_MULTIPLE;

  if (magnitude < NOISE_FLOOR_POINTS) {
    return {
      verdict: 'within-noise',
      deltaPoints,
      claimable: false,
      explanation:
        `The difference is ${magnitude.toFixed(2)} percentage points, inside the ` +
        `${NOISE_FLOOR_POINTS}-point infrastructure noise floor. Published work measured a ` +
        '6-point (p < 0.01) gap between most- and least-resourced container ' +
        'configurations, which is larger than the gap between top leaderboard models. ' +
        'This is not a result in either direction, and it is reported that way even ' +
        'when the difference is ours.',
      wording:
        `Adze ${formatMeanSem(ours)} and ${baseline.label} ${(baseline.passRate * 100).toFixed(
          1,
        )}% are within noise of each other (${magnitude.toFixed(2)} points). ` +
        'Neither is ahead on this evidence.',
    };
  }

  if (magnitude < combinedSem) {
    return {
      verdict: 'within-noise',
      deltaPoints,
      claimable: false,
      explanation:
        `The difference is ${magnitude.toFixed(2)} percentage points, which clears the ` +
        `${NOISE_FLOOR_POINTS}-point floor but not ${SEM_MULTIPLE}× the combined standard ` +
        `error (${combinedSem.toFixed(2)} points). Our own run was too noisy to support a ` +
        'directional claim, independently of the infrastructure floor.',
      wording:
        `Adze ${formatMeanSem(ours)} and ${baseline.label} ${(baseline.passRate * 100).toFixed(
          1,
        )}% differ by ${magnitude.toFixed(2)} points, within ${SEM_MULTIPLE}× the combined ` +
        'standard error. Not a result.',
    };
  }

  return {
    verdict: deltaPoints > 0 ? 'ahead' : 'behind',
    deltaPoints,
    claimable: true,
    explanation:
      `The difference is ${magnitude.toFixed(2)} percentage points, clearing both the ` +
      `${NOISE_FLOOR_POINTS}-point infrastructure floor and ${SEM_MULTIPLE}× the combined ` +
      `standard error (${combinedSem.toFixed(2)} points).`,
    wording:
      `Adze ${formatMeanSem(ours)}, ${magnitude.toFixed(2)} points ${direction} ` +
      `${baseline.label} at ${(baseline.passRate * 100).toFixed(1)}%.`,
  };
}

// ---------------------------------------------------------------------------
// Rule 2 — sources
// ---------------------------------------------------------------------------

export type SourceKind =
  /**
   * A harness we ran ourselves. The evidence is the artifacts, not a link, so this
   * kind requires a version tag and the exact invocation instead of a URL.
   */
  | 'first-party-harness'
  /** The benchmark's own leaderboard. Requires a URL on the curated registry. */
  | 'first-party-leaderboard'
  /** A named evaluator with published methodology. Requires both, by name and link. */
  | 'independent-evaluator';

export interface Citation {
  readonly kind: SourceKind;
  /** What is being cited, e.g. `SWE-rebench leaderboard`. */
  readonly label: string;
  /** Required for `first-party-leaderboard`. Must be https. */
  readonly url?: string;
  /** Required for `first-party-harness`, e.g. `harbor`. */
  readonly harnessName?: string;
  /** Required for `first-party-harness`, e.g. `0.22.0`. */
  readonly harnessVersion?: string;
  /** Required for `first-party-harness`: the command that produced the number. */
  readonly invocation?: string;
  /** Required for `independent-evaluator`: who evaluated. Not a site name. */
  readonly evaluator?: string;
  /** Required for `independent-evaluator`: their published methodology. Must be https. */
  readonly methodologyUrl?: string;
  /** ISO date the URL was read. Required whenever a URL is cited. */
  readonly retrievedAt?: string;
}

/**
 * Hosts a maintainer has personally verified as a benchmark's own leaderboard.
 *
 * **Ships empty, and that is not an oversight.** Nothing may be added here on the
 * strength of a search result, a link in a blog post, or a model's recollection of
 * what a benchmark's domain is. Adding an entry is an assertion that somebody opened
 * the page, confirmed it is the benchmark's own publication rather than a mirror of
 * it, and is willing to have the report's credibility rest on that.
 *
 * Empty means every `first-party-leaderboard` citation is currently rejected. That is
 * the correct behaviour for a repository that has published no numbers: there is
 * nothing to cite yet, and the first person to cite something has to do the checking.
 */
export const VERIFIED_LEADERBOARD_HOSTS: readonly string[] = [];

/**
 * Hosts caught publishing fabricated or mutually contradictory numbers.
 *
 * Also empty, for the opposite reason: default-deny already blocks them. A denylist
 * is kept only so that a host found doing it can be recorded permanently, since a
 * name removed from the allowlist leaves no trace of why.
 */
export const KNOWN_AGGREGATOR_HOSTS: readonly string[] = [];

export interface SourceRegistry {
  readonly verifiedLeaderboardHosts: readonly string[];
  readonly knownAggregatorHosts: readonly string[];
}

export const DEFAULT_SOURCE_REGISTRY: SourceRegistry = {
  verifiedLeaderboardHosts: VERIFIED_LEADERBOARD_HOSTS,
  knownAggregatorHosts: KNOWN_AGGREGATOR_HOSTS,
};

export type CitationCheck =
  | { readonly ok: true; readonly kind: SourceKind }
  | { readonly ok: false; readonly problems: readonly string[] };

function hostOf(url: string): { readonly host: string } | { readonly error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `'${url}' is not a parseable URL` };
  }
  if (parsed.protocol !== 'https:') {
    return { error: `'${url}' is not https — a citation must be verifiable in transit` };
  }
  return { host: parsed.hostname.toLowerCase() };
}

/** `a.example.com` matches a registry entry of `example.com`. */
function hostMatches(host: string, entry: string): boolean {
  const normalized = entry.toLowerCase();
  return host === normalized || host.endsWith(`.${normalized}`);
}

function checkHarnessCitation(citation: Citation): string[] {
  const problems: string[] = [];
  if (citation.harnessName === undefined || citation.harnessName.length === 0) {
    problems.push("kind 'first-party-harness' requires 'harnessName'");
  }
  if (citation.harnessVersion === undefined || citation.harnessVersion.length === 0) {
    problems.push(
      "kind 'first-party-harness' requires 'harnessVersion' — a number produced by an " +
        'unpinned harness is not reproducible',
    );
  }
  if (citation.invocation === undefined || citation.invocation.length === 0) {
    problems.push(
      "kind 'first-party-harness' requires 'invocation' — SWE-rebench publishes the exact " +
        'command for every listed agent and so do we',
    );
  }
  return problems;
}

function checkLeaderboardCitation(citation: Citation, registry: SourceRegistry): string[] {
  const problems: string[] = [];
  if (citation.url === undefined) {
    problems.push("kind 'first-party-leaderboard' requires 'url'");
    return problems;
  }

  const resolved = hostOf(citation.url);
  if ('error' in resolved) {
    problems.push(resolved.error);
    return problems;
  }

  if (registry.knownAggregatorHosts.some((entry) => hostMatches(resolved.host, entry))) {
    problems.push(
      `'${resolved.host}' is a recorded aggregator. One citation to a polluted aggregator ` +
        'discredits an otherwise sound report.',
    );
    return problems;
  }

  if (!registry.verifiedLeaderboardHosts.some((entry) => hostMatches(resolved.host, entry))) {
    problems.push(
      `'${resolved.host}' is not on the verified-leaderboard registry, so it is refused. ` +
        'This is default-deny: a host is trusted only after a maintainer opens the page, ' +
        "confirms it is the benchmark's own publication rather than a mirror, and adds it " +
        'to VERIFIED_LEADERBOARD_HOSTS. Cite it as an independent evaluator with published ' +
        'methodology if that is what it is.',
    );
  }
  return problems;
}

function checkEvaluatorCitation(citation: Citation): string[] {
  const problems: string[] = [];
  if (citation.evaluator === undefined || citation.evaluator.length === 0) {
    problems.push(
      "kind 'independent-evaluator' requires 'evaluator' — a named evaluator, not a site " +
        'name. "Named" is the whole distinction from an aggregator.',
    );
  }
  if (citation.methodologyUrl === undefined) {
    problems.push(
      "kind 'independent-evaluator' requires 'methodologyUrl'. Published methodology is " +
        'the other half of the distinction: an aggregator has a number and no method.',
    );
  } else {
    const resolved = hostOf(citation.methodologyUrl);
    if ('error' in resolved) problems.push(resolved.error);
  }
  return problems;
}

/**
 * Whether a citation may appear in a published report.
 *
 * Default-deny in three places: an unrecognised `kind` is rejected, a leaderboard
 * host absent from the registry is rejected, and an evaluator without published
 * methodology is rejected.
 */
export function checkCitation(
  citation: Citation,
  registry: SourceRegistry = DEFAULT_SOURCE_REGISTRY,
): CitationCheck {
  const problems: string[] = [];

  if (citation.label.length === 0) problems.push("citation requires a non-empty 'label'");

  switch (citation.kind) {
    case 'first-party-harness':
      problems.push(...checkHarnessCitation(citation));
      break;
    case 'first-party-leaderboard':
      problems.push(...checkLeaderboardCitation(citation, registry));
      break;
    case 'independent-evaluator':
      problems.push(...checkEvaluatorCitation(citation));
      break;
    default:
      // Unreachable for a well-typed caller, and reachable for JSON parsed off disk,
      // which is exactly where an unknown kind would come from.
      problems.push(
        `unknown citation kind '${String(citation.kind)}'. Acceptable kinds are ` +
          'first-party-harness, first-party-leaderboard, and independent-evaluator. ' +
          'Nothing else, per docs/benchmarks/strategy.md.',
      );
  }

  if (
    (citation.url !== undefined || citation.methodologyUrl !== undefined) &&
    citation.retrievedAt === undefined
  ) {
    problems.push(
      "a cited URL requires 'retrievedAt' — leaderboards change and an undated citation " +
        'cannot be checked against what the page said',
    );
  }

  return problems.length === 0 ? { ok: true, kind: citation.kind } : { ok: false, problems };
}
