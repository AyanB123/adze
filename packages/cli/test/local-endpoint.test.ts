/**
 * Regressions found by driving the CLI against a real local model endpoint.
 *
 * Every test here failed before its fix. They are grouped in one file because they share
 * one cause: the surface was only ever exercised through its test seams, and each seam
 * bypassed the code that was wrong. `runRun` always injected an approval reader, so the
 * real one's stream choice was never observed; `runModels` was only ever given providers
 * that had credentials, so the keyless branch was never taken; `doctor` had no provider
 * section to test at all.
 *
 * The endpoint that produced them was an OpenAI-compatible server on localhost with no
 * credential — the configuration ADR-0001's local-first promise is about, and the one no
 * existing test covered.
 */

import { PassThrough } from 'node:stream';
import type { ResolveOptions } from '@adze/providers';
import { describe, expect, it, vi } from 'vitest';
import { stdinReader } from '../src/agent/approval.js';
import { runDoctor, type ShellCheck } from '../src/commands/doctor.js';
import { runModels } from '../src/commands/models.js';
import { EXIT, type Io } from '../src/output.js';

function capture(): Io & { readonly stdout: () => string; readonly stderr: () => string } {
  let out = '';
  let err = '';
  return {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    stdout: () => out,
    stderr: () => err,
  };
}

/**
 * A keyless OpenAI-compatible endpoint on localhost.
 *
 * `env: {}` and `ignoreConfigFiles: true` are not optional: without them these assertions
 * would report whether the machine running them happens to export `OPENAI_API_KEY`.
 */
function localEndpoint(): ResolveOptions {
  return {
    env: {},
    ignoreConfigFiles: true,
    providers: {
      local: {
        kind: 'openai-compatible',
        baseURL: 'http://127.0.0.1:8790/v1',
        defaultModel: 'glm-5.2',
      },
    },
  };
}

