/**
 * Protocol revision negotiation.
 *
 * ## What the wire actually does, verified against the installed SDK
 *
 * The revision is settled **in the `initialize` handshake**, not per request:
 *
 * 1. the client sends `protocolVersion: LATEST_PROTOCOL_VERSION` in `initialize`;
 * 2. the server answers with the revision *it* chose, which may be older;
 * 3. the client accepts that answer only if it appears in
 *    `SUPPORTED_PROTOCOL_VERSIONS`, and otherwise throws;
 * 4. the client then calls `transport.setProtocolVersion(agreed)`, and the
 *    Streamable HTTP transport mirrors the agreed revision into every subsequent
 *    request as the `MCP-Protocol-Version` header.
 *
 * So **fallback is server-driven**: we advertise the newest revision we know and
 * accept an older one the server names. There is no client-side downgrade retry to
 * implement, and adding one would be a second, worse copy of step 3.
 *
 * ## Where this differs from what was specified to us
 *
 * The revisions are read from the SDK rather than written down here, because a
 * hard-coded revision string is a claim that goes stale silently. Three things we
 * were told to target do **not exist** in `@modelcontextprotocol/sdk@1.30.0`, and
 * are recorded here so the next person does not go looking for them:
 *
 * - **revision `2026-07-28`** — not present. The newest revision the SDK knows is
 *   `2025-11-25`, which is what {@link ADZE_PREFERRED_REVISION} resolves to. A
 *   server naming `2026-07-28` is refused as unrecognized, which is the correct
 *   outcome: we cannot claim to speak a revision whose schemas we do not have.
 * - **`_meta` key `io.modelcontextprotocol/protocolVersion`** — not present. The
 *   only `io.modelcontextprotocol/*` `_meta` key in the SDK is `related-task`.
 *   Version negotiation never moved out of the handshake.
 * - **a `server/discover` RPC** — not present. Discovery is still the three
 *   list calls — `tools/list`, `resources/list`, `prompts/list` — which is what
 *   {@link discoverServer} performs.
 *
 * The `MCP-Protocol-Version` header *is* real, and is set by the transport from the
 * agreed revision rather than by anything in this package.
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * The revision Adze advertises: whatever the installed SDK considers newest.
 *
 * Derived rather than literal on purpose. Pinning a string here would let the
 * declared revision drift away from the schemas actually used to parse messages,
 * and the failure would appear as a validation error against a server that is
 * behaving correctly.
 */
export const ADZE_PREFERRED_REVISION: string = LATEST_PROTOCOL_VERSION;

/** Every revision this build can parse, newest first. The fallback ladder. */
export const ADZE_ACCEPTED_REVISIONS: readonly string[] = [...SUPPORTED_PROTOCOL_VERSIONS];

export type RevisionOutcome =
  | {
      readonly ok: true;
      readonly revision: string;
      /** False when we accepted an older revision than we asked for. */
      readonly exact: boolean;
    }
  | { readonly ok: false; readonly offered: string; readonly message: string };

/**
 * Decide whether a server's chosen revision is one we can speak.
 *
 * Split out as a pure function because it is the one piece of negotiation with
 * interesting behaviour, and testing it through a live handshake would test the
 * SDK's `initialize` rather than our policy.
 *
 * An unrecognized revision is refused rather than optimistically accepted. A
 * *newer* revision is the tempting case to wave through — it will often work — but
 * accepting it means parsing messages with schemas that predate it and reporting a
 * revision we cannot actually validate, which is the kind of claim
 * `ValidationResult.validator` exists to forbid elsewhere in this codebase.
 */
export function negotiateRevision(offered: string): RevisionOutcome {
  if (offered === ADZE_PREFERRED_REVISION) {
    return { ok: true, revision: offered, exact: true };
  }
  if (ADZE_ACCEPTED_REVISIONS.includes(offered)) {
    return { ok: true, revision: offered, exact: false };
  }
  return {
    ok: false,
    offered,
    message:
      `server chose MCP revision '${offered}', which this build cannot parse. ` +
      `Adze advertises '${ADZE_PREFERRED_REVISION}' and accepts ` +
      `${ADZE_ACCEPTED_REVISIONS.join(', ')}.`,
  };
}

/**
 * The subset of `Transport` this wrapper delegates to.
 *
 * Declared explicitly rather than reusing `Transport` because of a genuine collision
 * between this repo's compiler settings and the SDK's typings. `Transport` declares
 * `sessionId?: string`, and under `exactOptionalPropertyTypes` that means "absent, or
 * a `string`" — but `StreamableHTTPClientTransport` exposes
 * `get sessionId(): string | undefined`, so the SDK's own transports are not
 * assignable to the SDK's own interface once the setting is on. Naming the members
 * this wrapper actually uses, with the permissive `| undefined` that indexed access
 * yields, accepts every SDK transport without weakening a setting or reaching for a
 * cast.
 */
export interface InnerTransport {
  start(): Promise<void>;
  send(message: JSONRPCMessage, options?: Parameters<Transport['send']>[1]): Promise<void>;
  close(): Promise<void>;
  onmessage?: Transport['onmessage'];
  onerror?: Transport['onerror'];
  onclose?: Transport['onclose'];
  setProtocolVersion?: Transport['setProtocolVersion'];
}

/**
 * A transport that records the agreed revision on its way past.
 *
 * `Client` does not expose the negotiated revision — it has `getServerVersion()`,
 * which is the server's *implementation* name and version, an entirely different
 * fact — but it does call the optional `setProtocolVersion` hook on the transport.
 * Wrapping the transport is therefore the only way to observe what was agreed, and
 * it works identically over stdio, Streamable HTTP, and the in-memory pair, which
 * is what lets negotiation be tested without a network or a subprocess.
 *
 * Delegation is total: every member forwards. The wrapper adds an observation and
 * changes no behaviour. `sessionId` is deliberately not re-exposed — it is optional
 * on `Transport`, nothing in `Client` requires it, and forwarding it is what would
 * reintroduce the assignability problem described on {@link InnerTransport}.
 */
export class RevisionRecordingTransport implements Transport {
  private agreed: string | undefined;

  constructor(private readonly inner: InnerTransport) {}

  /** The revision the handshake settled on, or `undefined` before it completes. */
  get agreedRevision(): string | undefined {
    return this.agreed;
  }

  setProtocolVersion = (version: string): void => {
    this.agreed = version;
    this.inner.setProtocolVersion?.(version);
  };

  async start(): Promise<void> {
    // Callbacks are wired at start rather than in the constructor because `Client`
    // assigns them after construction; forwarding earlier would capture undefined.
    this.inner.onmessage = (message, extra) => this.onmessage?.(message, extra);
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onclose = () => this.onclose?.();
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: Parameters<Transport['send']>[1]): Promise<void> {
    await this.inner.send(message, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  // Declared without an explicit `| undefined` so they stay exact-optional and this
  // class remains assignable to `Transport`. `Client` assigns each one after connect.
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
}
