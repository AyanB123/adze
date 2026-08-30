/**
 * Tests for `adze run`, `adze chat`, and `adze models`.
 *
 * **No network, no API key, no spend.** Every test that touches provider resolution passes
 * `resolve: { env: {}, ignoreConfigFiles: true }`, which is not a convenience: without it
 * `createGateway` reads the real `process.env` and the developer's own
 * `~/.adze/providers.json`, so the no-credential assertions below would pass or fail
 * depending on whether the machine running them happens to export `OPENAI_API_KEY`. A test
 * that reports the environment instead of the code is worse than no test, because it is
 * trusted.
 *
 * These tests deliberately stop at the point a model would be called. Driving a full turn
 * needs the AI SDK's mock model, and `@adze/cli` does not depend on `ai` — adding a
 * dependency to the shipped package for the sake of a test would be the wrong trade. The
 * turn machine itself is covered in `@adze/core`, and the gateway against a mock model in
 * `@adze/providers`. What is unique to this package, and therefore what is tested here, is
 * the flag contract, the approval channel, the failure rendering, and the summary.
 */

import type { AdzeEvent, ApprovalRequest, Usage } from '@adze/protocol';
import { describe, expect, it } from 'vitest';
import {
  decisionFor,
  denyingChannel,
  type LineReader,
  promptingChannel,
} from '../src/agent/approval.js';
import {
  parseAgentFlags,
  parseApprovalPolicy,
  parseBudget,
  parseCommandRules,
  parseSandboxMode,
  UsageError,
} from '../src/agent/flags.js';
import { EventRenderer } from '../src/agent/render.js';
import { renderSummary, summaryJson } from '../src/agent/summary.js';
import { runChat } from '../src/commands/chat.js';
import { runModels } from '../src/commands/models.js';
import { runRun } from '../src/commands/run.js';
import { EXIT, type Io, plainStyle, writeJson, writeJsonLine } from '../src/output.js';

function capture(): Io & { readonly stdout: () => string; readonly stderr: () => string } {
  let out = '';
  let err = '';
  return {
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    stdout: () => out,
    stderr: () => err,
  };
}

/** Provider resolution with nothing configured, independent of the real machine. */
const NO_CREDENTIALS = { env: {}, ignoreConfigFiles: true } as const;

/** A reader that would answer yes, so a test can prove it was never consulted. */
function consentingReader(): LineReader & { readonly reads: () => number } {
  let reads = 0;
  return {
    read: async () => {
      reads += 1;
      return 'y';
    },
    close: () => undefined,
    reads: () => reads,
  };
}

function approvalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: 'appr-1',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    kind: 'command',
    summary: 'run `rm -rf /`',
    reason: 'the sandbox would block this',
    ...overrides,
  } as ApprovalRequest;
}

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 1000,
    cachedInputTokens: 3000,
    outputTokens: 500,
    cacheHitRate: 0.75,
    ...overrides,
  } as Usage;
}

