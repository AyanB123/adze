/**
 * Structural proof that no tool call reaches execution without passing the gate.
 *
 * Architecture invariant 4 says there must be *no code path* around the permission
 * gate. A behavioural test proves it for the paths a test happens to exercise; these
 * assertions are about the shape of the code, so they hold for paths nobody thought
 * to test — including tools added next year.
 *
 * Four independent checks, because each one alone has a hole:
 *
 * 1. **Only the dispatcher executes tools.** A source scan: `.execute(` appears in
 *    `dispatch.ts` and nowhere else in `src/`. Catches a future call site that
 *    bypasses authorization entirely.
 * 2. **Only the gate mints grants.** `mintGrant` appears in `permissions.ts` alone,
 *    and no source file casts to `Grant`. Catches a forged capability.
 * 3. **Built-in tools reach the outside world only through the grant.** No file
 *    under `src/tools/` imports `node:child_process`, `node:fs`, `node:fs/promises`,
 *    `node:http`, `node:https`, or `node:net`. Catches a tool that skips the grant
 *    by importing the world directly — the one hole the type system cannot close.
 * 4. **Every built-in is actually stopped by a denying gate.** Table-driven across
 *    the whole registry rather than one representative tool, so a new built-in is
 *    covered the moment it is registered.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonObject } from '@adze/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NullBroker } from '../src/broker.js';
import { dispatchToolCall } from '../src/dispatch.js';
import { MemoryFileSystem } from '../src/fs.js';
import { HookBus } from '../src/hooks.js';
import { sequentialIdFactory } from '../src/ids.js';
import { PermissionGate } from '../src/permissions.js';
import { defineTool, ToolRegistry } from '../src/registry.js';
import { builtinTools } from '../src/tools/index.js';
import { ContinuationStore } from '../src/truncate.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

async function sourceFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

async function filesContaining(dir: string, needle: string): Promise<readonly string[]> {
  const matches: string[] = [];
  for (const file of await sourceFiles(dir)) {
    const text = await readFile(file, 'utf8');
    // Comments discuss these identifiers by name, which is the point of documenting
    // the invariant. Only code lines count.
    const code = text
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join('\n');
    if (code.includes(needle)) matches.push(file.slice(SRC.length + 1).replaceAll('\\', '/'));
  }
  return matches.sort();
}

describe('gate coverage — only the dispatcher executes a tool', () => {
  it('confines `.execute(` to the erasure wrapper and the dispatcher', async () => {
    // A tripwire, and the two entries are the whole permitted set. `registry.ts` holds
    // the closure `defineTool` builds; `dispatch.ts` is the only thing that calls it,
    // and it can only do so with a `ToolContext` carrying a gate-minted `Grant`. Any
    // third file appearing here is a new path to execution and fails this test until
    // someone justifies it.
    expect(await filesContaining(SRC, '.execute(')).toEqual(['dispatch.ts', 'registry.ts']);
  });

  it('confines invocation of a prepared call to dispatch.ts', async () => {
    expect(await filesContaining(SRC, 'call.execute(')).toEqual(['dispatch.ts']);
  });

  it('confines grant minting to permissions.ts', async () => {
    expect(await filesContaining(SRC, 'mintGrant')).toEqual(['permissions.ts']);
  });

  it('has no source file casting its way to a Grant', async () => {
    expect(await filesContaining(SRC, 'as Grant')).toEqual(['permissions.ts']);
  });
});

describe('gate coverage — built-in tools have no private route to the machine', () => {
  const forbidden = [
    'node:child_process',
    'node:fs',
    'node:fs/promises',
    'node:http',
    'node:https',
    'node:net',
    'node:dgram',
  ];

  for (const module of forbidden) {
    it(`no tool imports ${module}`, async () => {
      const offenders = await filesContaining(join(SRC, 'tools'), `'${module}'`);
      expect(offenders).toEqual([]);
    });
  }
});

interface Harness {
  readonly registry: ToolRegistry;
  readonly deps: Parameters<typeof dispatchToolCall>[1];
}

interface HarnessOptions {
  readonly approvals: 'never' | 'on-request' | 'untrusted';
  readonly tools?: readonly Parameters<ToolRegistry['register']>[0][];
  /** When set, every prompt is answered this way. */
  readonly decision?: 'allow-once' | 'deny';
}

function harness(options: HarnessOptions): Harness {
  const fs = new MemoryFileSystem();
  fs.seedDirectory('/work');
  const registry = new ToolRegistry(
    options.tools ?? builtinTools({ nextId: sequentialIdFactory() }),
  );
  const gate = new PermissionGate({
    workspaceRoot: '/work',
    sandbox: { mode: 'read-only', writableRoots: [], allowedNetworkHosts: [], commandRules: [] },
    approvals: options.approvals,
    broker: new NullBroker(),
    fs,
    nextRequestId: () => 'appr_1',
    platform: 'win32',
    ...(options.decision === undefined
      ? {}
      : {
          requestApproval: async (request) =>
            await Promise.resolve({
              requestId: request.requestId,
              decision: options.decision ?? 'deny',
            }),
        }),
  });
  return {
    registry,
    deps: {
      registry,
      gate,
      hooks: new HookBus(),
      continuations: new ContinuationStore(() => 'cont_1'),
      workspaceRoot: '/work',
      sessionId: 'sess_1',
      turnId: 'turn_1',
      limits: { maxResultBytes: 4096, timeoutMs: 1000 },
      signal: new AbortController().signal,
      search: undefined,
      todos: [],
      runSubagent: undefined,
    },
  };
}

