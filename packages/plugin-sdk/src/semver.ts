/**
 * A small semver range checker, for `engines.adze` and nothing else.
 *
 * This exists rather than a dependency because `@adze/plugin-sdk` needs exactly
 * one thing — "does this engine version satisfy this range" — and the answer has
 * to be decidable without a network, without an install script, and without
 * widening the supply-chain surface of the package that decides whether
 * third-party code is allowed to load. Every dependency added here is a
 * dependency a plugin's trust decision rests on.
 *
 * **The supported grammar is deliberately narrow, and anything outside it is an
 * error rather than a pass.** That direction matters: a range this code cannot
 * parse is a range whose author expected some behaviour we would be guessing at,
 * and guessing "satisfied" would load a plugin against an engine its author never
 * tested. Supported:
 *
 * - `*` — any version.
 * - `1.2.3` — exactly that version.
 * - `>=1.2.3`, `>1.2.3`, `<=1.2.3`, `<1.2.3`, `=1.2.3`
 * - `^1.2.3` — compatible-with, including the 0.x rule where `^0.2.3` allows
 *   `>=0.2.3 <0.3.0` because a 0.x minor bump is a breaking change by convention.
 * - `~1.2.3` — `>=1.2.3 <1.3.0`
 * - space-separated comparators, meaning AND: `>=0.4.0 <2.0.0`
 * - `||`, meaning OR: `^1.0.0 || ^2.0.0`
 *
 * Not supported, and reported as such: hyphen ranges (`1.0.0 - 2.0.0`),
 * X-ranges (`1.x`, `1.2.*`), and partial versions (`>=1`).
 *
 * Prerelease handling follows semver: a prerelease version satisfies a comparator
 * set only when some comparator in that set names a prerelease of the same
 * `major.minor.patch`. Without that rule `>=0.4.0` would accept `1.0.0-alpha.1`,
 * which is how a plugin ends up loaded against an engine build that was
 * explicitly not ready for it.
 */

export interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated identifiers, empty when the version is a release. */
  readonly prerelease: readonly (string | number)[];
}

export type VersionParseOutcome =
  | { readonly ok: true; readonly version: SemanticVersion }
  | { readonly ok: false; readonly message: string };

export type RangeCheckOutcome =
  | { readonly ok: true; readonly satisfied: boolean }
  /** The range itself could not be understood. Never treated as satisfied. */
  | { readonly ok: false; readonly message: string };

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseVersion(raw: string): VersionParseOutcome {
  const match = VERSION_PATTERN.exec(raw.trim());
  if (match === null) {
    return {
      ok: false,
      message:
        `'${raw}' is not a semantic version. Expected major.minor.patch, ` +
        `optionally with a prerelease such as 1.2.3-rc.1.`,
    };
  }
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    return { ok: false, message: `'${raw}' is not a semantic version.` };
  }
  return {
    ok: true,
    version: {
      major: Number(major),
      minor: Number(minor),
      patch: Number(patch),
      prerelease: prerelease === undefined ? [] : prerelease.split('.').map(identifier),
    },
  };
}

function identifier(part: string): string | number {
  return /^(0|[1-9]\d*)$/.test(part) ? Number(part) : part;
}

/** Standard semver precedence, including the prerelease rules. */
export function compareVersions(a: SemanticVersion, b: SemanticVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  // A release outranks any prerelease of the same triple.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const shared = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < shared; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined || right === undefined) break;
    if (left === right) continue;
    const leftNumeric = typeof left === 'number';
    const rightNumeric = typeof right === 'number';
    if (leftNumeric && rightNumeric) return left < right ? -1 : 1;
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return String(left) < String(right) ? -1 : 1;
  }
  if (a.prerelease.length === b.prerelease.length) return 0;
  return a.prerelease.length < b.prerelease.length ? -1 : 1;
}

type Operator = '<' | '<=' | '>' | '>=' | '=';

interface Comparator {
  readonly operator: Operator;
  readonly version: SemanticVersion;
}

type ComparatorOutcome =
  | { readonly ok: true; readonly comparators: readonly Comparator[] }
  | { readonly ok: false; readonly message: string };