describe('adze run — configuration failures', () => {
  it('names the environment variable when no provider is configured, without a stack trace', async () => {
    const io = capture();

    const code = await runRun('hello', { __testHooks: { resolve: NO_CREDENTIALS } }, io);

    // A configuration problem is a usage error, not a failure: a script can then tell
    // "fix your setup" from "the agent could not finish the task".
    expect(code).toBe(EXIT.Usage);
    const err = io.stderr();
    expect(err).toContain('no model provider is configured');
    // The single highest-value error message in the CLI is the one naming the variable.
    expect(err).toContain('ANTHROPIC_API_KEY');
    expect(err).toContain('OPENAI_API_KEY');
    // And it shows how to set it on this shell, not just which name to use.
    expect(err).toContain('$env:ANTHROPIC_API_KEY');
    expect(err).toContain('adze doctor');
    // Never a stack trace. `at ` with a paren is the shape of a V8 frame.
    expect(err).not.toMatch(/\n\s+at .+\(/);
    expect(err).not.toContain('node:internal');
  });

  it('refuses a missing prompt and points at chat', async () => {
    const io = capture();
    const code = await runRun(undefined, {}, io);
    expect(code).toBe(EXIT.Usage);
    expect(io.stderr()).toContain('needs a prompt');
    expect(io.stderr()).toContain('adze chat');
  });

  it('refuses a whitespace-only prompt rather than sending it', async () => {
    const io = capture();
    expect(await runRun('   ', {}, io)).toBe(EXIT.Usage);
  });

  it('reports a bad flag before it reaches the provider', async () => {
    const io = capture();

    // No `resolve` hook on purpose: this must fail at parse time, so it cannot depend on
    // whether a credential exists.
    const code = await runRun('hello', { sandbox: 'read-onyl' }, io);

    expect(code).toBe(EXIT.Usage);
    expect(io.stderr()).toContain("--sandbox 'read-onyl' is not a sandbox mode");
    expect(io.stderr()).not.toContain('workspace-write is now in force');
  });

  it('reports an unconfigured provider named by --model, mentioning the flag', async () => {
    const io = capture();

    const code = await runRun(
      'hello',
      { model: 'nonesuch/some-model', __testHooks: { resolve: NO_CREDENTIALS } },
      io,
    );

    expect(code).toBe(EXIT.Usage);
    expect(io.stderr()).toContain('which is not configured');
    expect(io.stderr()).toContain('nonesuch');
  });
});

describe('adze chat — configuration failures', () => {
  it('renders the same no-credential message as run', async () => {
    const io = capture();

    const code = await runChat({ __testHooks: { resolve: NO_CREDENTIALS } }, io);

    expect(code).toBe(EXIT.Usage);
    // The one error every new user hits must read identically wherever they hit it.
    expect(io.stderr()).toContain('no model provider is configured');
    expect(io.stderr()).toContain('ANTHROPIC_API_KEY');
    expect(io.stderr()).not.toMatch(/\n\s+at .+\(/);
  });

  it('reports a bad flag without opening a session', async () => {
    const io = capture();
    const code = await runChat({ approval: 'sometimes' }, io);
    expect(code).toBe(EXIT.Usage);
    expect(io.stderr()).toContain("--approval 'sometimes' is not an approval policy");
  });
});

describe('--approval never refuses rather than escalating (ADR-0007)', () => {
  it('denies every request and never consults the reader', async () => {
    const channel = denyingChannel('the approval policy is never');

    const response = await channel.request(approvalRequest());

    expect(response.decision).toBe('deny');
    expect(response.requestId).toBe('appr-1');
    expect(response.note).toContain('never');
    expect(channel.count()).toBe(1);
  });

  it('denies a second, different request too — there is no allow-session escape', async () => {
    const channel = denyingChannel('never');
    await channel.request(approvalRequest({ requestId: 'appr-1' }));
    const second = await channel.request(approvalRequest({ requestId: 'appr-2' }));
    expect(second.decision).toBe('deny');
    expect(channel.count()).toBe(2);
  });

  it('is the channel a never-policy run gets, proven by the reader going unread', async () => {
    const io = capture();
    const reader = consentingReader();

    // The run cannot get as far as a tool call with no credentials, so what this asserts is
    // narrow and deliberate: a `never` run wires up a channel that cannot consent, and the
    // consenting reader supplied here is never touched.
    await runRun(
      'hello',
      { approval: 'never', __testHooks: { resolve: NO_CREDENTIALS, reader } },
      io,
    );

    expect(reader.reads()).toBe(0);
  });
});

describe('the prompting channel', () => {
  it('treats end of input as a denial, not as consent and not as a hang', async () => {
    const io = capture();
    const channel = promptingChannel({
      io,
      style: plainStyle,
      reader: { read: async () => undefined, close: () => undefined },
      enforcement: 'gate-only',
    });

    const response = await channel.request(approvalRequest());

    // Failing open here would make a non-interactive run the most permissive way to invoke
    // the tool, which is exactly backwards.
    expect(response.decision).toBe('deny');
    expect(response.note).toContain('stdin closed');
    expect(io.stderr()).toContain('no input available');
  });

  it('says there is no containment when enforcement is gate-only, once', async () => {
    const io = capture();
    const channel = promptingChannel({
      io,
      style: plainStyle,
      reader: { read: async () => 'y', close: () => undefined },
      enforcement: 'gate-only',
    });

    await channel.request(approvalRequest({ requestId: 'a' }));
    await channel.request(approvalRequest({ requestId: 'b' }));

    const occurrences = io.stderr().split('no OS-level sandbox').length - 1;
    // Once per turn. Repeating it on every prompt is how it stops being read.
    expect(occurrences).toBe(1);
  });

  it('does not claim there is no containment when the OS provides it', async () => {
    const io = capture();
    const channel = promptingChannel({
      io,
      style: plainStyle,
      reader: { read: async () => 'y', close: () => undefined },
      enforcement: 'os-level',
    });

    await channel.request(approvalRequest());

    expect(io.stderr()).not.toContain('no OS-level sandbox');
  });

  it.each([
    ['y', 'allow-once'],
    ['yes', 'allow-once'],
    ['a', 'allow-session'],
    ['always', 'allow-session'],
    ['q', 'abort'],
    ['n', 'deny'],
    ['', 'deny'],
    ['maybe', 'deny'],
    ['Y ', 'allow-once'],
  ])('maps %o to %s', (answer, expected) => {
    expect(decisionFor(answer)).toBe(expected);
  });

  it('treats an unrecognised answer as a denial rather than re-prompting', () => {
    // Looping until an accepted letter is typed is how a prompt gets answered by muscle
    // memory, which ADR-0007 names as worse than not prompting at all.
    expect(decisionFor('sure why not')).toBe('deny');
    expect(decisionFor(undefined)).toBe('deny');
  });
});

describe('flag parsing refuses rather than falling back', () => {
  it('accepts the three sandbox modes', () => {
    expect(parseSandboxMode('read-only')).toBe('read-only');
    expect(parseSandboxMode('workspace-write')).toBe('workspace-write');
    expect(parseSandboxMode('full-access')).toBe('full-access');
  });

  it('defaults to workspace-write only when the flag is absent', () => {
    expect(parseSandboxMode(undefined)).toBe('workspace-write');
  });

  it('throws on a typo instead of silently granting more than was asked', () => {
    // A typo becoming `workspace-write` would grant more than the user asked for, and it
    // would be invisible.
    expect(() => parseSandboxMode('read-onyl')).toThrow(UsageError);
  });

  it('throws on an unknown approval policy', () => {
    expect(() => parseApprovalPolicy('yolo')).toThrow(UsageError);
    expect(parseApprovalPolicy(undefined)).toBe('on-request');
    expect(parseApprovalPolicy('never')).toBe('never');
  });

  it('rejects a non-positive or fractional budget', () => {
    expect(() => parseBudget({ maxSteps: '0' })).toThrow(UsageError);
    expect(() => parseBudget({ maxSteps: '-1' })).toThrow(UsageError);
    expect(() => parseBudget({ maxSteps: '1.5' })).toThrow(UsageError);
    expect(() => parseBudget({ maxTokens: 'lots' })).toThrow(UsageError);
    expect(() => parseBudget({ maxSpend: '-0.5' })).toThrow(UsageError);
  });

  it('converts --max-time from seconds to milliseconds', () => {
    expect(parseBudget({ maxTime: '1.5' }).maxWallClockMs).toBe(1500);
  });

  it('omits a budget that was not given rather than defaulting it to zero', () => {
    const budget = parseBudget({ maxSteps: '5' });
    expect(budget.maxSteps).toBe(5);
    // A zero ceiling would stop the turn immediately; absent means unbounded.
    expect('maxTokens' in budget).toBe(false);
    expect('maxWallClockMs' in budget).toBe(false);
    expect('maxSpendUsd' in budget).toBe(false);
  });

  it('turns --allow and --forbid into command rules, preserving the distinction', () => {
    const rules = parseCommandRules({ allow: ['pnpm test'], forbid: ['git push'] });
    expect(rules).toEqual([
      { prefix: 'pnpm test', action: 'allow' },
      { prefix: 'git push', action: 'forbid' },
    ]);
  });

  it('rejects an empty command prefix', () => {
    expect(() => parseCommandRules({ allow: ['  '] })).toThrow(UsageError);
  });

  it('rejects a temperature outside 0..2', () => {
    expect(() => parseAgentFlags({ temperature: '3' }, '/tmp')).toThrow(UsageError);
    expect(parseAgentFlags({ temperature: '0.7' }, '/tmp').temperature).toBe(0.7);
  });

  it('rejects an effort level no provider defines', () => {
    expect(() => parseAgentFlags({ effort: 'extreme' }, '/tmp')).toThrow(UsageError);
    expect(parseAgentFlags({ effort: 'high' }, '/tmp').effort).toBe('high');
  });

  it('uses --cwd as the workspace root when given, and the supplied cwd otherwise', () => {
    expect(parseAgentFlags({ cwd: '/elsewhere' }, '/here').workspaceRoot).toBe('/elsewhere');
    expect(parseAgentFlags({}, '/here').workspaceRoot).toBe('/here');
  });
});

describe('the run summary', () => {
  it('reports the token split and the cache hit rate, not a single total', () => {
    const io = capture();

    renderSummary(
      {
        model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
        stopReason: 'end-turn',
        steps: 3,
        usage: usage(),
        prices: { inputPerMTok: 3, cachedInputPerMTok: 0.3, outputPerMTok: 15, currency: 'USD' },
        durationMs: 4200,
        approvals: 0,
        droppedEvents: 0,
      },
      io,
      plainStyle,
    );

    const out = io.stderr();
    // Cache economics move effective cost by more than 10×, so the split and the hit rate
    // are what make the cost figure below verifiable.
    expect(out).toContain('input (full rate)');
    expect(out).toContain('input (cached)');
    expect(out).toContain('cache hit rate');
    expect(out).toContain('75.0%');
    expect(out).toContain('4,500');
  });

  it('reports cost as unknown for an unpriced model, never as zero', () => {
    const io = capture();

    renderSummary(
      {
        model: { provider: 'local', model: 'qwen2.5-coder' },
        stopReason: 'end-turn',
        steps: 1,
        usage: usage(),
        prices: undefined,
        durationMs: 10,
        approvals: 0,
        droppedEvents: 0,
      },
      io,
      plainStyle,
    );

    // Every local endpoint is unpriced. Printing zero would read as free.
    expect(io.stderr()).toContain('unknown');
    expect(io.stderr()).not.toContain('0.000000 USD');
    expect(io.stderr()).toContain('catalog.json');
  });

  it('distinguishes no rates from a zero cost in the JSON form', () => {
    const unpriced = summaryJson({
      model: { provider: 'local', model: 'q' },
      stopReason: 'end-turn',
      steps: 1,
      usage: usage(),
      prices: undefined,
      durationMs: 1,
      approvals: 0,
      droppedEvents: 0,
    });

    // Explicitly null rather than absent, so a consumer can tell the two apart.
    expect(unpriced.cost).toBeNull();
    expect(unpriced.costKnown).toBe(false);
  });

  it('says so when events were dropped, rather than smoothing over the gap', () => {
    const io = capture();

    renderSummary(
      {
        model: { provider: 'anthropic', model: 'm' },
        stopReason: 'end-turn',
        steps: 1,
        usage: usage(),
        prices: undefined,
        durationMs: 1,
        approvals: 0,
        droppedEvents: 2,
      },
      io,
      plainStyle,
    );

    expect(io.stderr()).toContain('2 event(s) were dropped');
    expect(io.stderr()).toContain('incomplete');
  });
});

describe('the event renderer', () => {
  function event(overrides: Partial<AdzeEvent> & { type: string }): AdzeEvent {
    return { sessionId: 's', turnId: 't', seq: 0, ...overrides } as AdzeEvent;
  }

  it('emits one JSON document per line in --json mode, verbatim', () => {
    const io = capture();
    const renderer = new EventRenderer({ io, style: plainStyle, json: true, quiet: false });

    renderer.sink(event({ type: 'text.delta', text: 'hello' }));
    renderer.sink(event({ type: 'text.delta', text: 'world', seq: 1 }));

    const lines = io.stdout().trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ type: 'text.delta', text: 'hello' });
  });

  it('counts a sequence gap rather than hiding it', () => {
    const io = capture();
    const renderer = new EventRenderer({ io, style: plainStyle, json: true, quiet: false });

    renderer.sink(event({ type: 'text.delta', text: 'a', seq: 0 }));
    // seq 1 never arrives.
    renderer.sink(event({ type: 'text.delta', text: 'c', seq: 2 }));

    expect(renderer.droppedEvents).toBe(1);
  });

  it('keeps the run summary on one line, so the JSONL stream stays parseable', () => {
    // Found driving a real model. `run --json` streams one event per line and then wrote
    // the summary with the indented writer, so the final document spanned about twenty
    // lines. A consumer parsing line by line — the documented consumer, and the only one
    // the format is for — hit twenty parse errors at exactly the point it would read the
    // result. Measured on a real run: 20 of 31 stdout lines were unparseable.
    //
    // The renderer was already tested in isolation and the summary was not on the same
    // stream in any test, which is how a contract stated in two files went unenforced.
    const io = capture();
    const renderer = new EventRenderer({ io, style: plainStyle, json: true, quiet: false });

    renderer.sink(event({ type: 'text.delta', text: 'hello' }));
    writeJsonLine(
      io,
      summaryJson({
        model: { provider: 'openrouter', model: 'vendor/some-model:free' },
        stopReason: 'end-turn',
        steps: 2,
        usage: usage(),
        prices: undefined,
        durationMs: 25_181,
        approvals: 0,
        droppedEvents: 0,
      }),
    );

    const lines = io.stdout().trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ stopReason: 'end-turn', steps: 2 });
  });

  it('distinguishes the streaming writer from the single-document one', () => {
    // The guard for the bug above: `writeJson` is for a command that emits one document
    // and exits, and its indented form is unusable on a JSONL stream. Asserting both
    // shapes here is what makes a swap back to the indented writer fail a test rather
    // than silently break every line-oriented consumer.
    const streamed = capture();
    const single = capture();
    const document = { stopReason: 'end-turn', steps: 2 };

    writeJsonLine(streamed, document);
    writeJson(single, document);

    expect(streamed.stdout().trimEnd().split('\n')).toHaveLength(1);
    expect(single.stdout().trimEnd().split('\n').length).toBeGreaterThan(1);
  });
  it('never suppresses a denial under --quiet', () => {
    const io = capture();
    const renderer = new EventRenderer({ io, style: plainStyle, json: false, quiet: true });

    renderer.sink(
      event({ type: 'tool.denied', name: 'bash', source: 'gate', reason: 'not allowed' }),
    );

    // A denial changes what the agent did; hiding it makes the transcript describe a run
    // that did not happen.
    expect(io.stderr()).toContain('denied');
    expect(io.stderr()).toContain('not allowed');
  });

  it('suppresses tool progress under --quiet but keeps assistant text', () => {
    const io = capture();
    const renderer = new EventRenderer({ io, style: plainStyle, json: false, quiet: true });

    renderer.sink(
      event({
        type: 'tool.started',
        call: { callId: 'c1', name: 'read', arguments: { path: 'a.ts' } },
      }),
    );
    renderer.sink(event({ type: 'text.delta', text: 'thinking', seq: 1 }));

    expect(io.stderr()).not.toContain('read');
    expect(io.stdout()).toContain('thinking');
  });

  it('reports a turn.started warning immediately, not behind a verbose flag', () => {
    const io = capture();
    const renderer = new EventRenderer({ io, style: plainStyle, json: false, quiet: true });

    renderer.sink(
      event({
        type: 'turn.started',
        warnings: [
          {
            code: 'no-os-sandbox',
            message: 'no OS-level containment on win32',
            reference: 'docs/architecture/adr/0007-sandbox-and-permissions.md',
          },
        ],
      }),
    );

    // A warning the user has to opt into seeing is a warning that does not exist.
    expect(io.stderr()).toContain('no-os-sandbox');
    expect(io.stderr()).toContain('0007-sandbox-and-permissions.md');
  });
});

