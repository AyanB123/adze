/**
 * The engine, embedded in the extension host.
 *
 * In-process rather than over a transport, and that is the whole point of this
 * surface: the extension host is already a Node process, `@adze/core` is a set of
 * typed methods, and `@adze/sdk` owns framing for the cases that need it. Running
 * the engine here costs no serialization and no startup latency for a transport it
 * does not need — the same arrangement the CLI uses, for the same reason.
 *
 * Everything crossing this boundary in either direction is a `@adze/protocol` type.
 * `@adze/core` and `@adze/providers` are imported to *construct* the engine and to
 * price a run, exactly as `packages/cli/src/agent/setup.ts` does; no other module in
 * this extension imports them, so the rest of the extension could be pointed at an
 * out-of-process engine by replacing this file alone.
 *
 * Construction is lazy. Activation must not need a credential, so the gateway is
 * built on the first submit and a missing API key surfaces as an actionable message
 * at the moment the user asks for something rather than as a broken extension at
 * startup.
 */

import {
  computeCost,
  Engine,
  NodeSubprocessBroker,
  type PriceSheet,
  scrubEnvironment,
} from '@adze/core';
import type {
  AdzeEvent,
  ApprovalRequest,
  ApprovalResponse,
  Cost,
  InitializeResult,
  ModelSelection,
  SandboxEnforcement,
  Usage,
  Warning,
} from '@adze/protocol';
import { SUPPORTED_PROTOCOL_VERSIONS, sandboxEnforcement } from '@adze/protocol';
import { createGateway, priceFor } from '@adze/providers';
import type { ResolvedSettings } from '../settings.js';

/** Appears in trajectory logs and in the engine's client identity. */
export const CLIENT_NAME = 'adze-vscode';
export const CLIENT_VERSION = '0.0.1';

export interface EngineHostOptions {
  readonly workspaceRoot: string;
  readonly onEvent: (event: AdzeEvent) => void;
  readonly requestApproval: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  /** Defaults to `process.platform`. Injectable so both enforcement branches are testable. */
  readonly platform?: string;
}

export interface ActiveSession {
  readonly sessionId: string;
  /** What is actually in force, which can differ from what was requested. */
  readonly model: ModelSelection;
  readonly enforcement: SandboxEnforcement;
  readonly capabilities: InitializeResult['capabilities'];
  readonly warnings: readonly Warning[];
}

export class EngineHost {
  private readonly options: EngineHostOptions;
  private readonly platform: string;
  private engine: Engine | undefined;
  private session: ActiveSession | undefined;
  private prices: PriceSheet | undefined;
  private turnId: string | undefined;
  private capture: string[] | undefined;

  constructor(options: EngineHostOptions) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
  }

  /** The model in force, once a session exists. */
  get model(): ModelSelection | undefined {
    return this.session?.model;
  }

  get enforcement(): SandboxEnforcement | undefined {
    return this.session?.enforcement;
  }

  get running(): boolean {
    return this.turnId !== undefined;
  }

  /**
   * Build the engine and create a session.
   *
   * Throws `ProviderConfigurationError` when there is no model to select. The caller
   * renders that as an actionable message; see `src/failure.ts`.
   */
  async start(settings: ResolvedSettings): Promise<ActiveSession> {
    const existing = this.session;
    if (existing !== undefined) return existing;

    const { gateway, model } = createGateway({
      cwd: this.options.workspaceRoot,
      ...(settings.modelRef === undefined ? {} : { modelRef: settings.modelRef }),
    });
    this.prices = priceFor(model.provider, model.model);

    const engine = new Engine({
      provider: gateway,
      // The subprocess environment is scrubbed of credential-shaped names. The model
      // chooses the commands, so a key in the environment is one `env` away from the
      // transcript. A mitigation, not a boundary.
      broker: new NodeSubprocessBroker({ env: scrubEnvironment(process.env) }),
      sink: (event) => {
        this.track(event);
        this.options.onEvent(event);
      },
      engineInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      requestApproval: this.options.requestApproval,
      defaultModel: model,
      platform: this.platform,
    });

    const initialized = engine.initialize({
      protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      client: { name: CLIENT_NAME, version: CLIENT_VERSION, platform: this.platform },
    });

    const created = await engine.sessionCreate({
      workspaceRoot: this.options.workspaceRoot,
      model,
      sandbox: settings.sandbox,
      approvals: settings.approvals,
      ...(settings.instructions === undefined ? {} : { instructions: settings.instructions }),
    });

    this.engine = engine;
    this.session = {
      sessionId: created.sessionId,
      // What came back, not what was asked for: rendering the requested mode when the
      // engine narrowed it would be the worst possible lie in a security display.
      model: created.model,
      enforcement: sandboxEnforcement(this.platform, created.sandbox.mode),
      capabilities: initialized.capabilities,
      warnings: [...initialized.warnings, ...created.warnings],
    };
    return this.session;
  }

  /** Submit a turn and resolve once it has finished. Rejects on a provider failure. */
  async submit(prompt: string, settings: ResolvedSettings): Promise<void> {
    const session = await this.start(settings);
    const engine = this.engine;
    if (engine === undefined) throw new Error('engine was not constructed');

    const submitted = await engine.turnSubmit({
      sessionId: session.sessionId,
      prompt,
      attachments: [],
      budget: settings.budget,
    });
    this.turnId = submitted.turnId;
    try {
      await engine.awaitTurn(submitted.turnId);
    } finally {
      this.turnId = undefined;
    }
  }

  /**
   * Submit a turn and return the assistant text it produced.
   *
   * For ghost text, which needs the string rather than the stream. Deltas are
   * captured here rather than reassembled by the caller so there is one place that
   * knows the engine does not buffer.
   */
  async collectText(prompt: string, settings: ResolvedSettings): Promise<string> {
    const buffer: string[] = [];
    this.capture = buffer;
    try {
      await this.submit(prompt, settings);
    } finally {
      this.capture = undefined;
    }
    return buffer.join('');
  }

  /**
   * Cancel the turn in flight.
   *
   * False when there was nothing to cancel. Not an error: a cancel racing a
   * completion is normal, and making it one would force the caller to special-case a
   * race it cannot avoid.
   */
  cancel(): boolean {
    const session = this.session;
    const turnId = this.turnId;
    if (this.engine === undefined || session === undefined || turnId === undefined) return false;
    return this.engine.turnCancel({ sessionId: session.sessionId, turnId }).cancelled;
  }

  /** `undefined` when the price table has no rates for this model. Never zero. */
  costFor(usage: Usage): Cost | undefined {
    return this.prices === undefined ? undefined : computeCost(usage, this.prices);
  }

  async dispose(): Promise<void> {
    const session = this.session;
    if (this.engine === undefined || session === undefined) return;
    this.cancel();
    await this.engine.sessionClose({ sessionId: session.sessionId });
    this.engine = undefined;
    this.session = undefined;
    this.turnId = undefined;
  }

  private track(event: AdzeEvent): void {
    if (event.type === 'text.delta' && this.capture !== undefined) this.capture.push(event.text);
    if (event.type === 'turn.completed') this.turnId = undefined;
  }
}
