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

import { Engine, type EventSink, type SearchBackend } from '@adze/core';
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
import type { ContainmentPlan } from '@adze/sandbox';
import { resolveShellPrefix } from '../shell.js';
import { CLI_VERSION } from '../version.js';
import type { ApprovalChannel } from './approval.js';
import type { CliSandbox } from './sandbox.js';
import { RetrievalSearchBackend } from './search.js';

export interface AgentSetup {
  readonly engine: Engine;
  readonly gateway: AiSdkGateway;
  readonly model: ModelSelection;
  readonly config: ResolvedConfig;
  readonly sandbox: SandboxConfig;
  /**
   * What the OS sandbox will actually enforce, and everything it will not.
   *
   * Returned so a surface renders the boundary that is in force rather than the one it
   * requested. `SandboxConfig` above is the request; this is the answer.
   */
  readonly containment: ContainmentPlan;
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
  /**
   * Extra writable roots under `workspace-write`, from `.adze/config.jsonc`
   * (`sandbox.writableRoots`) or `ADZE_WRITABLE_ROOTS`. Empty means the
   * workspace root only. Every entry must be absolute; `@adze/sdk` validates
   * that for embedders and the CLI resolves them the same way.
   */
  readonly writableRoots?: readonly string[];
  /**
   * Hosts reachable when the mode would otherwise deny network, from
   * `sandbox.allowedNetworkHosts` or `ADZE_ALLOWED_HOSTS`. Matched by exact
   * host string.
   */
  readonly allowedNetworkHosts?: readonly string[];
  readonly instructions?: string | undefined;
  readonly sink: EventSink;
  readonly approvalChannel: ApprovalChannel;
  /**
   * The wired OS sandbox: the broker the gate authorizes against, and its plan.
   *
   * **Required, and deliberately not optional.** The field it replaces was
   * `broker?: SandboxBroker`, an override nothing in the repository ever supplied — so
   * every run silently fell back to core's `NodeSubprocessBroker`, which reports
   * `gate-only` on every platform by construction. An optional containment seam is
   * precisely how `@adze/sandbox` came to be unreachable, so this one cannot be omitted.
   * A test that wants a scripted broker supplies a {@link CliSandbox} carrying it.
   */
  readonly containment: CliSandbox;
  /**
   * Retrieval, for `glob`, `grep`, and `symbols`.
   *
   * Defaults to `@adze/retrieval` over the workspace. Injectable so a test can drive the
   * three tools without ripgrep on the machine running it — and so the default is a
   * decision made here rather than an absence nobody notices, which is how these tools
   * came to be dead in the CLI in the first place.
   */
  readonly search?: SearchBackend;
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
    writableRoots: [...(options.writableRoots ?? [])],
    allowedNetworkHosts: [...(options.allowedNetworkHosts ?? [])],
    commandRules: [...options.commandRules],
  };

  const engine = new Engine({
    provider: gateway,
    // `@adze/sandbox` picks the mechanism: Seatbelt on macOS, bubblewrap on Linux where
    // user namespaces allow it, an honest partial broker on Windows. Every broker there
    // also scrubs credential-shaped environment names before spawning, so the mitigation
    // the previous `NodeSubprocessBroker` provided is kept and a real boundary is added
    // underneath it on the platforms that have one. Windows still has none (ADR-0007), and
    // `options.containment.plan` is what the surface prints rather than an assumption.
    broker: options.containment.broker,
    // Without this, `glob`, `grep`, and `symbols` report themselves unavailable and the
    // agent falls back to `bash grep` — one approval prompt per search, and raw stdout
    // for the model to scrape instead of ranked structured hits.
    search: options.search ?? new RetrievalSearchBackend({ root: options.workspaceRoot }),
    // `bash` on PATH is WSL's launcher on many Windows machines, and a broken WSL fails
    // every command the agent runs. `doctor` could detect that and only advise editing
    // PATH; ADZE_SHELL makes that advice actionable.
    bash: { shellPrefix: resolveShellPrefix(process.env).prefix },
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
    containment: options.containment.plan,
    approvals: options.approvals,
    workspaceRoot: options.workspaceRoot,
  };
}
