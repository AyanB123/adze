import { describe, expect, it } from 'vitest';
import {
  isJsonRpcErrorResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcSuccess,
  JsonRpcErrorCode,
  JsonRpcErrorResponseSchema,
  JsonRpcMessageSchema,
  JsonRpcNotificationSchema,
  JsonRpcRequestSchema,
  JsonRpcSuccessSchema,
  jsonRpcError,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcSuccess,
} from '../src/jsonrpc.js';

describe('JSON-RPC framing — round trip', () => {
  it('round-trips a request through JSON', () => {
    const req = jsonRpcRequest(1, 'session.create', { workspaceRoot: '/w' });
    const parsed = JsonRpcRequestSchema.parse(JSON.parse(JSON.stringify(req)));
    expect(parsed).toEqual(req);
    expect(parsed.id).toBe(1);
  });

  it('round-trips a string id', () => {
    const req = jsonRpcRequest('abc-1', 'turn.cancel', { sessionId: 's', turnId: 't' });
    expect(JsonRpcRequestSchema.parse(JSON.parse(JSON.stringify(req)))).toEqual(req);
  });

  it('round-trips a notification, which carries no id', () => {
    const note = jsonRpcNotification('event', { event: null });
    const parsed = JsonRpcNotificationSchema.parse(JSON.parse(JSON.stringify(note)));
    expect(parsed).toEqual(note);
    expect('id' in parsed).toBe(false);
  });

  it('round-trips a success response', () => {
    const res = jsonRpcSuccess(7, { turnId: 't-1' });
    expect(JsonRpcSuccessSchema.parse(JSON.parse(JSON.stringify(res)))).toEqual(res);
  });

  it('round-trips an error response with structured data', () => {
    const res = jsonRpcError(7, JsonRpcErrorCode.InvalidParams, 'bad params', {
      issues: ['prompt: too small'],
    });
    expect(JsonRpcErrorResponseSchema.parse(JSON.parse(JSON.stringify(res)))).toEqual(res);
  });

  it('omits params entirely rather than sending null', () => {
    // `"params": null` is a different message from an absent params, and some
    // strict peers reject it. The constructor must not introduce the key.
    const req = jsonRpcRequest(1, 'ping');
    expect(Object.hasOwn(req, 'params')).toBe(false);
    expect(JSON.stringify(req)).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  });

  it('allows a null id on an error response only', () => {
    // Per JSON-RPC 2.0 the id is null when the request could not be parsed well
    // enough to recover one.
    expect(JsonRpcErrorResponseSchema.safeParse(jsonRpcError(null, -32700, 'parse')).success).toBe(
      true,
    );
    expect(JsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', id: null, method: 'x' }).success).toBe(
      false,
    );
  });
});

describe('JSON-RPC framing — malformed input is rejected', () => {
  it('rejects a missing or wrong jsonrpc version', () => {
    expect(JsonRpcRequestSchema.safeParse({ id: 1, method: 'x' }).success).toBe(false);
    expect(JsonRpcRequestSchema.safeParse({ jsonrpc: '1.0', id: 1, method: 'x' }).success).toBe(
      false,
    );
  });

  it('rejects an empty method name', () => {
    expect(JsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', id: 1, method: '' }).success).toBe(
      false,
    );
  });

  it('rejects a non-integer numeric id', () => {
    expect(JsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', id: 1.5, method: 'x' }).success).toBe(
      false,
    );
  });

  it('rejects unknown keys instead of stripping them', () => {
    // Strict objects are the whole reason version negotiation is worth having: a
    // stripped key is a field the sender considered important and the receiver
    // discarded without telling anyone.
    const result = JsonRpcRequestSchema.safeParse({
      jsonrpc: '2.0',
      id: 1,
      method: 'x',
      extra: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects params that are not JSON-representable', () => {
    expect(
      JsonRpcRequestSchema.safeParse({
        jsonrpc: '2.0',
        id: 1,
        method: 'x',
        params: { when: new Date() },
      }).success,
    ).toBe(false);
  });

  it('rejects a response that is both a success and an error', () => {
    const both = { jsonrpc: '2.0', id: 1, result: {}, error: { code: -1, message: 'x' } };
    expect(JsonRpcSuccessSchema.safeParse(both).success).toBe(false);
    expect(JsonRpcErrorResponseSchema.safeParse(both).success).toBe(false);
  });
});

describe('JSON-RPC framing — message classification', () => {
  it('classifies a request as a request, not as a notification', () => {
    // Regression guard on union order. A notification is structurally a request
    // without `id`, so if the notification variant were tried first, every request
    // would validate as one and lose the id the caller needs to correlate a reply.
    const parsed = JsonRpcMessageSchema.parse(jsonRpcRequest(3, 'turn.submit', { prompt: 'hi' }));
    expect(isJsonRpcRequest(parsed)).toBe(true);
    expect(isJsonRpcNotification(parsed)).toBe(false);
    if (isJsonRpcRequest(parsed)) expect(parsed.id).toBe(3);
  });

  it('classifies each of the four shapes exactly once', () => {
    const cases = [
      { m: jsonRpcRequest(1, 'a'), req: true, note: false, ok: false, err: false },
      { m: jsonRpcNotification('a'), req: false, note: true, ok: false, err: false },
      { m: jsonRpcSuccess(1, {}), req: false, note: false, ok: true, err: false },
      { m: jsonRpcError(1, -1, 'x'), req: false, note: false, ok: false, err: true },
    ] as const;

    for (const c of cases) {
      const parsed = JsonRpcMessageSchema.parse(c.m);
      expect(isJsonRpcRequest(parsed)).toBe(c.req);
      expect(isJsonRpcNotification(parsed)).toBe(c.note);
      expect(isJsonRpcSuccess(parsed)).toBe(c.ok);
      expect(isJsonRpcErrorResponse(parsed)).toBe(c.err);
    }
  });
});

describe('JSON-RPC error codes', () => {
  it('keeps Adze codes inside the implementation-defined range', () => {
    // -32000..-32099 is the server-error range JSON-RPC 2.0 reserves for
    // implementations. Straying outside it collides with the spec's own codes.
    const adze = [
      JsonRpcErrorCode.ProtocolVersionUnsupported,
      JsonRpcErrorCode.SessionNotFound,
      JsonRpcErrorCode.TurnAlreadyActive,
      JsonRpcErrorCode.TurnNotFound,
      JsonRpcErrorCode.PermissionDenied,
      JsonRpcErrorCode.ApprovalRefused,
      JsonRpcErrorCode.BudgetExhausted,
      JsonRpcErrorCode.Cancelled,
      JsonRpcErrorCode.ProviderDegraded,
    ];
    for (const code of adze) {
      expect(code).toBeLessThanOrEqual(-32000);
      expect(code).toBeGreaterThanOrEqual(-32099);
    }
  });

  it('assigns every code a distinct value', () => {
    const values = Object.values(JsonRpcErrorCode);
    expect(new Set(values).size).toBe(values.length);
  });

  it('keeps refusal distinct from denial', () => {
    // ADR-0007: `never` refuses rather than escalating, and that is a different
    // situation from the sandbox mode forbidding the action outright. Collapsing
    // them would leave a caller unable to tell "ask the user to change policy"
    // from "this is not permitted at all".
    expect(JsonRpcErrorCode.ApprovalRefused).not.toBe(JsonRpcErrorCode.PermissionDenied);
  });
});
