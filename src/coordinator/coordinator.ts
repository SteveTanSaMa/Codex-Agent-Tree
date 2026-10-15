import {
  WorkspaceBroker,
  assertWorkspaceSeparation,
  workspaceTools,
  type WorkspacePolicy,
} from "../workspace/broker.ts";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  Store,
  type Agent,
  type Attempt,
  type Actor,
  type TreeLimits,
} from "../storage/store.ts";
import { AgentTreeError, requireCondition, integer } from "../core/errors.ts";
import {
  CodexRuntime,
  record,
  protocolString,
  type ProviderCredential,
  type RuntimeEvent,
  type RuntimeRequest,
} from "../runtime/codex/adapter.ts";
import {
  agentTools,
  spawnInput,
  sendInput,
  ackInput,
  statusInput,
  listInput,
  controlInput,
  getTaskInput,
} from "../tools/inputs.ts";

export type RuntimePort = Pick<
  CodexRuntime,
  | "onEvent"
  | "onRequest"
  | "onDisconnect"
  | "connect"
  | "disconnect"
  | "connectionInfo"
  | "isCurrent"
  | "respond"
  | "respondError"
  | "createThread"
  | "resumeThread"
  | "readThread"
  | "startTurn"
  | "interrupt"
>;
export interface CoordinatorOptions {
  stateDirectory: string;
  runtimeHome: string;
  executable?: string;
  credential?: ProviderCredential;
  expectedVersion: string;
  workspace?: WorkspacePolicy;
}
function nativeTurns(value: unknown): Record<string, unknown>[] {
  const thread = record(record(value).thread);
  requireCondition(
    Array.isArray(thread.turns),
    "CONFLICT",
    "Native history does not contain turns",
  );
  return thread.turns.map(record);
}
function turnText(turn: Record<string, unknown>): string {
  return Array.isArray(turn.items)
    ? turn.items
        .map(record)
        .filter((i) => i.type === "agentMessage" && typeof i.text === "string")
        .map((i) => i.text)
        .join("\n")
    : "";
}
function attemptMarker(
  turn: Record<string, unknown>,
  attemptId: string,
): boolean {
  if (!Array.isArray(turn.items)) return false;
  return turn.items
    .map(record)
    .filter((i) => i.type === "userMessage")
    .some(
      (i) =>
        Array.isArray(i.content) &&
        i.content
          .map(record)
          .some(
            (c) =>
              typeof c.text === "string" &&
              c.text.startsWith(`[AgentTree attempt ${attemptId}]\n`),
          ),
    );
}
function usageBreakdown(value: unknown): Record<string, number | null> {
  const source =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    [
      "totalTokens",
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "cacheWriteInputTokens",
      "reasoningOutputTokens",
    ].map((key) => {
      const item = source[key];
      return [
        key,
        typeof item === "number" && Number.isSafeInteger(item) && item >= 0
          ? item
          : null,
      ];
    }),
  );
}
/** Owns only business coordination; model execution and history remain in Codex. */
export class Coordinator {
  readonly store: Store;
  readonly runtime: RuntimePort;
  readonly workspace: WorkspaceBroker | undefined;
  private tickRequested = false;
  private requestedInterrupts = new Set<string>();
  private ticking = false;
  private reconciliation: Promise<void> | undefined;
  private reconcileRequested = false;
  private completionRecovery = new Set<string>();
  private ready = false;
  private stopping = false;
  private waitStop = new AbortController();
  private jobs = new Set<Promise<void>>();
  private errors: { code: string; message: string }[] = [];
  constructor(readonlyOptions: CoordinatorOptions, runtime?: RuntimePort) {
    const options = {
      ...readonlyOptions,
      stateDirectory: resolve(readonlyOptions.stateDirectory),
    };
    this.options = options;
    if (options.workspace)
      assertWorkspaceSeparation(
        options.workspace.repository,
        options.stateDirectory,
        options.runtimeHome,
      );
    this.store = new Store(join(options.stateDirectory, "business.sqlite"));
    try {
      this.workspace = options.workspace
        ? new WorkspaceBroker(options.stateDirectory, options.workspace, (id) =>
            this.store.agent(id),
          )
        : undefined;
      this.runtime =
        runtime ??
        new CodexRuntime({
          home: options.runtimeHome,
          expectedVersion: options.expectedVersion,
          ...(options.executable ? { executable: options.executable } : {}),
          ...(options.credential ? { credential: options.credential } : {}),
        });
    } catch (error) {
      this.store.close();
      throw error;
    }
    this.runtime.onEvent = (event) => this.background(this.handleEvent(event));
    this.runtime.onRequest = (request) =>
      this.background(this.handleRequest(request));
    this.runtime.onDisconnect = (error) => {
      this.ready = false;
      this.recordError(error);
      for (const a of this.store
        .attempts()
        .filter((a) => ["starting", "running"].includes(a.state)))
        this.store.uncertain(
          a.id,
          "Runtime connection lost; reconciliation required",
        );
    };
  }
  readonly options: CoordinatorOptions;
  private recordError(error: unknown) {
    const code =
      error instanceof AgentTreeError
        ? error.code
        : error instanceof Error
          ? error.name
          : "UNKNOWN";
    // Diagnostic summaries omit raw RPC payloads and server error strings which may contain sensitive data.
    this.errors.push({
      code,
      message:
        error instanceof AgentTreeError
          ? error.message
          : "Coordinator operation failed; inspect correlated state",
    });
    if (this.errors.length > 100) this.errors.shift();
  }
  private background(job: Promise<void>) {
    const tracked = job
      .catch((error) => {
        this.recordError(error);
      })
      .finally(() => this.jobs.delete(tracked));
    this.jobs.add(tracked);
  }
  async start() {
    try {
      await this.runtime.connect();
      const info = this.runtime.connectionInfo();
      this.store.registerRuntime(
        "default",
        info.nativePid,
        info.protocolVersion,
      );
      await this.reconcile();
      this.ready = true;
      await this.tick();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  createRoot(
    name: string,
    task: string,
    limits: TreeLimits,
    requestKey?: string,
  ): Agent {
    if (this.workspace && this.store.agents().length > 0) {
      requireCondition(
        requestKey &&
          this.store.db
            .prepare("SELECT agent_id FROM root_requests WHERE request_key=?")
            .get(requestKey),
        "CONFLICT",
        "Coding state supports one Lead tree; reuse its request key or create a separate repository checkout for another team",
      );
    }
    const agent = this.store.createRoot(name, task, limits, requestKey);
    this.background(this.tick());
    return agent;
  }
  submitInput(target: string, key: string, message: string): string {
    const id = this.store.operatorSend(target, key, message);
    this.background(this.tick());
    return id;
  }
  private cwd(agentId: string): string {
    return (
      this.workspace?.cwd(this.store.agent(agentId)) ??
      join(this.options.stateDirectory, "workspaces", agentId)
    );
  }
  private async ensureBinding(agent: Agent) {
    if (this.store.binding(agent.id)) return;
    const cwd = this.cwd(agent.id);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    this.store.note(agent.id, "session.create.intent", { cwd });
    // No Turn can start before binding commits. A lost creation ACK can leave only an empty orphan Thread.
    const thread = await this.runtime.createThread(
      cwd,
      [
        ...agentTools,
        ...(this.workspace
          ? workspaceTools(
              agent.depth,
              Object.keys(this.workspace.policy.tests),
            )
          : []),
      ],
      "Use the supplied Agent Tree tools for all delegation and communication. Caller identity and permissions are host-controlled. Do not invoke native subagents. Use only your supplied tools. Descendants cannot use terminal; Lead may use terminal only in coding mode. For a delegation task, spawn once and end the initial Turn promptly; do not wait for a child result. On a message-triggered Turn, handle the delivered messages, send a report to your parent if appropriate, then agent_ack their IDs before finishing. A non-root leaf must report its result to its parent with agent_send before finishing. Reuse requestKey for the same logical action. Never invent a successful tool response." +
        (this.workspace
          ? ` Coding workspace: ${cwd}. Level ${agent.depth + 1}. Second-level writes are isolated in a detached worktree based on ${this.workspace.policy.baseCommit}; report changed files and workspace path. Third-level Agents inspect their parent workspace read-only. A test result is not task completion. Lead must review patches before integrating them.`
          : " This is a text-only team; do not run commands."),
    );
    this.store.bind(agent.id, thread, "default");
  }
  private async tick() {
    if (!this.ready || this.stopping) return;
    this.tickRequested = true;
    if (this.ticking) return;
    this.ticking = true;
    try {
      do {
        this.tickRequested = false;
        for (const snapshot of this.store.agents()) {
          if (this.stopping || !this.ready) break;
          const agent = this.store.agent(snapshot.id);
          if (agent.desired !== "active") continue;
          const attempts = this.store.attempts(agent.id);
          if (
            attempts.some((a) =>
              ["starting", "running", "unknown"].includes(a.state),
            )
          )
            continue;
          const prepared = attempts.find((a) => a.state === "prepared");
          const pendingMessages = this.store
            .messages(agent.id)
            .filter((m) => m.status === "queued");
          const queued: typeof pendingMessages = [];
          let encodedSize = 0;
          for (const message of pendingMessages) {
            const size = JSON.stringify({
              id: message.id,
              sender: message.sender_id,
              message: message.body,
            }).length;
            if (size > 44000) {
              this.store.rejectQueuedMessage(
                agent.id,
                message.id,
                `Serialized message exceeds the 44000-character delivery limit (${size})`,
              );
              continue;
            }
            if (queued.length >= 20 || encodedSize + size > 44000) break;
            queued.push(message);
            encodedSize += size;
          }
          if (!prepared && attempts.length > 0 && !queued.length) continue;
          try {
            await this.ensureBinding(agent);
            if (this.stopping || !this.ready) break;
            const binding = this.store.binding(agent.id)!;
            const native = record(
              (await this.runtime.readThread(binding.thread_id, false)).thread,
            );
            const nativeStatus = record(native.status);
            this.store.observeSession(agent.id, nativeStatus);
            if (nativeStatus.type === "active") {
              this.store.blockRuntime(
                agent.id,
                "Native Thread is active without a locally owned running attempt",
              );
              throw new AgentTreeError(
                "STATE_BLOCKED",
                "Unmanaged native execution requires reconciliation",
              );
            }
            requireCondition(
              nativeStatus.type === "idle",
              "STATE_BLOCKED",
              "Native Thread is not idle",
            );
            let attempt = prepared;
            if (!attempt) {
              const input = queued.length
                ? `${attempts.length === 0 ? `Initial assignment: ${agent.task}\n` : ""}Incoming messages: ${JSON.stringify(queued.map((m) => ({ id: m.id, sender: m.sender_id, message: m.body })))}. Handle them, report to your parent if needed, and call agent_ack with their IDs. End this Turn without spawning unless the task explicitly requires it.`
                : agent.task;
              attempt = this.store.prepare(
                agent.id,
                `You are ${agent.name}. Your stable Agent ID is ${agent.id}; your parent ID is ${agent.parent_id ?? "none (root)"}.\n${input}`,
                null,
                queued[0] ? String(queued[0].id) : null,
                queued.map((m) => m.id),
              );
            }
            this.store.note(
              agent.id,
              "turn.runtime_metadata",
              {
                configuredModel:
                  typeof native.model === "string" ? native.model : null,
                configuredProvider:
                  typeof native.modelProvider === "string"
                    ? native.modelProvider
                    : null,
                threadId: binding.thread_id,
              },
              attempt.id,
            );
            this.store.markStarting(attempt.id);
            try {
              const turnId = await this.runtime.startTurn(
                attempt.thread_id,
                attempt.input,
                attempt.id,
              );
              const current = this.store.attempt(attempt.id);
              if (current.state === "starting")
                this.store.attachTurn(
                  current.id,
                  current.binding_generation,
                  turnId,
                );
              else
                requireCondition(
                  current.turn_id === turnId,
                  "CONFLICT",
                  "Turn ACK differs from observed event",
                );
              this.store.clearRecoveredRuntimeBlock(current.agent_id);
              if (
                ["cancelled", "terminated"].includes(
                  this.store.agent(current.agent_id).desired,
                )
              )
                await this.interrupt([this.store.attempt(current.id)]);
            } catch (error) {
              const current = this.store.attempt(attempt.id);
              if (["starting", "running"].includes(current.state))
                this.store.uncertain(
                  current.id,
                  "Turn dispatch failed or ACK lost; inspect native history before retry",
                );
              throw error;
            }
          } catch (error) {
            if (
              error instanceof AgentTreeError &&
              ["STATE_BLOCKED", "BUDGET_EXHAUSTED"].includes(error.code)
            )
              continue;
            this.recordError(error);
            this.store.note(agent.id, "scheduler.error", {
              code:
                error instanceof AgentTreeError ? error.code : "RUNTIME_ERROR",
            });
          }
        }
      } while (this.tickRequested && this.ready && !this.stopping);
    } finally {
      this.ticking = false;
    }
  }
  private eventAttempt(threadId: string, turnId: string): Attempt | undefined {
    return this.store.attemptForTurn(threadId, turnId);
  }
  private async handleEvent(event: RuntimeEvent) {
    if (!this.runtime.isCurrent(event.connectionGeneration)) return;
    const p = record(event.params);
    if (event.method === "thread/status/changed") {
      const bound = this.store
        .agents()
        .find((a) => this.store.binding(a.id)?.thread_id === p.threadId);
      if (bound) this.store.observeSession(bound.id, p.status);
    } else if (event.method === "turn/started") {
      const turn = record(p.turn);
      const threadId = protocolString(p.threadId);
      const turnId = protocolString(turn.id);
      const starting = this.store
        .attempts()
        .find((a) => a.thread_id === threadId && a.state === "starting");
      if (starting && !starting.turn_id) {
        // A start notification is not a reply to our request. Another client may
        // have started a Turn between the idle check and our turn/start RPC.
        // Before the ACK, only persisted input carrying our marker proves ownership.
        try {
          const turns = nativeTurns(await this.runtime.readThread(threadId));
          if (!this.runtime.isCurrent(event.connectionGeneration)) return;
          const current = this.store.attempt(starting.id);
          if (
            ["starting", "unknown"].includes(current.state) &&
            current.turn_id === null &&
            turns.filter((t) => t.id === turnId && attemptMarker(t, current.id))
              .length === 1
          )
            this.store.attachTurn(
              current.id,
              current.binding_generation,
              turnId,
            );
        } catch {
          // Unavailable history cannot establish ownership. The ACK/recovery
          // may prove it later; until then the tools remain fail-closed.
        }
      }
      if (!this.runtime.isCurrent(event.connectionGeneration)) return;
      const observed = this.eventAttempt(threadId, turnId);
      if (observed) this.store.clearRecoveredRuntimeBlock(observed.agent_id);
      if (
        observed &&
        ["cancelled", "terminated"].includes(
          this.store.agent(observed.agent_id).desired,
        )
      )
        await this.interrupt([observed]);
      else if (!observed) {
        const bound = this.store
          .agents()
          .find((a) => this.store.binding(a.id)?.thread_id === threadId);
        if (bound)
          this.store.blockRuntime(
            bound.id,
            "An unowned native Turn started; inspect its history before continuing",
            [turnId],
          );
      }
    } else if (event.method === "turn/completed") {
      const turn = record(p.turn);
      const a = this.eventAttempt(
        protocolString(p.threadId),
        protocolString(turn.id),
      );
      if (!a) {
        const threadId = protocolString(p.threadId);
        const key = `${event.connectionGeneration}:${threadId}:${protocolString(turn.id)}`;
        if (
          !this.completionRecovery.has(key) &&
          this.store
            .attempts()
            .some(
              (pending) =>
                pending.thread_id === threadId &&
                ["starting", "running", "unknown"].includes(pending.state),
            )
        ) {
          this.completionRecovery.add(key);
          try {
            await this.reconcile();
            await this.tick();
          } finally {
            this.completionRecovery.delete(key);
          }
        }
        return;
      }
      const status = turn.status;
      requireCondition(
        status === "completed" ||
          status === "failed" ||
          status === "interrupted",
        "CONFLICT",
        "Unexpected native Turn terminal state",
      );
      const prior = this.store.attempt(a.id);
      this.store.finish(
        a.id,
        a.binding_generation,
        status,
        turnText(turn) || prior.result || "",
      );
      this.requestedInterrupts.delete(a.id);
      await this.tick();
    } else if (event.method === "item/completed") {
      const item = record(p.item);
      if (item.type !== "agentMessage" || typeof item.text !== "string") return;
      const a = this.eventAttempt(
        protocolString(p.threadId),
        protocolString(p.turnId),
      );
      if (a) this.store.updateResult(a.id, a.binding_generation, item.text);
    } else if (event.method === "thread/tokenUsage/updated") {
      const a = this.eventAttempt(
        protocolString(p.threadId),
        protocolString(p.turnId),
      );
      if (!a) return;
      const total = record(record(p.tokenUsage).total);
      requireCondition(
        typeof total.totalTokens === "number",
        "CONFLICT",
        "Missing cumulative native usage",
      );
      this.store.observeNativeUsage(
        a.id,
        a.binding_generation,
        total.totalTokens,
        {
          total: usageBreakdown(total),
          last: usageBreakdown(record(p.tokenUsage).last),
        },
      );
      if (["completed", "failed", "interrupted"].includes(a.state))
        await this.tick();
    }
  }
  private async handleRequest(request: RuntimeRequest) {
    if (!this.runtime.isCurrent(request.connectionGeneration)) return;
    const p = record(request.params);
    if (request.method !== "item/tool/call") {
      const bound = this.store
        .agents()
        .find((a) => this.store.binding(a.id)?.thread_id === p.threadId);
      if (bound)
        this.store.note(bound.id, "approval.declined", {
          method: request.method,
          nativeRequestId: request.id,
          bindingGeneration: this.store.binding(bound.id)!.generation,
          reason: "MVP fail-closed policy; no automatic grant",
        });
      if (
        [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
        ].includes(request.method)
      )
        this.runtime.respond(request, { decision: "decline" });
      else if (request.method === "item/tool/requestUserInput")
        this.runtime.respond(request, { answers: {} });
      else
        this.runtime.respondError(
          request,
          -32601,
          "This host does not support this server request; no authorization granted",
        );
      this.recordError(
        new AgentTreeError(
          "STATE_BLOCKED",
          `Server request safely declined: ${request.method}`,
        ),
      );
      return;
    }
    let actor: Actor | undefined;
    try {
      const threadId = protocolString(p.threadId);
      const turnId = protocolString(p.turnId);
      const b = this.store
        .agents()
        .map((a) => this.store.binding(a.id))
        .find((b) => b?.thread_id === threadId);
      requireCondition(
        b,
        "FORBIDDEN",
        "Unmanaged Thread cannot invoke Agent tools",
      );
      actor = this.store.authenticate(threadId, turnId, b.generation);
      const tool = protocolString(p.tool);
      this.store.note(actor.agentId, "tool.called", {
        tool,
        nativeCallId: p.callId ?? null,
        turnId,
      });
      let output: unknown;
      if (
        [
          "read_file",
          "write_file",
          "search_code",
          "git_diff",
          "run_test",
          "terminal",
        ].includes(tool)
      ) {
        requireCondition(
          this.workspace,
          "FORBIDDEN",
          "No coding workspace was authorized",
        );
        const agent = this.store.agent(actor.agentId);
        requireCondition(
          agent.desired === "active" && !this.store.runtimeBlock(agent.id),
          "STATE_BLOCKED",
          "Workspace capability blocked by lifecycle or reconciliation fence",
        );
        this.store.note(agent.id, "workspace.tool.started", {
          tool,
          nativeCallId: p.callId ?? null,
          turnId,
        });
        requireCondition(
          workspaceTools(
            agent.depth,
            Object.keys(this.workspace.policy.tests),
          ).some((t) => t.name === tool),
          "FORBIDDEN",
          "Workspace tool is not granted at this level",
        );
        if (["terminal", "run_test"].includes(tool))
          this.workspace.validateCommand(agent, tool, p.arguments);
        const callId = protocolString(p.callId);
        const command = ["run_test", "terminal"].includes(tool)
          ? this.store.beginWorkspaceCommand(actor, callId, p.arguments)
          : undefined;
        if (command?.cached) output = command.result;
        else {
          output = await this.workspace.call(agent, tool, p.arguments);
          if (["run_test", "terminal"].includes(tool))
            this.store.finishWorkspaceCommand(agent.id, callId, output);
        }
        const result = output as Record<string, unknown>;
        this.store.note(agent.id, "workspace.tool.completed", {
          tool,
          ...(tool === "write_file"
            ? {
                path: result.path,
                hash: result.hash,
                unchanged: result.unchanged,
              }
            : {}),
          ...(["terminal", "run_test"].includes(tool)
            ? {
                exitCode: result.exitCode,
                stopped: result.stopped,
                truncated: result.truncated,
              }
            : {}),
          nativeCallId: p.callId ?? null,
          turnId,
        });
      } else if (tool === "agent_task_create") {
        output = this.store.tasks.create(actor, actor.agentId, p.arguments);
      } else if (tool === "agent_task_update") {
        output = this.store.tasks.update(actor, actor.agentId, p.arguments);
      } else if (tool === "agent_task_get") {
        output = this.store.tasks.get(
          actor,
          actor.agentId,
          getTaskInput(p.arguments),
        );
      } else if (tool === "agent_task_list") {
        listInput(p.arguments);
        output = this.store.tasks.list(actor, actor.agentId);
      } else if (tool === "agent_spawn") {
        const { requestKey, ...input } = spawnInput(p.arguments);
        const child = this.store.spawn(actor, requestKey, input);
        output = {
          agentId: child.id,
          parentId: child.parent_id,
          state: "accepted",
          threadId: this.store.binding(child.id)?.thread_id ?? null,
        };
      } else if (tool === "agent_send") {
        const input = sendInput(p.arguments);
        output = {
          messageId: this.store.send(
            actor,
            input.requestKey,
            input.target,
            input.message,
          ),
          state: "queued",
        };
      } else if (tool === "agent_ack") {
        const ids = ackInput(p.arguments);
        this.store.acknowledge(actor, ids);
        output = { acknowledged: ids };
      } else if (tool === "agent_list") {
        listInput(p.arguments);
        output = this.store
          .agents(this.store.agent(actor.agentId).tree_id)
          .map((a) => this.status(a.id));
      } else if (tool === "agent_status") {
        const target = statusInput(p.arguments) ?? actor.agentId;
        requireCondition(
          this.store.agent(target).tree_id ===
            this.store.agent(actor.agentId).tree_id,
          "FORBIDDEN",
          "Status outside caller tree",
        );
        output = this.status(target);
      } else if (tool === "agent_control") {
        const input = controlInput(p.arguments);
        const attempts = this.store.control(
          actor,
          input.target,
          input.action,
          input.scope,
        );
        this.cancelWorkspaceTests();
        await this.interrupt(attempts);
        output = this.status(input.target);
      } else throw new AgentTreeError("INVALID_INPUT", "Unknown Agent tool");
      this.runtime.respond(request, {
        success: true,
        contentItems: [{ type: "inputText", text: JSON.stringify(output) }],
      });
      await this.tick();
    } catch (error) {
      if (actor)
        this.store.note(actor.agentId, "tool.rejected", {
          code: error instanceof AgentTreeError ? error.code : "TOOL_ERROR",
        });
      if (this.runtime.isCurrent(request.connectionGeneration))
        this.runtime.respond(request, {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text:
                error instanceof AgentTreeError
                  ? `${error.code}: ${error.message}`
                  : "Tool failed; inspect host status before retrying",
            },
          ],
        });
      this.recordError(error);
    }
  }
  status(agentId: string) {
    const agent = this.store.agent(agentId);
    const attempts = this.store.attempts(agentId);
    const active = attempts.find((a) =>
      ["prepared", "starting", "running", "unknown"].includes(a.state),
    );
    return {
      ...agent,
      workspace: this.workspace
        ? {
            level: agent.depth + 1,
            terminal: agent.depth === 0,
            write: agent.depth <= 1,
            commands: this.store.workspaceCommands(agent.id),
            commandSummary: this.store.workspaceCommandSummary(agent.id),
          }
        : null,
      pendingUsageReceipts: this.store.pendingUsageReceipts(agentId),
      binding: this.store.binding(agentId) ?? null,
      runtimeBlock: this.store.runtimeBlock(agentId) ?? null,
      nativeObservation: this.store.sessionObservation(agentId) ?? null,
      budget: this.store.budgetStatus(agent.tree_id),
      executionLimits: this.store.executionStatus(agent.tree_id),
      execution: active?.state ?? (attempts.length ? "idle" : "initializing"),
      attemptCount: attempts.length,
      attempts: attempts.slice(-20).map((a) => {
        const { input, ...summary } = a;
        return {
          ...summary,
          inputSummary: input.slice(0, 160),
          accounting: this.store.accounting(a.id),
          usageReceipts: this.store.usageReceipts(a.id),
        };
      }),
      messageCount: this.store.messages(agentId).length,
      messages: this.store
        .messages(agentId)
        .slice(-50)
        .map((m) => ({ ...m, body: m.body.slice(0, 2000) })),
    };
  }
  view(target: string) {
    const treeId = this.store.agent(target).tree_id;
    const limits = this.store.limits(treeId);
    const budget = this.store.budgetStatus(treeId);
    const executionLimits = this.store.executionStatus(treeId);
    const reasons: { agentId: string | null; code: string }[] = [];
    let progressPossible = false;
    const agents = this.store.agents(treeId).map((agent) => {
      const attempts = this.store.attempts(agent.id);
      const active = attempts.find((a) =>
        ["prepared", "starting", "running", "unknown"].includes(a.state),
      );
      const messages = this.store.messages(agent.id);
      const queued = messages.filter((m) => m.status === "queued").length;
      const block = this.store.runtimeBlock(agent.id);
      if (agent.desired !== "active")
        reasons.push({ agentId: agent.id, code: agent.desired });
      if (block) reasons.push({ agentId: agent.id, code: "quarantined" });
      if (active?.state === "unknown")
        reasons.push({ agentId: agent.id, code: "unknown-execution" });
      if (active && ["starting", "running"].includes(active.state))
        progressPossible = true;
      const hasWork =
        queued > 0 || agent.turns === 0 || active?.state === "prepared";
      if (hasWork) {
        const exhausted =
          !active &&
          (agent.turns >= limits.maxTurnsPerAgent ||
            executionLimits.remainingTurns === 0 ||
            (budget.enforced &&
              agent.capacity - agent.spent - agent.reserved <
                limits.turnReservation));
        if (exhausted) reasons.push({ agentId: agent.id, code: "agent-limit" });
        if (
          agent.desired === "active" &&
          !block &&
          active?.state !== "unknown" &&
          !exhausted &&
          (active?.state === "prepared" ||
            !budget.enforced ||
            (budget.availableTokens >= limits.turnReservation &&
              !budget.unknownUsageAttempts.length))
        )
          progressPossible = true;
      }
      const binding = this.store.binding(agent.id);
      return {
        id: agent.id,
        parentId: agent.parent_id,
        name: agent.name,
        depth: agent.depth,
        desired: agent.desired,
        execution: active?.state ?? (agent.turns ? "idle" : "initializing"),
        threadId: binding?.thread_id ?? null,
        bindingGeneration: binding?.generation ?? null,
        attemptCount: attempts.length,
        latestAttemptId: attempts.at(-1)?.id ?? null,
        resultPreview: attempts.at(-1)?.result?.slice(0, 1000) ?? null,
        messages: {
          queued,
          uncertain: messages.filter((m) => m.status === "unknown").length,
          rejected: messages.filter((m) => m.status === "rejected").length,
          processed: messages.filter((m) => m.status === "processed").length,
        },
      };
    });
    if (!this.ready) {
      progressPossible = false;
      reasons.push({ agentId: null, code: "runtime-not-ready" });
    }
    if (budget.enforced && budget.unknownUsageAttempts.length)
      reasons.push({ agentId: null, code: "unknown-usage" });
    if (
      budget.enforced &&
      (budget.excessLiabilityTokens > 0 ||
        budget.availableTokens < limits.turnReservation)
    )
      reasons.push({ agentId: null, code: "tree-budget" });
    if (executionLimits.remainingTurns === 0)
      reasons.push({ agentId: null, code: "tree-turn-limit" });
    const tasks = this.store.tasks.list(null, target);
    if (!progressPossible)
      reasons.push({
        agentId: null,
        code: tasks.some((t) => t.status !== "completed")
          ? "tasks-require-explicit-input"
          : "quiescent",
      });
    return {
      treeId,
      cursor: this.store.eventCursor(treeId),
      agents,
      tasks,
      budget,
      executionLimits,
      progressPossible,
      reasons,
      taskCompletionIsExplicit: true,
    };
  }
  async wait(
    target: string,
    after: number,
    timeoutMs = 25000,
    signal?: AbortSignal,
  ) {
    integer(after, "after cursor");
    integer(timeoutMs, "timeoutMs");
    requireCondition(
      timeoutMs <= 30000,
      "INVALID_INPUT",
      "Wait timeout must be at most 30000 ms",
    );
    requireCondition(
      after <= this.store.eventCursor(),
      "CONFLICT",
      "Cursor is ahead of this database; resync with view",
    );
    const treeId = this.store.agent(target).tree_id;
    const timeout = new AbortController();
    const combined = AbortSignal.any([
      timeout.signal,
      this.waitStop.signal,
      ...(signal ? [signal] : []),
    ]);
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    try {
      for (;;) {
        signal?.throwIfAborted();
        if (this.waitStop.signal.aborted)
          return {
            reason: "stopped",
            cursor: after,
            hasMore: false,
            events: [],
            view: null,
          };
        const events = this.store.eventPage(treeId, after);
        const view = this.view(target);
        if (events.length) {
          const cursor = Number(events.at(-1)!.sequence);
          return {
            reason: "changed",
            cursor,
            hasMore: cursor < view.cursor,
            events,
            view,
          };
        }
        if (!view.progressPossible)
          return {
            reason: "noProgress",
            cursor: after,
            hasMore: false,
            events: [],
            view,
          };
        if (timeout.signal.aborted || timeoutMs === 0)
          return {
            reason: "timedOut",
            cursor: after,
            hasMore: false,
            events: [],
            view,
          };
        // No await between the durable cursor check and waiter registration.
        // Only committed events wake this promise; unrelated trees are rechecked.
        await this.store.waitForCommit(combined);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  async nativeHistory(agentId: string) {
    const binding = this.store.binding(agentId);
    requireCondition(binding, "STATE_BLOCKED", "No active binding");
    return this.runtime.readThread(binding.thread_id);
  }
  async settleUsage(attemptId: string, tokens: number, reason: string) {
    const attempt = this.store.attempt(attemptId);
    const history = await this.runtime.readThread(attempt.thread_id);
    const thread = record(record(history).thread);
    const status = record(thread.status).type;
    requireCondition(
      status === "idle" || status === "notLoaded",
      "STATE_BLOCKED",
      "Native Thread is not confirmed idle",
    );
    const turns = nativeTurns(history);
    requireCondition(
      !turns.some((t) => t.status === "inProgress"),
      "STATE_BLOCKED",
      "Native execution is still live",
    );
    requireCondition(
      turns.some(
        (t) =>
          t.id === attempt.turn_id &&
          ["completed", "failed", "interrupted"].includes(String(t.status)),
      ),
      "STATE_BLOCKED",
      "Matching terminal native Turn is required for settlement",
    );
    this.store.submitUsageReceipt(
      attemptId,
      attempt.binding_generation,
      tokens,
      reason,
    );
    await this.tick();
    return this.status(attempt.agent_id);
  }
  async releaseQuarantine(agentId: string, reason: string) {
    const binding = this.store.binding(agentId);
    requireCondition(binding, "STATE_BLOCKED", "No active binding");
    const metadata = record(
      (await this.runtime.readThread(binding.thread_id, false)).thread,
    );
    requireCondition(
      record(metadata.status).type === "idle",
      "STATE_BLOCKED",
      "Native Thread is not confirmed idle",
    );
    const turns = nativeTurns(await this.runtime.readThread(binding.thread_id));
    requireCondition(
      !turns.some((t) => t.status === "inProgress"),
      "STATE_BLOCKED",
      "Native execution is still live",
    );
    this.store.clearRuntimeBlock(agentId, reason);
    await this.tick();
    return this.status(agentId);
  }
  diagnostics() {
    return {
      pid: process.pid,
      ready: this.ready,
      ownerGeneration: this.store.generation,
      runtimeConnections: this.store.runtimeConnections(),
      errors: [...this.errors],
    };
  }
  async control(
    target: string,
    action: "pause" | "resume" | "cancel" | "terminate",
    scope: "agent" | "subtree" = "subtree",
  ) {
    const attempts = this.store.control(null, target, action, scope);
    if (action === "cancel" || action === "terminate")
      this.cancelWorkspaceTests();
    await this.interrupt(attempts);
    await this.tick();
    return this.status(target);
  }
  private cancelWorkspaceTests() {
    for (const agent of this.store.agents())
      if (["cancelled", "terminated"].includes(agent.desired))
        this.workspace?.cancel(agent.id);
  }
  private async interrupt(attempts: Attempt[]) {
    for (const snapshot of attempts) {
      const a = this.store.attempt(snapshot.id);
      if (!["starting", "running", "unknown"].includes(a.state)) continue;
      if (a.turn_id && !this.requestedInterrupts.has(a.id)) {
        this.requestedInterrupts.add(a.id);
        this.store.note(
          a.agent_id,
          "turn.interrupt_requested",
          { threadId: a.thread_id, turnId: a.turn_id },
          a.id,
        );
        try {
          await this.runtime.interrupt(a.thread_id, a.turn_id);
        } catch {
          this.requestedInterrupts.delete(a.id);
          const current = this.store.attempt(a.id);
          if (["starting", "running", "unknown"].includes(current.state))
            this.store.uncertain(a.id, "Interrupt not confirmed");
          else
            this.store.note(
              a.agent_id,
              "turn.interrupt_race_resolved",
              { observedState: current.state },
              a.id,
            );
        }
      }
    }
  }
  private reconcile(): Promise<void> {
    this.reconcileRequested = true;
    if (!this.reconciliation) {
      this.reconciliation = (async () => {
        do {
          this.reconcileRequested = false;
          await this.performReconcile();
        } while (this.reconcileRequested && !this.stopping);
      })().finally(() => {
        this.reconciliation = undefined;
      });
    }
    return this.reconciliation;
  }
  private async performReconcile() {
    for (const agent of this.store.agents()) {
      const binding = this.store.binding(agent.id);
      if (!binding) continue;
      const outstanding = this.store
        .attempts(agent.id)
        .filter((a) => ["starting", "running", "unknown"].includes(a.state));
      try {
        await this.runtime.resumeThread(binding.thread_id, this.cwd(agent.id));
        if (!outstanding.length) continue;
        const turns = nativeTurns(
          await this.runtime.readThread(binding.thread_id),
        );
        const unowned = turns.filter(
          (t) =>
            t.status === "inProgress" &&
            !outstanding.some(
              (a) =>
                a.turn_id === t.id || (!a.turn_id && attemptMarker(t, a.id)),
            ),
        );
        if (unowned.length)
          this.store.blockRuntime(
            agent.id,
            "Unowned live native Turn observed during recovery",
            unowned.map((turn) => protocolString(turn.id)),
          );
        for (const snapshot of outstanding) {
          const a = this.store.attempt(snapshot.id);
          if (!["starting", "running", "unknown"].includes(a.state)) continue;
          const matches = turns.filter((t) =>
            a.turn_id ? t.id === a.turn_id : attemptMarker(t, a.id),
          );
          if (matches.length !== 1) {
            this.store.uncertain(
              a.id,
              "Native Turn not uniquely identified; manual reconciliation required",
            );
            continue;
          }
          const turn = matches[0]!;
          const id = protocolString(turn.id);
          this.store.observeAttemptRuntime(a.id);
          if (!a.turn_id || a.state === "unknown")
            this.store.attachTurn(a.id, a.binding_generation, id);
          if (turn.status === "inProgress") {
            if (
              ["cancelled", "terminated"].includes(
                this.store.agent(agent.id).desired,
              )
            )
              await this.interrupt([this.store.attempt(a.id)]);
            continue;
          }
          requireCondition(
            turn.status === "completed" ||
              turn.status === "failed" ||
              turn.status === "interrupted",
            "CONFLICT",
            "Unknown historical Turn state",
          );
          this.store.finish(
            a.id,
            a.binding_generation,
            turn.status,
            turnText(turn),
          );
        }
        this.store.clearRecoveredRuntimeBlock(agent.id);
      } catch (error) {
        const all = this.store.attempts(agent.id);
        if (
          !this.store.runtimeBlock(agent.id) &&
          !outstanding.length &&
          all.every(
            (a) =>
              a.turn_id === null && ["prepared", "cancelled"].includes(a.state),
          )
        ) {
          let live = false;
          try {
            live =
              record(
                record(
                  (await this.runtime.readThread(binding.thread_id, false))
                    .thread,
                ).status,
              ).type === "active";
          } catch {
            /* No dispatched attempt exists; an absent empty context has no model work to replay. */
          }
          if (live)
            this.store.blockRuntime(
              agent.id,
              "An empty local binding has unowned native execution",
            );
          else this.store.retireUnstartedBinding(agent.id);
          continue;
        }
        for (const a of outstanding)
          if (
            ["starting", "running", "unknown"].includes(
              this.store.attempt(a.id).state,
            )
          )
            this.store.uncertain(
              a.id,
              "Native history unavailable; retained without replay",
            );
        this.recordError(error);
      }
    }
  }
  async stop(releaseBarrier?: Promise<void>) {
    this.workspace?.cancel();
    // Observe rejections immediately while bounded in-flight RPC cleanup is still pending.
    const releaseOutcome = releaseBarrier?.then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error: error as unknown }),
    );
    if (this.stopping) {
      const result = await releaseOutcome;
      if (result && !result.ok) throw result.error;
      return;
    }
    this.stopping = true;
    this.waitStop.abort();
    this.ready = false;
    this.runtime.disconnect();
    // No new dispatch; in-flight RPCs are bounded. A detached native daemon keeps existing Turns.
    const deadline = Date.now() + 35000;
    while ((this.ticking || this.jobs.size > 0) && Date.now() < deadline)
      await new Promise<void>((r) => setTimeout(r, 20));
    this.runtime.disconnect();
    try {
      const result = await releaseOutcome;
      if (result && !result.ok) throw result.error;
    } finally {
      this.store.close();
    }
  }
}