describe('adze models', () => {
  it('works with no credentials at all and makes no network call', async () => {
    const io = capture();

    const code = await runModels({ __testHooks: { resolve: NO_CREDENTIALS } }, io);

    expect(code).toBe(EXIT.Ok);
    // It reports what is configured, not what is reachable.
    expect(io.stdout()).toContain('Providers');
    expect(io.stdout()).toContain('no credential');
    expect(io.stdout()).toContain('ANTHROPIC_API_KEY');
  });

  it('lists the catalog under --all even when nothing is configured', async () => {
    const io = capture();

    const code = await runModels({ all: true, __testHooks: { resolve: NO_CREDENTIALS } }, io);

    expect(code).toBe(EXIT.Ok);
    expect(io.stdout()).toContain('anthropic/');
    expect(io.stdout()).toContain('provider unconfigured');
  });

  it('reports whether a credential resolved and from which name, never its value', async () => {
    const io = capture();

    const code = await runModels(
      {
        json: true,
        __testHooks: {
          resolve: { env: { ANTHROPIC_API_KEY: 'sk-ant-SECRETVALUE' }, ignoreConfigFiles: true },
        },
      },
      io,
    );

    expect(code).toBe(EXIT.Ok);
    const report = io.stdout();
    expect(report).toContain('"credentialSource": "ANTHROPIC_API_KEY"');
    expect(report).toContain('"credentialConfigured": true');
    // The name is useful; the value never is.
    expect(report).not.toContain('SECRETVALUE');
  });

  it('surfaces the price table\u2019s own stated gaps', async () => {
    const io = capture();
    await runModels({ __testHooks: { resolve: NO_CREDENTIALS } }, io);
    expect(io.stdout()).toContain('Not modelled by the price table');
  });
});
