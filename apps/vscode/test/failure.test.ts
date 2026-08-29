import { ProviderConfigurationError, ProviderRequestError } from '@adze/providers';
import { describe, expect, it } from 'vitest';
import { describeFailure, formatNotice } from '../src/failure.js';

describe('describeFailure', () => {
  it('names the environment variable when no credential is configured', () => {
    // The one error a new user is guaranteed to hit. Naming the variable is the
    // difference between a two-second fix and a search engine.
    const error = new ProviderConfigurationError('No API key for anthropic.', {
      hints: ['$env:ANTHROPIC_API_KEY = "sk-..."', 'export ANTHROPIC_API_KEY=sk-...'],
    });
    const notice = describeFailure(error);
    expect(notice.kind).toBe('configuration');
    expect(notice.message).toBe('No API key for anthropic.');
    expect(notice.hints.join('\n')).toContain('ANTHROPIC_API_KEY');
  });

  it('passes a request failure through with the advice the gateway composed', () => {
    const error = new ProviderRequestError({
      message: 'rate limited; lower concurrency and retry',
      kind: 'rate-limit',
      provider: 'anthropic',
      model: 'claude-x',
    });
    const notice = describeFailure(error);
    expect(notice.kind).toBe('request');
    expect(notice.hints.join('\n')).toContain('rate limited');
  });

  it('reports an unexpected error by message, never by stack', () => {
    const error = new Error('something broke');
    error.stack = 'Error: something broke\n    at secret/path/file.ts:1:1';
    const notice = describeFailure(error);
    expect(notice.kind).toBe('unexpected');
    expect(notice.message).toBe('something broke');
    const rendered = formatNotice(notice);
    expect(rendered).not.toContain('at secret/path');
    expect(rendered).toContain('https://github.com/AyanB123/adze/issues');
    // A stack trace is a request for the user to debug Adze.
    expect(rendered).not.toContain('    at ');
  });

  it('handles a thrown non-error without crashing', () => {
    const notice = describeFailure('plain string failure');
    expect(notice.message).toBe('plain string failure');
  });

  it('never asks the user to paste a key into an issue', () => {
    expect(formatNotice(describeFailure(new Error('x')))).toContain('Do not include your API key');
  });
});

describe('formatNotice', () => {
  it('returns just the message when there are no hints', () => {
    expect(formatNotice({ kind: 'configuration', message: 'only this', hints: [] })).toBe(
      'only this',
    );
  });
});
