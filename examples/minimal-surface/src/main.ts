#!/usr/bin/env node
/**
 * A complete Adze surface, in one file.
 *
 * The proof of ADR-0001's claim that `@adze/sdk` is a supported public API: this
 * imports nothing but `@adze/sdk`, renders the engine's event stream itself, and
 * decides its own approval policy. Nothing here reaches into `@adze/core`.
 *
 * It runs offline against the scripted provider — no API key, no network, no cost — so
 * `pnpm start` works on a fresh clone. README.md has the one-line swap to a real model.
 *
 * The event `switch` is the whole job of a surface. The engine renders nothing; what
 * appears on stdout is this file's opinion about how to draw structured events, and a
 * different surface would draw the same ones as a chat panel.
 */

import {
  type AdzeEvent,
  type ApprovalRequest,
  type ApprovalResponse,
  createClient,
  scriptedProvider,
} from '@adze/sdk';

const write = (text: string): void => void process.stdout.write(text);
const line = (text: string): void => write(`${text}\n`);

/** This surface's policy: read-only. It explains itself rather than just refusing. */
function decide(request: ApprovalRequest): ApprovalResponse {
  line(`\n  ? ${request.summary}`);
  line(`    why:  ${request.reason}`);
  if (request.command !== undefined) line(`    argv: ${JSON.stringify(request.command)}`);
  line("    ->    deny (read-only surface; return 'allow-once' to permit it)");
  return { requestId: request.requestId, decision: 'deny', note: 'read-only surface' };
}

function render(event: AdzeEvent): void {
  switch (event.type) {
    case 'turn.started':
      line(`> turn ${event.turnId} · ${event.model} · cache epoch ${event.cacheEpoch}`);
      break;
    case 'text.delta':
      // Concatenated by the consumer; the engine does not buffer on a surface's behalf.
      write(event.text);
      break;
    case 'tool.started':
      line(`  + ${event.call.name} ${JSON.stringify(event.call.arguments)}`);
      break;
    case 'tool.finished':
      line(`  = ${event.result.ok ? 'ok' : 'failed'}`);
      break;
    // Not the same as a tool that ran and failed: a trajectory that conflated the two
    // would count a denial as an execution.
    case 'tool.denied':
      line(`  x denied by ${event.source}: ${event.reason}`);
      break;
    case 'todo.updated':
      for (const item of event.items) line(`  · [${item.status}] ${item.content}`);
      break;
    case 'usage.updated':
      line(
        `  ~ ${event.usage.cachedInputTokens} of ${event.usage.inputTokens + event.usage.cachedInputTokens} prompt tokens cached`,
      );
      break;
    case 'turn.completed':
      line(`< ${event.stopReason} after ${event.steps} step(s)`);
      break;
    default:
      break;
  }
}

const client = createClient({
  workspaceRoot: process.cwd(),
  model: { provider: 'scripted', model: 'offline-demo' },
  provider: scriptedProvider({
    prices: { currency: 'USD', inputPerMTok: 3, cachedInputPerMTok: 0.3, outputPerMTok: 15 },
    // Scripted, including the token counts. They are shaped like a warm prompt cache —
    // cold on the first step, then the frozen epoch prefix served from cache — to show
    // what the SDK reports. Nothing here is a measurement.
    script: [
      {
        toolCalls: [
          {
            name: 'todo',
            arguments: { items: [{ id: '1', content: 'Remove build/', status: 'in-progress' }] },
          },
        ],
        inputTokens: 800,
        outputTokens: 20,
      },
      {
        toolCalls: [{ name: 'bash', arguments: { command: 'rm -rf build' } }],
        inputTokens: 60,
        cachedInputTokens: 800,
        outputTokens: 25,
      },
      {
        textDeltas: ['I was not allowed to run that, ', 'so the plan stands.\n'],
        inputTokens: 90,
        cachedInputTokens: 800,
        outputTokens: 15,
      },
    ],
  }),
  sandbox: { mode: 'read-only' },
  approvals: 'on-request',
  onApprovalRequest: decide,
  // No subprocess can start, so this example cannot touch the machine it runs on.
  commandExecution: 'disabled',
});

line(`engine ${client.engine.name}@${client.engine.version} · protocol ${client.protocolVersion}`);
// Rendered before the turn, not after: a user about to approve a command needs to know
// there is no containment first.
for (const warning of client.warnings) line(`! [${warning.code}] ${warning.message}`);
line('');

const session = await client.createSession();
const unsubscribe = session.subscribe(render);
const result = await session.run({ prompt: 'Clean the build directory.', budget: { maxSteps: 6 } });
unsubscribe();

const { inputTokens, cachedInputTokens, outputTokens } = result.usage;
line(`  tokens: ${inputTokens} in / ${cachedInputTokens} cached / ${outputTokens} out`);
line(`  cache hit rate: ${(result.cacheHitRate * 100).toFixed(1)}%`);
// Unknown rather than zero when the provider has no prices, because a wrong cost figure
// is worse than no cost figure.
line(
  `  cost: ${result.cost === undefined ? 'unknown' : `${result.cost.totalUsd.toFixed(6)} ${result.cost.currency}`}`,
);

await client.dispose();
process.exit(result.stopReason === 'end-turn' ? 0 : 1);
