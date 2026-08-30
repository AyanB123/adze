import { describe, expect, it } from 'vitest';
import { looksLikeCredential, scrubEnvironment } from '../src/env.js';

describe('scrubEnvironment', () => {
  it('removes credential-shaped names', () => {
    const env = scrubEnvironment({
      ANTHROPIC_API_KEY: 'sk-1',
      GITHUB_TOKEN: 'gh-1',
      AWS_SECRET_ACCESS_KEY: 'aws-1',
      DB_PASSWORD: 'hunter2',
      GOOGLE_APPLICATION_CREDENTIALS: '/path',
      HTTP_AUTH: 'basic',
      PATH: '/usr/bin',
    });
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  // Word-boundary anchored rather than substring matched. A substring match strips
  // enough harmless variables that users turn the feature off, and a feature that is
  // off protects nothing.
  it('keeps names that merely contain a keyword inside a word', () => {
    const env = scrubEnvironment({
      KEYCLOAK_URL: 'https://example.invalid',
      MONKEY_PATCH: '1',
      AUTHORS: 'ada',
      PASSWORDLESS: 'yes',
    });
    expect(Object.keys(env).sort()).toEqual([
      'AUTHORS',
      'KEYCLOAK_URL',
      'MONKEY_PATCH',
      'PASSWORDLESS',
    ]);
  });

  it('removes a bare KEY or TOKEN', () => {
    expect(scrubEnvironment({ KEY: 'x', TOKEN: 'y', SECRET: 'z' })).toEqual({});
  });

  it('is case-insensitive', () => {
    expect(scrubEnvironment({ api_key: 'x', Github_Token: 'y' })).toEqual({});
  });

  it('passes a name through when it is explicitly allowed', () => {
    const env = scrubEnvironment({ NPM_TOKEN: 'x', OTHER_TOKEN: 'y' }, { allow: ['NPM_TOKEN'] });
    expect(env).toEqual({ NPM_TOKEN: 'x' });
  });

  it('removes an explicitly denied name even when it looks harmless', () => {
    expect(scrubEnvironment({ HOME: '/home/ada' }, { deny: ['HOME'] })).toEqual({});
  });

  // The restrictive reading is the safe one, and it makes a copy-pasted config with an
  // overlap fail closed.
  it('lets deny beat allow', () => {
    expect(
      scrubEnvironment({ NPM_TOKEN: 'x' }, { allow: ['NPM_TOKEN'], deny: ['NPM_TOKEN'] }),
    ).toEqual({});
  });

  it('drops undefined values, which spawn would reject', () => {
    expect(scrubEnvironment({ A: undefined, B: 'b' })).toEqual({ B: 'b' });
  });

  it('preserves an empty string, which is a meaningful value', () => {
    expect(scrubEnvironment({ A: '' })).toEqual({ A: '' });
  });
});

describe('looksLikeCredential', () => {
  it('agrees with the scrubbing rule, so a surface can explain itself', () => {
    expect(looksLikeCredential('OPENAI_API_KEY')).toBe(true);
    expect(looksLikeCredential('KEYCLOAK_URL')).toBe(false);
  });
});