function desugar(token: string): ComparatorOutcome {
  // A bare `1.0.0-rc.1` is a prerelease and fine. `1.0.0 - 2.0.0` is split on
  // whitespace before reaching here, so a lone `-` token is the give-away for a
  // hyphen range and is refused by name rather than as a bad version.
  if (token === '-') {
    return {
      ok: false,
      message: 'hyphen ranges such as "1.0.0 - 2.0.0" are not supported. Use ">=1.0.0 <=2.0.0".',
    };
  }

  const caret = token.startsWith('^');
  const tilde = token.startsWith('~');
  if (caret || tilde) {
    const parsed = parseVersion(token.slice(1));
    if (!parsed.ok) return { ok: false, message: parsed.message };
    const base = parsed.version;
    const upper = caret ? caretUpperBound(base) : tildeUpperBound(base);
    return {
      ok: true,
      comparators: [
        { operator: '>=', version: base },
        { operator: '<', version: upper },
      ],
    };
  }

  const operatorMatch = /^(>=|<=|>|<|=)?(.+)$/.exec(token);
  if (operatorMatch === null) {
    return { ok: false, message: `'${token}' is not a version comparator.` };
  }
  const [, rawOperator, rawVersion] = operatorMatch;
  if (rawVersion === undefined) {
    return { ok: false, message: `'${token}' is missing a version.` };
  }
  if (/[*x]/i.test(rawVersion)) {
    return {
      ok: false,
      message:
        `'${token}' uses an X-range. Those are not supported because the ` +
        `intended bound is ambiguous; write it out, e.g. ">=1.0.0 <2.0.0".`,
    };
  }
  const parsed = parseVersion(rawVersion);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  return {
    ok: true,
    comparators: [
      { operator: (rawOperator as Operator | undefined) ?? '=', version: parsed.version },
    ],
  };
}

function caretUpperBound(base: SemanticVersion): SemanticVersion {
  if (base.major > 0) return { major: base.major + 1, minor: 0, patch: 0, prerelease: [] };
  if (base.minor > 0) return { major: 0, minor: base.minor + 1, patch: 0, prerelease: [] };
  // ^0.0.3 allows only 0.0.3: below 1.0.0 every segment can break.
  return { major: 0, minor: 0, patch: base.patch + 1, prerelease: [] };
}

function tildeUpperBound(base: SemanticVersion): SemanticVersion {
  return { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [] };
}

function satisfiesComparator(version: SemanticVersion, comparator: Comparator): boolean {
  const order = compareVersions(version, comparator.version);
  switch (comparator.operator) {
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    case '=':
      return order === 0;
  }
}

function samePrereleaseTuple(a: SemanticVersion, b: SemanticVersion): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

/**
 * Does `rawVersion` satisfy `rawRange`?
 *
 * Returns an outcome rather than a boolean so an unparseable range is
 * distinguishable from an unsatisfied one. Collapsing the two would make a typo in
 * a range look like an incompatible engine, and the fix for those is different.
 */
export function satisfiesRange(rawVersion: string, rawRange: string): RangeCheckOutcome {
  const parsedVersion = parseVersion(rawVersion);
  if (!parsedVersion.ok) return { ok: false, message: parsedVersion.message };
  const version = parsedVersion.version;

  const trimmed = rawRange.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'the range is empty. Use "*" to mean any version.' };
  }

  return evaluate(version, trimmed);
}

function evaluate(version: SemanticVersion, trimmed: string): RangeCheckOutcome {
  let anySatisfied = false;

  for (const alternative of trimmed.split('||')) {
    const tokens = alternative
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0);
    if (tokens.length === 0) {
      return {
        ok: false,
        message: `'${trimmed}' has an empty alternative around '||'.`,
      };
    }

    const comparators: Comparator[] = [];
    for (const token of tokens) {
      if (token === '*') {
        // `*` is only meaningful alone. `>=1.0.0 *` is a typo, not a wildcard.
        if (tokens.length !== 1) {
          return { ok: false, message: `'*' cannot be combined with other comparators.` };
        }
        comparators.length = 0;
        break;
      }
      const desugared = desugar(token);
      if (!desugared.ok) return { ok: false, message: desugared.message };
      comparators.push(...desugared.comparators);
    }

    if (comparators.length === 0) {
      // `*`: any release. A prerelease still needs to be asked for explicitly.
      if (version.prerelease.length === 0) return { ok: true, satisfied: true };
      continue;
    }

    const allHold = comparators.every((comparator) => satisfiesComparator(version, comparator));
    if (!allHold) continue;

    if (version.prerelease.length > 0) {
      // Semver's prerelease rule: opting into a prerelease has to be explicit.
      const opted = comparators.some(
        (comparator) =>
          comparator.version.prerelease.length > 0 &&
          samePrereleaseTuple(version, comparator.version),
      );
      if (!opted) continue;
    }

    anySatisfied = true;
  }

  return { ok: true, satisfied: anySatisfied };
}
