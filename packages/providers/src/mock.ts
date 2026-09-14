import {
  AgentEventSchema,
  AgentInputSchema,
  AgentSpecSchema,
  type AgentEvent,
  type AgentHandle,
  type AgentInput,
  type AgentSpec,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderDetection,
} from "@daycrew/shared";

import { AsyncQueue } from "./async-queue.js";

export type MockScript = ReadonlyArray<ReadonlyArray<AgentEvent>>;

export interface MockProviderOptions {
  readonly id?: string;
  readonly displayName?: string;
  readonly script?: MockScript;
  readonly scriptsByMember?: Readonly<Record<string, MockScript>>;
}

const isMockScript = (value: MockScript | MockProviderOptions): value is MockScript =>
  Array.isArray(value);

const defaultScript: MockScript = [
  [
    { type: "text", text: "I have received the goal." },
    {
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 7, costUsd: 0 },
    },
    { type: "done", summary: "Mock work completed." },
  ],
];

class MockAgentHandle implements AgentHandle {
  readonly events: AsyncIterable<AgentEvent>;
  private readonly queue = new AsyncQueue<AgentEvent>();
  private nextTurn = 0;
  private stopped = false;

  constructor(
    private readonly script: MockScript,
    private readonly memberId: string,
    private readonly recordInput: (memberId: string, input: AgentInput) => void,
  ) {
    this.events = this.queue;
  }

  async send(input: AgentInput): Promise<void> {
    AgentInputSchema.parse(input);
    if (this.stopped) throw new Error("Mock agent is stopped");
    this.recordInput(this.memberId, input);

    const events = this.script[this.nextTurn];
    this.nextTurn += 1;
    if (!events) {
      throw new Error(`Mock script has no turn ${this.nextTurn}`);
    }

    for (const event of events) {
      const parsed = AgentEventSchema.parse(event);
      this.queue.push(parsed);
      if (parsed.type === "done") {
        this.stopped = true;
        this.queue.close();
      }
    }
  }

  async updateInstructions(_instructions: string): Promise<void> {}

  async interrupt(): Promise<void> {
    if (this.stopped) return;
    this.queue.push({
      type: "error",
      message: "Mock agent interrupted.",
      recoverable: true,
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.queue.close();
  }
}

export class MockProvider implements ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolUse: true,
    approvals: true,
    interruption: true,
    resume: false,
    skillCapabilities: ["filesystem.read", "filesystem.write", "command.run", "browser", "network"],
  };

  private readonly script: MockScript;
  private readonly scriptsByMember: Readonly<Record<string, MockScript>>;
  readonly inputs: Array<{ readonly memberId: string; readonly input: AgentInput }> = [];
  readonly specs: AgentSpec[] = [];

  constructor(options: MockScript | MockProviderOptions = defaultScript) {
    this.id = isMockScript(options) ? "mock" : (options.id ?? "mock");
    this.displayName = isMockScript(options) ? "Deterministic Mock" : (options.displayName ?? "Deterministic Mock");
    this.script = isMockScript(options) ? options : (options.script ?? defaultScript);
    this.scriptsByMember = isMockScript(options) ? {} : (options.scriptsByMember ?? {});
    for (const script of [this.script, ...Object.values(this.scriptsByMember)]) {
      for (const turn of script) {
        for (const event of turn) AgentEventSchema.parse(event);
      }
    }
  }

  async detect(): Promise<ProviderDetection> {
    return { available: true, installed: true, authenticated: true, version: "0.0.0" };
  }

  async startAgent(spec: AgentSpec): Promise<AgentHandle> {
    const parsed = AgentSpecSchema.parse(spec);
    this.specs.push(parsed);
    return new MockAgentHandle(
      this.scriptsByMember[parsed.memberId] ?? this.script,
      parsed.memberId,
      (memberId, input) => this.inputs.push({ memberId, input }),
    );
  }
}
