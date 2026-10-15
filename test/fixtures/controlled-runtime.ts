import type { RuntimePort } from "../../src/coordinator/coordinator.ts";
import type {
  RuntimeEvent,
  RuntimeRequest,
} from "../../src/runtime/codex/adapter.ts";

export class ControlledRuntime implements RuntimePort {
  onEvent: (event: RuntimeEvent) => void = () => {};
  onRequest: (request: RuntimeRequest) => void = () => {};
  onDisconnect: (error: Error) => void = () => {};
  connected = false;
  threads = 0;
  starts: {
    threadId: string;
    input: string;
    attemptId: string;
    turnId: string;
    completed: boolean;
  }[] = [];
  responses: unknown[] = [];
  async connect() {
    this.connected = true;
  }
  connectionInfo() {
    return { nativePid: null, protocolVersion: "controlled-fixture" };
  }
  disconnect() {
    this.connected = false;
  }
  isCurrent(generation: number) {
    return this.connected && generation === 1;
  }
  respond(_request: RuntimeRequest, value: unknown) {
    this.responses.push(value);
  }
  respondError(_request: RuntimeRequest, _code: number, message: string) {
    this.responses.push({ error: message });
  }
  async createThread() {
    return `thread-${++this.threads}`;
  }
  async resumeThread() {
    return {};
  }
  async readThread(threadId: string) {
    const turns = this.starts.filter((t) => t.threadId === threadId);
    return {
      thread: {
        id: threadId,
        status: { type: turns.some((t) => !t.completed) ? "active" : "idle" },
        turns: turns.map((t) => ({
          id: t.turnId,
          status: t.completed ? "completed" : "inProgress",
          items: [],
        })),
      },
    };
  }
  async startTurn(threadId: string, input: string, attemptId: string) {
    const turnId = `turn-${this.starts.length + 1}`;
    this.starts.push({ threadId, input, attemptId, turnId, completed: false });
    return turnId;
  }
  async interrupt() {}
  complete(index = 0) {
    const start = this.starts[index]!;
    start.completed = true;
    const totalTokens =
      this.starts.filter((t) => t.threadId === start.threadId && t.completed)
        .length * 10;
    this.onEvent({
      method: "thread/tokenUsage/updated",
      connectionGeneration: 1,
      params: {
        threadId: start.threadId,
        turnId: start.turnId,
        tokenUsage: { total: { totalTokens } },
      },
    });
    this.onEvent({
      method: "turn/completed",
      connectionGeneration: 1,
      params: {
        threadId: start.threadId,
        turn: {
          id: start.turnId,
          status: "completed",
          items: [{ type: "agentMessage", text: "done" }],
        },
      },
    });
  }
}