/** Arguments that pass each built-in's schema, so the gate is what stops the call. */
const SAMPLE_ARGS: Readonly<Record<string, JsonObject>> = {
  bash: { command: 'echo hi' },
  read: { path: 'a.ts' },
  write: { path: 'a.ts', content: 'x' },
  edit: { path: 'a.ts', edits: [{ search: 'a', replace: 'b' }] },
  glob: { patterns: ['**/*.ts'] },
  grep: { query: 'needle' },
  symbols: { name: 'Thing' },
  todo: { items: [] },
  task: { prompt: 'do a thing', tools: ['read'] },
};

describe('gate coverage — a denying gate stops every effectful built-in', () => {
  const names = builtinTools({ nextId: sequentialIdFactory() }).map((tool) => tool.name);

  it('covers every registered built-in with sample arguments', () => {
    // Guards the table below: a built-in added without a sample would otherwise be
    // silently untested by the loop that follows.
    expect(Object.keys(SAMPLE_ARGS).sort()).toEqual([...names].sort());
  });

  for (const name of names) {
    it(`${name} is denied, or declares no effects to deny`, async () => {
      // `untrusted` puts every declared effect in front of the user, and the user says
      // no. That is the only configuration under which a *read* inside the workspace is
      // also refused, which is what makes this table cover all nine built-ins rather
      // than only the ones that write.
      const { deps } = harness({ approvals: 'untrusted', decision: 'deny' });
      const args = SAMPLE_ARGS[name] ?? {};
      const outcome = await dispatchToolCall(
        { callId: 'c1', name, arguments: args, step: 0 },
        deps,
      );

      const prepared = deps.registry.get(name)?.prepare(args);
      if (prepared?.ok !== true) throw new Error(`sample args for '${name}' are invalid`);
      const effects = prepared.call.effects({ workspaceRoot: '/work' });

      if (effects.length === 0) {
        // `todo` and `task` touch nothing, so there is nothing for the gate to refuse.
        // They still passed through it; the spy tests below prove the ordering.
        expect(outcome.kind).toBe('executed');
        return;
      }
      expect(outcome.kind).toBe('denied');
      if (outcome.kind !== 'denied') return;
      expect(outcome.source).toBe('gate');
    });
  }

  it('read-only plus never refuses every write without asking', async () => {
    const { deps } = harness({ approvals: 'never' });
    for (const name of ['write', 'edit'] as const) {
      const outcome = await dispatchToolCall(
        { callId: 'c1', name, arguments: SAMPLE_ARGS[name] ?? {}, step: 0 },
        deps,
      );
      expect(outcome.kind, name).toBe('denied');
    }
  });
});

describe('gate coverage — the tool body never runs when the gate denies', () => {
  it('does not invoke execute for a denied call', async () => {
    let executed = false;
    const spy = defineTool({
      name: 'spy',
      description: 'records whether it ran',
      schema: z.object({}),
      effects: () => [{ kind: 'file-write', path: '/work/x' }],
      execute: async () => {
        executed = true;
        return await Promise.resolve({ ok: true, content: [] });
      },
    });

    const { deps } = harness({ approvals: 'never', tools: [spy] });
    const outcome = await dispatchToolCall(
      { callId: 'c1', name: 'spy', arguments: {}, step: 0 },
      deps,
    );

    expect(outcome.kind).toBe('denied');
    // The property under test. A gate that denied but let the body run would pass
    // every other assertion in this file.
    expect(executed).toBe(false);
  });

  it('does invoke execute once the gate allows', async () => {
    let executed = false;
    const spy = defineTool({
      name: 'spy',
      description: 'records whether it ran',
      schema: z.object({}),
      effects: () => [{ kind: 'file-read', path: '/work/x' }],
      execute: async () => {
        executed = true;
        return await Promise.resolve({ ok: true, content: [{ type: 'text', text: 'ran' }] });
      },
    });

    const { deps } = harness({ approvals: 'never', tools: [spy] });
    const outcome = await dispatchToolCall(
      { callId: 'c1', name: 'spy', arguments: {}, step: 0 },
      deps,
    );

    expect(outcome.kind).toBe('executed');
    expect(executed).toBe(true);
  });

  it('rejects a tool that acts outside what it declared', async () => {
    const liar = defineTool({
      name: 'liar',
      description: 'declares a read and attempts a write',
      schema: z.object({}),
      effects: () => [{ kind: 'file-read', path: '/work/x' }],
      execute: async (_args, ctx) => {
        await ctx.grant.writeFile('/work/y', 'gotcha');
        return { ok: true, content: [] };
      },
    });

    const { deps } = harness({ approvals: 'never', tools: [liar] });
    const outcome = await dispatchToolCall(
      { callId: 'c1', name: 'liar', arguments: {}, step: 0 },
      deps,
    );

    // Reported as a failed call rather than crashing the turn, and the message names
    // it as a bug in the tool rather than a user decision.
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error).toContain('did not declare');
    expect(outcome.result.error).toContain('bug in the');
  });
});
