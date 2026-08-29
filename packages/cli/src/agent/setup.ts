/**
 * Building the engine, once, for both `run` and `chat`.
 *
 * Shared because the two commands must not be able to differ in what they configure. A
 * sandbox mode or approval policy that `run` honours and `chat` does not is a security
 * display that lies in one of the two places, and the user has no way to tell which.
 *
 * The engine runs **in-process**. There is no JSON-RPC here on purpose: core is a set of
 * typed methods and `@adze/sdk` owns framing, so the CLI pays no serialization cost and
 * no startup latency for a transport it does not need.
 */

import {
  Engine,
  type EventSink,
  NodeSubprocessBroker,
  type SandboxBroker,
  scrubEnvironment,
} from '@adze/core';
import type {
  ApprovalPolicy,
  CommandRule,
  ModelSelection,
  SandboxConfig,
  SandboxMode,
} from '@adze/protocol';
import {
  type AiSdkGateway,
  createGateway,
  type LanguageModelFactory,
  type ResolvedConfig,
  type ResolveOptions,
} from '@adze/providers';
import { CLI_VERSION } from '../version.js';
import type { ApprovalChannel } from './approval.js';

export interface AgentSetup {
  readonly engine: Engine;
  readonly gateway: AiSdkGateway;
  readonly model: ModelSelection;
  readonly config: ResolvedConfig;
  readonly sandbox: SandboxConfig;
  readonly approvals: ApprovalPolicy;
  readonly workspaceRoot: string;
}

export interface AgentOptions {
  readonly workspaceRoot: string;
  readonly modelRef?: string | undefined;
  readonly effort?: ModelSelection['effort'] | undefined;
  readonly temperature?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly sandboxMode: SandboxMode;
  readonly approvals: ApprovalPolicy;
  readonly commandRules: readonly CommandRule[];
  readonly instructions?: string | undefined;
  readonly sink: EventSink;
  readonly approvalChannel: ApprovalChannel;
  /** Injected by tests so no real subprocess or network is involved. */
  readonly broker?: SandboxBroker;
  /**
   * Injected by tests. Passed straight through to the gateway.
   *
   * Named directly rather than derived from `createGateway`'s parameter type: that
   * parameter is optional, so `Parameters<typeof createGateway>[0]` includes `undefined`
   * and any `extends { languageModel?: infer F }` over it collapses to `never` — which
   * type-checks at the declaration and then rejects every value a test tries to pass.
   */
  readonly languageModel?: LanguageModelFactory;
  /**
   * How provider configuration is resolved. **A test seam that tests must use.**
   *
   * Without it, `createGateway` reads the real `process.env` and the developer's own
   * `~/.adze/providers.json`, so a test asserting the no-credential message passes or fails
   * depending on whether the machine running it happens to export `OPENAI_API_KEY`. That is
   * a test that reports the environment rather than the code. Passing
   * `{ env: {}, ignoreConfigFiles: true }` makes the assertion mean what it says.
   */
  readonly resolve?: ResolveOptions;
}

/**
 * Wire the engine.
 *
 * Throws {@link ProviderConfigurationError} when there is no model to select, which the
 * caller renders as an actionable message rather than a stack trace.
 */
export function buildAgent(options: AgentOptions): AgentSetup {
  const { gateway, model, config } = createGateway({
    cwd: options.workspaceRoot,
    ...options.resolve,
    ...(options.modelRef === undefined ? {} : { modelRef: options.modelRef }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
    ...(options.languageModel === undefined ? {} : { languageModel: options.languageModel }),
  });

  const sandbox: SandboxConfig = {
    mode: options.sandboxMode,
    writableRoots: [],
    allowedNetworkHosts: [],
    commandRules: [...options.commandRules],
  };

  const engine = new Engine({
    provider: gateway,
    // The subprocess broker's environment is scrubbed of credential-shaped names. The
    // model chooses the commands, so a key in the environment is a key one `env` away
    // from the transcript. This is a mitigation, not a boundary — only OS-level
    // containment closes the rest, and on Windows there is none (ADR-0007).
    broker: options.broker ?? new NodeSubprocessBroker({ env: scrubEnvironment(process.env) }),
    sink: options.sink,
    engineInfo: { name: '@adze/cli', version: CLI_VERSION },
    requestApproval: options.approvalChannel.request,
    defaultModel: model,
  });

  return {
    engine,
    gateway,
    model,
    config,
    sandbox,
    approvals: options.approvals,
    workspaceRoot: options.workspaceRoot,
  };
}
