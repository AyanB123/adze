/**
 * Shared setup for the SDK suite.
 *
 * Two things every test here needs, and both are deliberate.
 *
 * `commandExecution: 'disabled'` means no test in this package can start a
 * subprocess. That also makes the approval tests platform-independent: the null
 * broker reports `gate-only` enforcement for every containment mode, so a `bash`
 * call needs approval on Windows, macOS, and Linux alike. With the subprocess
 * broker the answer would still be `gate-only` today, but it is the broker's answer
 * rather than a fixture's, and a suite whose approval assertions depend on which
 * broker is wired in is a suite that will start failing when `@adze/sandbox` lands.
 *
 * The scripted provider means zero network and zero cost, which is what lets these
 * assertions run on every pull request instead of by hand.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdzeClient, AdzeClientOptions, AdzeEvent, ScriptedStep } from '../src/index.js';
import { createClient, scriptedProvider } from '../src/index.js';

/** Absolute, and never written to: no test in this package touches the disk. */
export const WORKSPACE = join(tmpdir(), 'adze-sdk-test-workspace');

export const PRICES = {
  currency: 'USD',
  inputPerMTok: 3,
  cachedInputPerMTok: 0.3,
  outputPerMTok: 15,
} as const;

export interface HarnessOptions extends Partial<Omit<AdzeClientOptions, 'provider'>> {
  readonly script: readonly ScriptedStep[];
  readonly withPrices?: boolean;
}

export interface Harness {
  readonly client: AdzeClient;
  readonly events: AdzeEvent[];
  readonly stop: () => void;
}

export function harness(options: HarnessOptions): Harness {
  const { script, withPrices, ...rest } = options;
  const client = createClient({
    workspaceRoot: WORKSPACE,
    model: { provider: 'scripted', model: 'offline-2026-08-29' },
    commandExecution: 'disabled',
    provider: scriptedProvider({
      script,
      ...(withPrices === true ? { prices: PRICES } : {}),
    }),
    ...rest,
  });

  const events: AdzeEvent[] = [];
  const stop = client.subscribe((event) => events.push(event));
  return { client, events, stop };
}

/** A `bash` call, which always needs approval under a gate-only broker. */
export function bashStep(command: string): ScriptedStep {
  return { toolCalls: [{ name: 'bash', arguments: { command } }] };
}

/** A `todo` call, which declares no effects and is therefore never prompted. */
export function todoStep(content: string): ScriptedStep {
  return {
    toolCalls: [
      {
        name: 'todo',
        arguments: { items: [{ id: '1', content, status: 'in-progress' }] },
      },
    ],
  };
}

export function eventsOfType<T extends AdzeEvent['type']>(
  events: readonly AdzeEvent[],
  type: T,
): readonly Extract<AdzeEvent, { type: T }>[] {
  return events.filter((event): event is Extract<AdzeEvent, { type: T }> => event.type === type);
}
