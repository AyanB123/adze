import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_FILENAME, parseModelRef, resolveConfig } from '../src/config.js';
import { ProviderConfigurationError } from '../src/errors.js';

/**
 * Every test passes an explicit `env`, `cwd`, and `home`.
 *
 * A resolution test that reads the real environment passes or fails depending on whose
 * machine it runs on, and one that reads a developer's own `~/.adze/providers.json`
 * would put a real key in a test fixture's blast radius.
 */
const NO_ENV: Record<string, string | undefined> = {};

let dir = '';
let home = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'adze-prov-cfg-'));
  home = await mkdtemp(join(tmpdir(), 'adze-prov-home-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function writeConfig(root: string, contents: string): Promise<void> {
  const path = join(root, CONFIG_FILENAME);
  await mkdir(join(root, '.adze'), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

function resolve(options: Parameters<typeof resolveConfig>[0] = {}) {
  return resolveConfig({ env: NO_ENV, cwd: dir, home, ...options });
}

describe('built-in providers', () => {
  it('lists both first-party providers with no configuration at all', () => {
    // A provider missing from the list is indistinguishable from one Adze does not
    // support, and that ambiguity is exactly why a user cannot tell which variable to
    // set. `doctor` needs to be able to say "anthropic: no key".
    const ids = resolve().providers.map((provider) => provider.id);

    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
  });

  it('does not invent an openai-compatible provider, which would have nowhere to send', () => {
    expect(resolve().providers.map((p) => p.id)).not.toContain('openai-compatible');
  });

  it('reports no key without failing, so models and doctor work on a bare machine', () => {
    const anthropic = resolve().providers.find((provider) => provider.id === 'anthropic');

    expect(anthropic?.apiKey).toBeUndefined();
    expect(anthropic?.apiKeySource).toBeUndefined();
    // The candidates are what the error message names later.
    expect(anthropic?.apiKeyEnvCandidates).toContain('ANTHROPIC_API_KEY');
  });
});

describe('credential resolution', () => {
  it('reads the vendor-standard variable so an existing environment just works', () => {
    const config = resolve({ env: { ANTHROPIC_API_KEY: 'sk-ant-api03-zzzzzzzzzzzzzzzz' } });
    const anthropic = config.providers.find((provider) => provider.id === 'anthropic');

    expect(anthropic?.apiKey).toBe('sk-ant-api03-zzzzzzzzzzzzzzzz');
    expect(anthropic?.apiKeySource).toBe('ANTHROPIC_API_KEY');
  });

  it('accepts an Adze-prefixed variable for a key separate from other tools', () => {
    const config = resolve({ env: { ADZE_OPENAI_API_KEY: 'sk-proj-aaaaaaaaaaaaaaaaaa' } });

    expect(config.providers.find((p) => p.id === 'openai')?.apiKeySource).toBe(
      'ADZE_OPENAI_API_KEY',
    );
  });

  it('prefers the vendor variable over the Adze one when both are set', () => {
    const config = resolve({
      env: { OPENAI_API_KEY: 'sk-vendor-000000000000', ADZE_OPENAI_API_KEY: 'sk-adze-1111111111' },
    });

    expect(config.providers.find((p) => p.id === 'openai')?.apiKeySource).toBe('OPENAI_API_KEY');
  });

  it('treats a blank variable as unset', () => {
    // An exported-but-empty variable is the shape a shell profile produces on a typo, and
    // sending an empty key produces a 401 rather than the actionable "no key" message.
    const config = resolve({ env: { ANTHROPIC_API_KEY: '   ' } });

    expect(config.providers.find((p) => p.id === 'anthropic')?.apiKey).toBeUndefined();
  });

  it('reads a named variable from the config file rather than a value', async () => {
    await writeConfig(
      dir,
      JSON.stringify({ providers: { anthropic: { apiKeyEnv: 'WORK_ANTHROPIC_KEY' } } }),
    );

    const config = resolve({ env: { WORK_ANTHROPIC_KEY: 'sk-ant-api03-work00000000' } });

    expect(config.providers.find((p) => p.id === 'anthropic')?.apiKey).toBe(
      'sk-ant-api03-work00000000',
    );
    expect(config.providers.find((p) => p.id === 'anthropic')?.apiKeySource).toBe(
      'WORK_ANTHROPIC_KEY',
    );
  });

  it('reports the config file as the source when a literal key is used', async () => {
    await writeConfig(
      dir,
      JSON.stringify({ providers: { anthropic: { apiKey: 'sk-ant-api03-inline0000' } } }),
    );

    const source = resolve().providers.find((p) => p.id === 'anthropic')?.apiKeySource;

    // Named rather than reported as "environment", so `doctor` can tell a user their key
    // is sitting in a file inside a git working tree.
    expect(source).toContain(CONFIG_FILENAME);
  });

  it('lets a named variable win over a literal key in the same entry', async () => {
    await writeConfig(
      dir,
      JSON.stringify({
        providers: {
          anthropic: { apiKeyEnv: 'PREFERRED_KEY', apiKey: 'sk-ant-api03-stale000000' },
        },
      }),
    );

    const config = resolve({ env: { PREFERRED_KEY: 'sk-ant-api03-fresh000000' } });

    expect(config.providers.find((p) => p.id === 'anthropic')?.apiKey).toBe(
      'sk-ant-api03-fresh000000',
    );
  });
});

describe('config file', () => {
  it('adds a provider for any OpenAI-compatible endpoint', async () => {
    await writeConfig(
      dir,
      JSON.stringify({
        providers: {
          local: {
            kind: 'openai-compatible',
            baseURL: 'http://localhost:11434/v1',
            defaultModel: 'qwen2.5-coder',
          },
        },
      }),
    );

    const local = resolve().providers.find((provider) => provider.id === 'local');

    expect(local?.kind).toBe('openai-compatible');
    expect(local?.baseURL).toBe('http://localhost:11434/v1');
    expect(local?.defaultModel).toBe('qwen2.5-coder');
  });

  it('lets a workspace file override a user-level one per key', async () => {
    await writeConfig(home, JSON.stringify({ providers: { openai: { maxRetries: 7 } } }));
    await writeConfig(dir, JSON.stringify({ providers: { openai: { maxRetries: 1 } } }));

    expect(resolve().providers.find((p) => p.id === 'openai')?.maxRetries).toBe(1);
  });

  it('keeps a user-level key the workspace file does not mention', async () => {
    await writeConfig(home, JSON.stringify({ providers: { openai: { maxRetries: 7 } } }));
    await writeConfig(dir, JSON.stringify({ providers: { openai: { defaultModel: 'gpt-5.4' } } }));

    const openai = resolve().providers.find((p) => p.id === 'openai');

    expect(openai?.maxRetries).toBe(7);
    expect(openai?.defaultModel).toBe('gpt-5.4');
  });

  it('records which files it read, for doctor', async () => {
    await writeConfig(dir, JSON.stringify({ providers: {} }));

    expect(resolve().sources).toHaveLength(1);
  });

  it('reports a malformed file with the syntax error rather than crashing', async () => {
    await writeConfig(dir, '{ "providers": ');

    expect(() => resolve()).toThrow(ProviderConfigurationError);
    expect(() => resolve()).toThrow(/not valid JSON/);
  });

  it('rejects an unknown key instead of ignoring it', async () => {
    // A silently-ignored typo is a configuration that does nothing and reports success.
    await writeConfig(dir, JSON.stringify({ providers: { openai: { apikey: 'oops' } } }));

    expect(() => resolve()).toThrow(/does not match the providers schema/);
  });

  it('refuses an entry whose id does not name a transport and has no kind', async () => {
    await writeConfig(
      dir,
      JSON.stringify({ providers: { openrouter: { baseURL: 'https://x/v1' } } }),
    );

    expect(() => resolve()).toThrow(/does not name a known transport/);
  });

  it('is skipped entirely when asked, so a developer config cannot leak into a test', () => {
    expect(resolve({ ignoreConfigFiles: true }).sources).toHaveLength(0);
  });
});

describe('environment overrides for base URL', () => {
  it('reads a vendor base URL override', () => {
    const config = resolve({ env: { ANTHROPIC_BASE_URL: 'https://proxy.internal/v1' } });

    expect(config.providers.find((p) => p.id === 'anthropic')?.baseURL).toBe(
      'https://proxy.internal/v1',
    );
  });

  it('lets an explicit config value win over the environment', async () => {
    await writeConfig(
      dir,
      JSON.stringify({ providers: { anthropic: { baseURL: 'https://from-file/v1' } } }),
    );

    const config = resolve({ env: { ANTHROPIC_BASE_URL: 'https://from-env/v1' } });

    expect(config.providers.find((p) => p.id === 'anthropic')?.baseURL).toBe(
      'https://from-file/v1',
    );
  });
});

describe('parseModelRef', () => {
  it('splits provider from model', () => {
    expect(parseModelRef('anthropic/claude-sonnet-4-5')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
  });

  it('keeps a slash inside the model id', () => {
    // OpenRouter ids carry a vendor prefix. Splitting on every slash truncates the model
    // to `meta-llama`, which resolves to nothing and reads as a spelling mistake.
    expect(parseModelRef('openrouter/meta-llama/llama-3.1-70b-instruct')).toEqual({
      provider: 'openrouter',
      model: 'meta-llama/llama-3.1-70b-instruct',
    });
  });

  it('refuses a bare model id rather than guessing a provider', () => {
    // The same id behind two providers is two endpoints, two keys, and two prices.
    // Guessing eventually charges someone on the wrong account.
    expect(() => parseModelRef('gpt-5.4')).toThrow(ProviderConfigurationError);
    expect(() => parseModelRef('gpt-5.4')).toThrow(/provider\/model/);
  });

  it('refuses a reference with an empty side', () => {
    expect(() => parseModelRef('/gpt-5.4')).toThrow(ProviderConfigurationError);
    expect(() => parseModelRef('openai/')).toThrow(ProviderConfigurationError);
  });
});
