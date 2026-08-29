/**
 * Protocol version and negotiation.
 *
 * ADR-0001 makes the protocol the only channel between a surface and the engine,
 * which means a version mismatch has to fail in a way that tells the user which
 * component to update. A silent mismatch here surfaces as an unexplained missing
 * feature three layers away.
 */

import { z } from 'zod';

/**
 * The version this build speaks. `MAJOR.MINOR`, no patch: a patch release cannot
 * change a wire contract, so encoding one would imply a distinction we do not
 * make.
 *
 * `0.x` carries no stability guarantee. Per docs/architecture/README.md the
 * protocol becomes semver-strict at 0.2.
 */
export const PROTOCOL_VERSION = '0.1';

/**
 * Every version this build accepts, newest last.
 *
 * Deliberately explicit rather than a range. Negotiation intersects the two
 * advertised sets and does **not** assume that a peer advertising `0.3` also
 * speaks `0.1` — that assumption is a promise nobody wrote down, and it breaks
 * silently the first time a minor version removes something. If we ever drop
 * support for a version, it comes out of this list and negotiation starts failing
 * loudly, which is the correct outcome.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [PROTOCOL_VERSION];

export const ProtocolVersionSchema = z
  .string()
  .regex(/^\d+\.\d+$/, 'protocol version must be MAJOR.MINOR');

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
}

export function parseProtocolVersion(version: string): ParsedVersion | undefined {
  const m = /^(\d+)\.(\d+)$/.exec(version);
  const major = m?.[1];
  const minor = m?.[2];
  if (major === undefined || minor === undefined) return undefined;
  return { major: Number(major), minor: Number(minor) };
}

export type VersionNegotiation =
  | { readonly ok: true; readonly version: string }
  | {
      readonly ok: false;
      /** Written for a user to act on: which side is behind, and what to do. */
      readonly message: string;
      readonly clientVersions: readonly string[];
      readonly engineVersions: readonly string[];
    };

function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  return a.major !== b.major ? a.major - b.major : a.minor - b.minor;
}

/**
 * Pick the newest version both peers advertise.
 *
 * Returns a distinct message for "no shared major" versus "shared major, no
 * shared minor", because the remedies differ: the first means one component is a
 * generation behind, the second usually means a mixed install where one package
 * was updated and another was not.
 */
export function negotiateProtocolVersion(
  clientVersions: readonly string[],
  engineVersions: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS,
): VersionNegotiation {
  const client = clientVersions
    .map((v) => ({ raw: v, parsed: parseProtocolVersion(v) }))
    .filter((v): v is { raw: string; parsed: ParsedVersion } => v.parsed !== undefined);
  const engine = engineVersions
    .map((v) => ({ raw: v, parsed: parseProtocolVersion(v) }))
    .filter((v): v is { raw: string; parsed: ParsedVersion } => v.parsed !== undefined);

  if (client.length === 0) {
    return {
      ok: false,
      message:
        clientVersions.length === 0
          ? 'the client advertised no protocol versions'
          : `the client advertised no well-formed protocol versions (got ${clientVersions.join(', ')}); expected MAJOR.MINOR`,
      clientVersions,
      engineVersions,
    };
  }
  if (engine.length === 0) {
    return {
      ok: false,
      message: 'the engine advertised no well-formed protocol versions',
      clientVersions,
      engineVersions,
    };
  }

  const shared = client
    .filter((c) => engine.some((e) => e.raw === c.raw))
    .sort((a, b) => compareVersions(b.parsed, a.parsed));

  const best = shared[0];
  if (best !== undefined) return { ok: true, version: best.raw };

  const sharedMajors = client
    .map((c) => c.parsed.major)
    .filter((maj) => engine.some((e) => e.parsed.major === maj));

  const message =
    sharedMajors.length > 0
      ? `no shared protocol minor version. The client speaks ${clientVersions.join(', ')} and the engine speaks ${engineVersions.join(', ')}. This is usually a partial install — update @adze/protocol in both.`
      : `incompatible protocol major version. The client speaks ${clientVersions.join(', ')} and the engine speaks ${engineVersions.join(', ')}. One of the two is a generation behind and must be updated.`;

  return { ok: false, message, clientVersions, engineVersions };
}