describe('the approval prompt never touches stdout', () => {
  it('writes the prompt to stderr, so a --json event stream stays parseable', async () => {
    // The real defect: `writeJson` promises stdout carries the event stream "and nothing
    // else", and the prompt landed in the middle of whichever event the approval was
    // gating — always a `tool.started`. That line stopped being JSON, so a consumer lost
    // the one event describing the call it was being asked to approve.
    const input = new PassThrough();
    const outSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      const reader = stdinReader({ input });
      const answer = reader.read('  [y]es once, [n]o: ');
      input.write('y\n');
      expect(await answer).toBe('y');
      reader.close();

      const toStderr = errSpy.mock.calls.map((call) => String(call[0])).join('');
      const toStdout = outSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(toStderr).toContain('[y]es once');
      expect(toStdout).not.toContain('[y]es once');
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('still reads the answer when the prompt is not on stdout', async () => {
    // Guards the obvious way to "fix" the above: dropping the prompt entirely would pass
    // the stdout assertion and leave an interactive user staring at nothing.
    const input = new PassThrough();
    const output = new PassThrough();
    const seen: string[] = [];
    output.on('data', (chunk: Buffer) => seen.push(chunk.toString()));

    const reader = stdinReader({ input, output });
    const answer = reader.read('  choose: ');
    input.write('a\n');
    expect(await answer).toBe('a');
    reader.close();
    expect(seen.join('')).toContain('choose:');
  });

  it('answers a second approval from input that arrived in one chunk', async () => {
    // Found by driving a real run that needed two approvals with answers piped in. The
    // first was granted and the second was refused as "no input available" — while the
    // answer to it was sitting unread in the buffer.
    //
    // `rl.question()` registers a one-shot listener, but readline emits a `line` event for
    // every line in a chunk as soon as it arrives. So lines after the first were emitted
    // with nothing listening and dropped, the stream then ended, and the next `read` saw a
    // closed interface. Every answer after the first silently became a denial.
    //
    // This is not a niche path. Any non-TTY stdin delivers its lines in one chunk, so it
    // is the normal shape of a scripted run — and denial-by-losing-the-answer is
    // indistinguishable in the transcript from the user having typed "n".
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = stdinReader({ input, output });

    // Both answers in a single write, which is what a pipe does.
    input.write('y\na\n');

    expect(await reader.read('  first: ')).toBe('y');
    expect(await reader.read('  second: ')).toBe('a');
    reader.close();
  });

  it('reports end of input as end of input, once the buffer is genuinely empty', async () => {
    // The other half: draining the buffer must not turn a real EOF into a hang. `deny` on
    // end-of-stream is deliberate (see approval.ts), so this behaviour has to survive the
    // queueing fix rather than be traded away for it.
    const input = new PassThrough();
    const reader = stdinReader({ input, output: new PassThrough() });

    input.write('y\n');
    expect(await reader.read('  first: ')).toBe('y');

    const second = reader.read('  second: ');
    input.end();
    expect(await second).toBeUndefined();
    // A further read stays undefined rather than throwing or hanging.
    expect(await reader.read('  third: ')).toBeUndefined();
    reader.close();
  });
});

describe('adze models — a local endpoint needs no credential', () => {
  it('lists the model behind a keyless openai-compatible provider', async () => {
    // The bug: `rowsFor` skipped any provider without an `apiKey`, so a local llama.cpp,
    // Ollama, or gateway endpoint — none of which need one — vanished from the list along
    // with the model `defaultModel` names. `adze models` disagreed with what `adze run`
    // then used, which is the one thing the list exists to prevent.
    const io = capture();
    const code = await runModels({ __testHooks: { resolve: localEndpoint() } }, io);

    expect(code).toBe(EXIT.Ok);
    expect(io.stdout()).toContain('local/glm-5.2');
  });

  it('does not tell an openai-compatible endpoint to set a key it may not need', async () => {
    const io = capture();
    await runModels({ __testHooks: { resolve: localEndpoint() } }, io);
    const out = io.stdout();

    // Reported as optional rather than as unnecessary: the same transport is how a hosted
    // gateway is configured, and that one does need a credential.
    expect(out).toContain('optional for openai-compatible');
    // The first-party providers still get the instruction, because for them it is correct.
    expect(out).toMatch(/anthropic\s+no credential \(set ANTHROPIC_API_KEY/);
  });

  it('marks the keyless local provider as usable in --json', async () => {
    const io = capture();
    await runModels({ json: true, __testHooks: { resolve: localEndpoint() } }, io);

    const parsed = JSON.parse(io.stdout()) as {
      providers: readonly { id: string; usable: boolean; credentialConfigured: boolean }[];
      models: readonly { provider: string; model: string }[];
    };
    const local = parsed.providers.find((provider) => provider.id === 'local');
    expect(local?.usable).toBe(true);
    // Still reported truthfully as having no credential. Usable and credentialed are
    // different facts, and collapsing them is what caused the bug.
    expect(local?.credentialConfigured).toBe(false);
    expect(parsed.models).toContainEqual(
      expect.objectContaining({ provider: 'local', model: 'glm-5.2' }),
    );
  });
});

describe('adze doctor — reports model providers', () => {
  it('names the configured provider, its transport, and its endpoint', async () => {
    // `doctor` reported node, pnpm, git, ripgrep and the sandbox, and said nothing at all
    // about model providers — the one piece of configuration without which nothing works.
    const io = capture();
    const code = await runDoctor({ __testHooks: { resolve: localEndpoint() } }, io);
    const out = io.stdout();

    expect(code).toBe(EXIT.Ok);
    expect(out).toContain('Model providers');
    expect(out).toContain('local');
    expect(out).toContain('openai-compatible');
    expect(out).toContain('http://127.0.0.1:8790/v1');
    expect(out).toContain('glm-5.2');
  });

  it('says it did not probe, so "configured" is never read as "reachable"', async () => {
    const io = capture();
    await runDoctor({ __testHooks: { resolve: localEndpoint() } }, io);
    expect(io.stdout()).toContain('makes no network call');
  });

  it('warns when no provider is usable, without failing the command', async () => {
    // A warning, not a failure: `doctor`'s rule is that missing optional tooling still
    // exits 0, and tying the exit code to whether a key is exported would make it depend
    // on ambient state in CI.
    const io = capture();
    const code = await runDoctor(
      { __testHooks: { resolve: { env: {}, ignoreConfigFiles: true } } },
      io,
    );

    expect(code).toBe(EXIT.Ok);
    expect(io.stdout()).toContain('none usable');
    expect(io.stdout()).toContain('adze run` cannot reach a model');
  });

  it('reports a usable provider count when one is configured', async () => {
    const io = capture();
    await runDoctor({ __testHooks: { resolve: localEndpoint() } }, io);
    expect(io.stdout()).toMatch(/provider\s+1 usable \(local\)/);
  });

  it('survives a providers file it cannot parse, because that is why it was run', async () => {
    const io = capture();
    const code = await runDoctor(
      {
        __testHooks: {
          // A directory that cannot hold a valid file read is not reachable here, so the
          // malformed-config path is exercised through a provider entry with no transport,
          // which `resolveConfig` rejects by design.
          resolve: { env: {}, ignoreConfigFiles: true, providers: { mystery: {} } },
        },
      },
      io,
    );

    expect(code).toBe(EXIT.Ok);
    expect(io.stdout()).toContain('unreadable');
    expect(io.stdout()).toContain('does not name a known transport');
  });

  it('never prints a credential value, only the variable that supplied it', async () => {
    const io = capture();
    await runDoctor(
      {
        __testHooks: {
          resolve: {
            env: { ANTHROPIC_API_KEY: 'sk-ant-super-secret-value' },
            ignoreConfigFiles: true,
          },
        },
      },
      io,
    );

    expect(io.stdout()).toContain('ANTHROPIC_API_KEY');
    expect(io.stdout()).not.toContain('sk-ant-super-secret-value');
  });

  it('exposes providers in --json without probing and without the key', async () => {
    const io = capture();
    await runDoctor({ json: true, __testHooks: { resolve: localEndpoint() } }, io);

    const parsed = JSON.parse(io.stdout()) as {
      providers: {
        probed: boolean;
        defaultModel: string | null;
        entries: readonly {
          id: string;
          kind: string;
          usable: boolean;
          credentialSource: string | null;
          baseUrl: string | null;
        }[];
      };
    };

    expect(parsed.providers.probed).toBe(false);
    const local = parsed.providers.entries.find((entry) => entry.id === 'local');
    expect(local).toMatchObject({
      kind: 'openai-compatible',
      usable: true,
      credentialSource: null,
      baseUrl: 'http://127.0.0.1:8790/v1',
    });
  });
});

describe('adze doctor — reports whether the shell actually runs', () => {
  /** A `doctor` invocation with provider resolution pinned, so only the shell varies. */
  function withShell(probe: () => Promise<ShellCheck>) {
    return { __testHooks: { resolve: localEndpoint(), probeShell: probe } };
  }

  it('reports the shell as ok when it runs a command', async () => {
    const io = capture();
    const code = await runDoctor(
      withShell(async () => ({ ok: true, value: '/usr/bin/bash', detail: undefined })),
      io,
    );

    expect(code).toBe(EXIT.Ok);
    expect(io.stdout()).toMatch(/ok\s+shell\s+\/usr\/bin\/bash/);
  });

  it('warns when the shell resolves but cannot run a command', async () => {
    // The real case, found by a run that spent ten steps and ~50k tokens on a shell that
    // could never work. `bash.exe` on Windows is usually WSL's launcher; it exists whether
    // or not a healthy distribution sits behind it, and a broken one exits non-zero for
    // every command. `doctor` checked node, pnpm, git and ripgrep and never the shell, so
    // nothing in the tool said the workhorse tool was dead.
    const io = capture();
    const code = await runDoctor(
      withShell(async () => ({
        ok: false,
        value: 'found but cannot run a command (C:\\WINDOWS\\system32\\bash.exe)',
        detail: 'Failed to attach disk to WSL2: The system cannot find the file specified.',
      })),
      io,
    );

    // A warning, not a failure: doctor's rule for optional tooling, and the exit code must
    // not start depending on a machine's WSL health.
    expect(code).toBe(EXIT.Ok);
    const out = io.stdout();
    expect(out).toContain('cannot run a command');
    expect(out).toContain('bash -lc');
    // The shell's own words, because "bash is broken" is not actionable and a WSL mount
    // failure names the actual problem.
    expect(out).toContain('Failed to attach disk');
  });

  it('says bash is missing rather than broken when it is not installed', async () => {
    const io = capture();
    await runDoctor(
      withShell(async () => ({ ok: false, value: 'not found', detail: undefined })),
      io,
    );

    const out = io.stdout();
    expect(out).toMatch(/shell\s+not found/);
    expect(out).toContain('Install bash');
  });

  it('names the tools that still work, so a broken shell is not read as a dead agent', async () => {
    const io = capture();
    await runDoctor(
      withShell(async () => ({ ok: false, value: 'not found', detail: undefined })),
      io,
    );
    expect(io.stdout()).toContain('read, edit, glob, grep');
  });

  it('carries the shell result into --json', async () => {
    const io = capture();
    await runDoctor(
      {
        json: true,
        __testHooks: {
          resolve: localEndpoint(),
          probeShell: async () => ({ ok: false, value: 'not found', detail: undefined }),
        },
      },
      io,
    );

    const parsed = JSON.parse(io.stdout()) as {
      checks: readonly { name: string; ok: boolean; value: string }[];
    };
    expect(parsed.checks).toContainEqual(
      expect.objectContaining({ name: 'shell', ok: false, value: 'not found' }),
    );
  });
});
