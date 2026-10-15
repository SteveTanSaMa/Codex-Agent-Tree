import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  Coordinator,
  type RuntimePort,
} from "../../src/coordinator/coordinator.ts";
import { ControlledRuntime } from "../fixtures/controlled-runtime.ts";
const limits = {
  tokens: 1000,
  maxDepth: 1,
  maxAgents: 2,
  maxConcurrentTurns: 2,
  maxTurnsPerAgent: 4,
  turnReservation: 100,
};
async function settled() {
  for (let n = 0; n < 8; n++) await new Promise<void>((r) => setImmediate(r));
}

test("a foreign started event during local dispatch cannot acquire the local Attempt or invoke its tools", async () => {
  const directory = mkdtempSync("/tmp/cat-foreign-start-");
  let rejectStart: ((e: Error) => void) | undefined;
  const runtime: RuntimePort = new ControlledRuntime();
  runtime.startTurn = async (threadId) => {
    runtime.onEvent({
      method: "turn/started",
      connectionGeneration: 1,
      params: {
        threadId,
        turn: { id: "foreign-turn", status: "inProgress", items: [] },
      },
    });
    return new Promise<string>((_resolve, reject) => {
      rejectStart = reject;
    });
  };
  const coordinator = new Coordinator(
    {
      stateDirectory: directory,
      runtimeHome: join(directory, "native"),
      expectedVersion: "fixture",
    },
    runtime,
  );
  try {
    await coordinator.start();
    const root = coordinator.createRoot("A", "owned task", limits);
    await settled();
    const binding = coordinator.store.binding(root.id)!;
    runtime.onRequest({
      id: "foreign-call",
      method: "item/tool/call",
      connectionGeneration: 1,
      params: {
        threadId: binding.thread_id,
        turnId: "foreign-turn",
        tool: "agent_task_create",
        arguments: {
          requestKey: "foreign",
          subject: "wrong task",
          description: "must be rejected",
        },
      },
    });
    await settled();
    assert.equal(coordinator.store.tasks.list(null, root.id).length, 0);
    assert.equal(coordinator.store.attempts(root.id)[0]?.turn_id, null);
    assert.ok(coordinator.store.runtimeBlock(root.id));
    rejectStart!(new Error("Native Thread already has foreign execution"));
    await settled();
    runtime.onEvent({
      method: "turn/completed",
      connectionGeneration: 1,
      params: {
        threadId: binding.thread_id,
        turn: { id: "foreign-turn", status: "completed", items: [] },
      },
    });
    await settled();
    assert.equal(coordinator.store.attempts(root.id)[0]?.state, "unknown");
  } finally {
    rejectStart?.(new Error("fixture cleanup"));
    await coordinator.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("early starts require marker proof; delayed ACK clears only the proven Turn quarantine", async () => {
  for (const evidence of ["marker", "empty", "unavailable"]) {
    const directory = mkdtempSync("/tmp/cat-owned-start-");
    const runtime: RuntimePort = new ControlledRuntime();
    let resolveStart: ((id: string) => void) | undefined;
    let dispatching = false;
    let attemptId = "";
    runtime.readThread = async (threadId, includeTurns = true) => {
      if (includeTurns && dispatching && evidence === "unavailable")
        throw new Error("history unavailable");
      return {
        thread: {
          id: threadId,
          status: { type: dispatching ? "active" : "idle" },
          turns:
            dispatching && evidence === "marker"
              ? [
                  {
                    id: "owned-turn",
                    status: "inProgress",
                    items: [
                      {
                        type: "userMessage",
                        content: [
                          {
                            type: "text",
                            text: `[AgentTree attempt ${attemptId}]\nowned input`,
                          },
                        ],
                      },
                    ],
                  },
                ]
              : [],
        },
      };
    };
    runtime.startTurn = async (threadId, _input, id) => {
      dispatching = true;
      attemptId = id;
      runtime.onEvent({
        method: "turn/started",
        connectionGeneration: 1,
        params: {
          threadId,
          turn: { id: "owned-turn", status: "inProgress", items: [] },
        },
      });
      return new Promise<string>((resolve) => {
        resolveStart = resolve;
      });
    };
    const coordinator = new Coordinator(
      {
        stateDirectory: directory,
        runtimeHome: join(directory, "native"),
        expectedVersion: "fixture",
      },
      runtime,
    );
    try {
      await coordinator.start();
      const root = coordinator.createRoot("A", "work", limits);
      await settled();
      assert.equal(
        coordinator.store.attempts(root.id)[0]?.turn_id,
        evidence === "marker" ? "owned-turn" : null,
      );
      assert.equal(
        !!coordinator.store.runtimeBlock(root.id),
        evidence !== "marker",
      );
      resolveStart!("owned-turn");
      await settled();
      assert.equal(coordinator.store.attempts(root.id)[0]?.state, "running");
      assert.equal(coordinator.store.runtimeBlock(root.id), undefined);
      const binding = coordinator.store.binding(root.id)!;
      runtime.onRequest({
        id: "owned-tool",
        method: "item/tool/call",
        connectionGeneration: 1,
        params: {
          threadId: binding.thread_id,
          turnId: "owned-turn",
          tool: "agent_task_create",
          arguments: {
            requestKey: "owned",
            subject: "legitimate",
            description: "owned work",
          },
        },
      });
      await settled();
      assert.equal(coordinator.store.tasks.list(null, root.id).length, 1);
    } finally {
      resolveStart?.("owned-turn");
      await coordinator.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("ownership hydration cannot adopt a Turn after its connection generation disconnects", async () => {
  const directory = mkdtempSync("/tmp/cat-start-generation-");
  const runtime: RuntimePort = new ControlledRuntime();
  let dispatching = false;
  let attemptId = "";
  let releaseHistory: (() => void) | undefined;
  let rejectStart: ((error: Error) => void) | undefined;
  runtime.readThread = async (threadId, includeTurns = true) => {
    if (!dispatching || !includeTurns)
      return { thread: { id: threadId, status: { type: "idle" }, turns: [] } };
    await new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    return {
      thread: {
        id: threadId,
        status: { type: "active" },
        turns: [
          {
            id: "owned-turn",
            status: "inProgress",
            items: [
              {
                type: "userMessage",
                content: [
                  {
                    type: "text",
                    text: `[AgentTree attempt ${attemptId}]\nwork`,
                  },
                ],
              },
            ],
          },
        ],
      },
    };
  };
  runtime.startTurn = async (threadId, _input, id) => {
    dispatching = true;
    attemptId = id;
    runtime.onEvent({
      method: "turn/started",
      connectionGeneration: 1,
      params: {
        threadId,
        turn: { id: "owned-turn", status: "inProgress", items: [] },
      },
    });
    return new Promise<string>((_resolve, reject) => {
      rejectStart = reject;
    });
  };
  const coordinator = new Coordinator(
    {
      stateDirectory: directory,
      runtimeHome: join(directory, "native"),
      expectedVersion: "fixture",
    },
    runtime,
  );
  try {
    await coordinator.start();
    const root = coordinator.createRoot("A", "work", limits);
    await settled();
    assert.ok(releaseHistory);
    runtime.disconnect();
    runtime.onDisconnect(new Error("disconnected during proof"));
    releaseHistory();
    await settled();
    assert.equal(coordinator.store.attempts(root.id)[0]?.state, "unknown");
    assert.equal(coordinator.store.attempts(root.id)[0]?.turn_id, null);
    rejectStart!(new Error("reply lost"));
    await settled();
  } finally {
    releaseHistory?.();
    rejectStart?.(new Error("cleanup"));
    await coordinator.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
