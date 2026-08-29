import { describe, expect, it } from 'vitest';
import {
  type BaselineInputs,
  ContextAssembler,
  epochKey,
  fingerprintOf,
  renderBaseline,
} from '../src/context.js';
import type { ConversationMessage } from '../src/types.js';

function inputs(over: Partial<BaselineInputs> = {}): BaselineInputs {
  return {
    model: 'mock-2026-08-29',
    workspaceRoot: '/work/repo',
    sandboxMode: 'workspace-write',
    approvals: 'on-request',
    enforcement: 'gate-only',
    toolNames: ['bash', 'edit', 'read'],
    ...over,
  };
}

function userTurn(text: string): ConversationMessage {
  return { role: 'user', origin: 'user', content: [{ type: 'text', text }] };
}

describe('ContextAssembler — the baseline is byte-identical within an epoch', () => {
  it('produces the same prefix across many steps', () => {
    const assembler = new ContextAssembler(inputs());
    const history: ConversationMessage[] = [];
    const prefixes: string[] = [];

    // Ten steps, with the history growing each time. This is the invariant the whole
    // epoch design exists for: without it, provider caching never pays and effective
    // cost moves by more than 10×.
    for (let step = 0; step < 10; step += 1) {
      history.push(userTurn(`step ${step}`));
      assembler.reconcile(inputs());
      const assembled = assembler.assemble(history);
      prefixes.push(JSON.stringify(assembled.messages.slice(0, assembled.cachePrefixLength)));
    }

    expect(new Set(prefixes).size).toBe(1);
    expect(assembler.current.index).toBe(0);
  });

  it('keeps the same fingerprint and the same array identity', () => {
    const assembler = new ContextAssembler(inputs());
    const first = assembler.assemble([]);
    const second = assembler.assemble([userTurn('x')]);
    expect(second.epoch.fingerprint).toBe(first.epoch.fingerprint);
    // Identity as well as bytes: rebuilding an identical array each call would be
    // byte-stable and would make an epoch roll invisible in a debugger.
    expect(second.epoch.baseline).toBe(first.epoch.baseline);
  });

  it('puts nothing volatile in the prefix', () => {
    // Two assemblers built a measurable interval apart. Any timestamp, pid, random id,
    // or directory listing in the baseline breaks this.
    const a = new ContextAssembler(inputs());
    const b = new ContextAssembler(inputs());
    expect(a.current.fingerprint).toBe(b.current.fingerprint);
    const text = a.current.baseline
      .flatMap((m) => m.content)
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).not.toMatch(/\b1[6-9]\d{11}\b/);
  });

  it('reports the prefix length so a provider can place a cache breakpoint', () => {
    const assembler = new ContextAssembler(inputs());
    const assembled = assembler.assemble([userTurn('a'), userTurn('b')]);
    expect(assembled.cachePrefixLength).toBe(assembler.current.baseline.length);
    expect(assembled.messages).toHaveLength(assembled.cachePrefixLength + 2);
  });
});

describe('ContextAssembler — a structural change rolls the epoch', () => {
  it('rolls on a model switch and names it', () => {
    const assembler = new ContextAssembler(inputs());
    const rolled = assembler.reconcile(inputs({ model: 'other-2026-08-29' }));
    expect(rolled?.index).toBe(1);
    expect(rolled?.reason).toBe('model-switch');
  });

  it('rolls on a sandbox mode change', () => {
    const assembler = new ContextAssembler(inputs());
    const rolled = assembler.reconcile(inputs({ sandboxMode: 'read-only' }));
    expect(rolled?.reason).toBe('permission-change');
  });

  it('rolls on an approval policy change', () => {
    const assembler = new ContextAssembler(inputs());
    expect(assembler.reconcile(inputs({ approvals: 'never' }))?.reason).toBe('permission-change');
  });

  it('rolls when containment changes, since the instructions differ', () => {
    const assembler = new ContextAssembler(inputs());
    expect(assembler.reconcile(inputs({ enforcement: 'os-level' }))?.reason).toBe(
      'permission-change',
    );
  });

  it('rolls on a tool-set change, because tools are part of the cached prefix', () => {
    const assembler = new ContextAssembler(inputs());
    const rolled = assembler.reconcile(inputs({ toolNames: ['bash'] }));
    expect(rolled?.reason).toBe('tool-set-change');
  });

  it('rolls on an instructions change', () => {
    const assembler = new ContextAssembler(inputs());
    expect(assembler.reconcile(inputs({ instructions: 'be terse' }))?.reason).toBe(
      'instructions-change',
    );
  });

  it('does not roll when tool names arrive in a different order', () => {
    // Registry iteration order must not be able to cost a full cache prefix.
    const assembler = new ContextAssembler(inputs({ toolNames: ['bash', 'edit', 'read'] }));
    expect(assembler.reconcile(inputs({ toolNames: ['read', 'bash', 'edit'] }))).toBeUndefined();
  });

  it('does not roll when nothing structural changed', () => {
    const assembler = new ContextAssembler(inputs());
    expect(assembler.reconcile(inputs())).toBeUndefined();
    expect(assembler.current.index).toBe(0);
  });

  it('rolls unconditionally for compaction', () => {
    const assembler = new ContextAssembler(inputs());
    const rolled = assembler.roll(inputs(), 'compaction');
    expect(rolled.index).toBe(1);
    expect(rolled.reason).toBe('compaction');
    // Same key, new epoch: compaction replaced the history behind the prefix, so the
    // provider's cache entry for it is gone regardless of what the prefix says.
    expect(rolled.key).toBe(epochKey(inputs()));
  });
});

describe('epochKey', () => {
  it('changes for every structural field', () => {
    const base = epochKey(inputs());
    const variants: BaselineInputs[] = [
      inputs({ model: 'x' }),
      inputs({ workspaceRoot: '/other' }),
      inputs({ sandboxMode: 'full-access' }),
      inputs({ approvals: 'untrusted' }),
      inputs({ enforcement: 'os-level' }),
      inputs({ instructions: 'hi' }),
      inputs({ toolNames: [] }),
    ];
    for (const variant of variants) {
      expect(epochKey(variant)).not.toBe(base);
    }
  });

  it('hashes instructions rather than embedding them', () => {
    // A key is compared and logged; embedding a whole AGENTS.md would make both
    // unwieldy and would put project content in a diagnostic field.
    const key = epochKey(inputs({ instructions: 'a'.repeat(5_000) }));
    expect(key.length).toBeLessThan(500);
  });
});

describe('renderBaseline', () => {
  it('states the mode, policy, and containment', () => {
    const text = textOf(renderBaseline(inputs({ sandboxMode: 'read-only' })));
    expect(text).toContain('sandbox_mode: read-only');
    expect(text).toContain('approval_policy: on-request');
    expect(text).toContain('containment: gate-only');
  });

  it('says plainly when there is no OS-level containment', () => {
    const text = textOf(renderBaseline(inputs({ enforcement: 'gate-only' })));
    expect(text).toContain('no OS-level containment');
  });

  it('omits the containment caveat when containment exists', () => {
    const text = textOf(renderBaseline(inputs({ enforcement: 'os-level' })));
    expect(text).not.toContain('no OS-level containment');
  });

  it('carries no terminal escapes or HTML', () => {
    // The engine renders nothing. A system prompt is model-facing, which is different
    // from display-facing, and this is where that line is checked.
    const text = textOf(renderBaseline(inputs()));
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the absence of an ANSI escape requires naming it
    expect(text).not.toMatch(/\u001b\[/);
    expect(text).not.toMatch(/<\/?[a-z]+>/i);
  });

  it('appends project instructions when present', () => {
    const text = textOf(renderBaseline(inputs({ instructions: '  use tabs  ' })));
    expect(text).toContain('Project instructions:');
    expect(text).toContain('use tabs');
  });

  it('ignores whitespace-only instructions', () => {
    const text = textOf(renderBaseline(inputs({ instructions: '   \n  ' })));
    expect(text).not.toContain('Project instructions:');
  });
});

describe('fingerprintOf', () => {
  it('changes when message content changes', () => {
    const a = fingerprintOf([userTurn('one')]);
    const b = fingerprintOf([userTurn('two')]);
    expect(a).not.toBe(b);
  });

  it('is stable for identical content', () => {
    expect(fingerprintOf([userTurn('same')])).toBe(fingerprintOf([userTurn('same')]));
  });
});

function textOf(messages: readonly ConversationMessage[]): string {
  return messages
    .flatMap((message) => message.content)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}
