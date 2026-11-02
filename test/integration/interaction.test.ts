import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import { workspacePolicy } from "../../src/workspace/broker.ts";
import { ControlledRuntime } from "../fixtures/controlled-runtime.ts";
import { RpcFailure } from "../../src/runtime/codex/vendor/jsonrpc-client.ts";
import {
  rootSettings,
  interactionPolicy,
} from "../../src/storage/interaction.ts";
import { Store } from "../../src/storage/store.ts";
const settle = () => new Promise((r) => setTimeout(r, 20));
class SteeringRuntime extends ControlledRuntime {
  steers: { thread: string; turn: string; input: string; id: string }[] = [];
  interrupts: string[] = [];
  failure: Error | undefined;
  async steerTurn(thread: string, turn: string, input: string, id: string) {
    this.steers.push({ thread, turn, input, id });
    if (this.failure) throw this.failure;
    return turn;
  }
  override async interrupt(_thread?: string, turn?: string) {
    this.interrupts.push(turn!);
  }
}
async function fixture(
  policy: Record<string, unknown> = {},
  runtime = new SteeringRuntime(),
) {
  const dir = mkdtempSync("/tmp/cat-guidance-");
  const options = {
    stateDirectory: dir,
    runtimeHome: join(dir, "native"),
    expectedVersion: "fixture",
  };
  const coordinator = new Coordinator(options, runtime);
  await coordinator.start();
  const settings = rootSettings(policy);
  const root = coordinator.createRoot(
    "A",
    "work",
    settings.limits,
    "root",
    settings.policy,
  );
  await settle();
  return {
    dir,
    runtime,
    coordinator,
    root,
    options,
    async close() {
      await coordinator.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("interactive defaults are unlimited; batch and explicit limits remain available", () => {
  assert.equal(rootSettings({}).limits.maxAgents, 20);
  assert.equal(rootSettings({ mode: "batch" }).limits.maxAgents, 20);
  assert.equal(rootSettings({ maxAgents: "7" }).limits.maxAgents, 7);
  assert.equal(rootSettings({}).limits.maxTotalTurns, null);
  assert.equal(rootSettings({}).limits.maxTurnsPerAgent, null);
  assert.equal(rootSettings({ mode: "batch" }).limits.maxTotalTurns, 100);
  assert.equal(rootSettings({ mode: "batch" }).limits.maxTurnsPerAgent, 20);
  assert.equal(
    rootSettings({ maxTurns: "7", maxTotalTurns: "30" }).limits
      .maxTurnsPerAgent,
    7,
  );
  assert.equal(
    rootSettings({ maxTurns: "unlimited" }).limits.maxTurnsPerAgent,
    null,
  );
  assert.throws(() => rootSettings({ mode: "nonsense" }), /mode/);
  assert.throws(
    () => rootSettings({ tokenPolicy: "invalid" }),
    /Invalid token policy/,
  );
  assert.throws(
    () => rootSettings({ tokenPolicy: "enforce" }),
    /per-Agent token allocations/,
  );
  assert.throws(
    () => rootSettings({ maxTotalTurns: "0" }),
    /Invalid maxTotalTurns/,
  );
  assert.throws(
    () => rootSettings({ maxTurns: "0" }),
    /Invalid maxTurnsPerAgent/,
  );
  assert.throws(() => interactionPolicy({ taskTokenBudget: -1 }), /Invalid/);
  assert.throws(() => interactionPolicy({ foo: 1 }), /Unknown/);
});
test("live guidance targets the existing Turn, is idempotent, and does not increment Turns", async () => {
  const f = await fixture();
  try {
    const a = f.coordinator.store.attempts(f.root.id)[0]!;
    const result = await f.coordinator.submitGuidance(
      f.root.id,
      "correction",
      "use the other path",
    );
    assert.equal(result.state, "delivered");
    assert.equal(f.runtime.steers[0]!.turn, a.turn_id);
    assert.match(f.runtime.steers[0]!.input, /agent_ack/);
    await f.coordinator.submitGuidance(
      f.root.id,
      "correction",
      "use the other path",
    );
    assert.equal(f.runtime.steers.length, 1);
    assert.equal(f.coordinator.store.agent(f.root.id).turns, 1);
    assert.equal(
      f.coordinator.store.messages(f.root.id)[0]!.status,
      "delivering",
    );
    await assert.rejects(
      f.coordinator.submitGuidance(f.root.id, "correction", "other content"),
      /changed content/,
    );
    await assert.rejects(
      f.coordinator.submitGuidance(
        f.root.id,
        "correction",
        "use the other path",
        "queue",
      ),
      /delivery mode/,
    );
  } finally {
    await f.close();
  }
});
test("queue mode waits; several human messages form one next Turn", async () => {
  const f = await fixture();
  try {
    await f.coordinator.submitGuidance(f.root.id, "one", "one", "queue");
    await f.coordinator.submitGuidance(f.root.id, "two", "two", "queue");
    assert.equal(f.runtime.steers.length, 0);
    assert.equal(f.runtime.starts.length, 1);
    f.runtime.complete();
    await settle();
    assert.equal(f.runtime.starts.length, 2);
    assert.match(f.runtime.starts[1]!.input, /one/);
    assert.match(f.runtime.starts[1]!.input, /two/);
    assert.equal(f.coordinator.store.agent(f.root.id).turns, 2);
  } finally {
    await f.close();
  }
});
test("unsupported steering safely defers, but lost ACK is never automatically replayed", async () => {
  const f = await fixture();
  try {
    f.runtime.failure = new RpcFailure("unsupported", "unknown", -32601);
    const deferred = await f.coordinator.submitGuidance(
      f.root.id,
      "unsupported",
      "next",
    );
    assert.equal(deferred.state, "deferred");
    f.runtime.failure = new RpcFailure("ACK lost", "unknown");
    const unknown = await f.coordinator.submitGuidance(
      f.root.id,
      "uncertain",
      "do not duplicate",
    );
    assert.equal(unknown.state, "unknown");
    f.runtime.complete();
    await settle();
    assert.equal(f.runtime.starts.length, 1);
    assert.equal(f.coordinator.view(f.root.id).progressPossible, false);
    await f.coordinator.submitGuidance(
      f.root.id,
      "uncertain",
      "do not duplicate",
    );
    assert.equal(f.runtime.steers.length, 2);
    await f.coordinator.resolveGuidance(
      f.root.id,
      unknown.message_id,
      "retry-next",
      "Explicitly checked native history; retry approved",
    );
    await settle();
    assert.equal(f.runtime.starts.length, 2);
  } finally {
    await f.close();
  }
});
test("restart retains uncertain guidance and bindings without dispatching duplicate work", async () => {
  const f = await fixture();
  let second: Coordinator | undefined;
  try {
    const id = f.coordinator.store.operatorSend(f.root.id, "crash", "guidance");
    f.coordinator.store.interaction.register(f.root.id, id, "steer");
    f.coordinator.store.interaction.claim(
      id,
      f.coordinator.store.attempts(f.root.id)[0]!,
    );
    const binding = f.coordinator.store.binding(f.root.id);
    await f.coordinator.stop();
    second = new Coordinator(f.options, f.runtime);
    await second.start();
    assert.equal(
      second.store.interaction.guidance(f.root.id)[0]!.state,
      "unknown",
    );
    assert.deepEqual(second.store.binding(f.root.id), binding);
    assert.equal(f.runtime.starts.length, 1);
    assert.equal(second.store.agent(f.root.id).turns, 1);
  } finally {
    await second?.stop();
    await f.close();
  }
});
test("immediate pause interrupts and survives restart; ordinary pause only drains", async () => {
  const f = await fixture();
  let second: Coordinator | undefined;
  try {
    await f.coordinator.control(f.root.id, "pause");
    assert.equal(f.runtime.interrupts.length, 0);
    await f.coordinator.control(f.root.id, "pause", "subtree", true);
    assert.equal(f.runtime.interrupts.length, 1);
    assert.equal(
      f.coordinator.store.interaction.mustInterrupt(f.root.id),
      true,
    );
    await f.coordinator.stop();
    second = new Coordinator(f.options, f.runtime);
    await second.start();
    assert.equal(f.runtime.interrupts.length, 2);
    assert.equal(second.store.agent(f.root.id).desired, "paused");
    await second.control(f.root.id, "resume");
    assert.equal(second.store.interaction.mustInterrupt(f.root.id), false);
  } finally {
    await second?.stop();
    await f.close();
  }
});
test("tree-wide protection clocks survive restart; check-in resets autonomy but not task budgets", async () => {
  const dir = mkdtempSync("/tmp/cat-protection-");
  const path = join(dir, "business.sqlite");
  let store = new Store(path);
  try {
    const settings = rootSettings({
      autonomyWarnMs: 100,
      autonomyPauseMs: 200,
      taskTimeBudgetMs: 1000,
    });
    const root = store.createRoot("A", "work", settings.limits);
    store.interaction.configure(root.id, settings.policy);
    store.interaction.evaluate(root.id, true, 0, 1000);
    assert.deepEqual(
      store.interaction.evaluate(root.id, true, 0, 1101).warnings,
      ["autonomy-duration"],
    );
    assert.deepEqual(
      store.interaction.evaluate(root.id, true, 0, 1102).warnings,
      [],
    );
    store.close();
    store = new Store(path);
    assert.equal(
      store.interaction.evaluate(root.id, true, 0, 1201).pause,
      true,
    );
    store.interaction.checkIn(root.id, 1900);
    assert.equal(
      store.interaction.evaluate(root.id, true, 0, 1901).pause,
      false,
    );
    assert.equal(
      store.interaction.evaluate(root.id, true, 0, 2001).pause,
      true,
    );
    // Idle intervals are excluded from continuous autonomy, not optional wall-clock task budgets.
    store.interaction.checkIn(root.id, 2100);
    store.interaction.evaluate(root.id, false, 0, 2101);
    assert.equal(
      store.db.prepare("SELECT epoch_ms FROM tree_interaction").get()!.epoch_ms,
      null,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("soft task token budget pauses in-flight work without manufacturing completion", async () => {
  const f = await fixture({ taskTokenBudget: 5 });
  try {
    const a = f.coordinator.store.attempts(f.root.id)[0]!;
    f.coordinator.store.observeNativeUsage(a.id, a.binding_generation, 10);
    await f.coordinator.checkProtections();
    assert.equal(f.coordinator.store.agent(f.root.id).desired, "paused");
    assert.equal(f.runtime.interrupts.length, 1);
    assert.equal(f.coordinator.store.attempt(a.id).state, "running");
  } finally {
    await f.close();
  }
});

async function liveBackgroundFixture(policy: Record<string, unknown>) {
  const dir = mkdtempSync("/tmp/cat-background-guard-");
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "fixture"), "base");
  git("add", ".");
  git("commit", "-m", "fixture");
  const runtime = new ControlledRuntime();
  const coordinator = new Coordinator(
    {
      stateDirectory: join(dir, "state"),
      runtimeHome: join(dir, "runtime"),
      workspace: workspacePolicy(repo),
    },
    runtime,
  );
  const wait = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!condition() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(condition(), "background guard fixture did not settle");
  };
  try {
    await coordinator.start();
    const settings = rootSettings(policy);
    const root = coordinator.createRoot(
      "Lead",
      "background work",
      settings.limits,
      "guard-root",
      settings.policy,
    );
    await wait(
      () =>
        runtime.starts.length === 1 &&
        !!coordinator.store.attempts(root.id)[0]?.turn_id,
    );
    const turn = runtime.starts[0]!;
    const command = `'${process.execPath}' -e 'const fs=require("node:fs");fs.writeFileSync("started","yes");setInterval(()=>{if(fs.existsSync("finish"))process.exit(0)},10)'`;
    runtime.onRequest({
      id: "background-request",
      method: "item/tool/call",
      connectionGeneration: 1,
      params: {
        threadId: turn.threadId,
        turnId: turn.turnId,
        callId: "background-command",
        tool: "terminal_start",
        arguments: { command },
      },
    });
    await wait(
      () => runtime.responses.length > 0 && existsSync(join(repo, "started")),
    );
    assert.equal((runtime.responses[0] as { success: boolean }).success, true);
    return {
      dir,
      repo,
      coordinator,
      runtime,
      root,
      turn,
      wait,
      async close() {
        await coordinator.stop();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await coordinator.stop();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

for (const [name, pausePolicy] of [
  ["task-time budget", { taskTimeBudgetMs: 10000 }],
  ["continuous autonomy", { autonomyPauseMs: 10000 }],
] as const)
  test(`live background command retains warnings and ${name} pause after its Turn ends`, async () => {
    const f = await liveBackgroundFixture({
      autonomyWarnMs: 50,
      stallWarnMs: 50,
      ...pausePolicy,
    });
    try {
      f.runtime.complete();
      await f.wait(
        () => f.coordinator.store.attempts(f.root.id)[0]?.state === "completed",
      );
      const now = Date.now();
      await f.coordinator.checkProtections(now + 1000);
      const warnings = f.coordinator.store.interaction.summary(
        f.root.id,
      ).warnings;
      assert.ok(warnings.some((w) => w.reason === "autonomy-duration"));
      assert.ok(warnings.some((w) => w.reason === "no-observable-progress"));
      assert.equal(f.coordinator.store.agent(f.root.id).desired, "active");
      await f.coordinator.checkProtections(now + 20000);
      assert.equal(f.coordinator.store.agent(f.root.id).desired, "paused");
      await f.wait(
        () =>
          f.coordinator.store.workspaceCommand(f.root.id, "background-command")
            .state === "completed",
      );
      const receipt = f.coordinator.store.workspaceCommand(
        f.root.id,
        "background-command",
      );
      assert.equal(
        (receipt.result as { stopped: string }).stopped,
        "cancelled",
      );
      assert.equal(f.runtime.starts.length, 1);
    } finally {
      await f.close();
    }
  });

test("finished background work ends its epoch; unknown receipts alone are not live processes", async () => {
  const f = await liveBackgroundFixture({ taskTimeBudgetMs: 10000 });
  try {
    const actor = f.coordinator.store.authenticate(
      f.turn.threadId,
      f.turn.turnId,
      1,
    );
    f.coordinator.store.beginWorkspaceCommand(actor, "uncertain-after-crash", {
      command: "effect",
    });
    f.runtime.complete();
    await f.wait(
      () => f.coordinator.store.attempts(f.root.id)[0]?.state === "completed",
    );
    await f.coordinator.checkProtections(Date.now() + 1000);
    assert.notEqual(
      f.coordinator.store.interaction.summary(f.root.id).clocks?.epoch_ms,
      null,
    );
    writeFileSync(join(f.repo, "finish"), "finish");
    await f.wait(
      () =>
        f.coordinator.store.workspaceCommand(f.root.id, "background-command")
          .state === "completed",
    );
    await f.coordinator.checkProtections(Date.now() + 20000);
    assert.equal(f.coordinator.store.agent(f.root.id).desired, "active");
    assert.equal(
      f.coordinator.store.interaction.summary(f.root.id).clocks?.epoch_ms,
      null,
    );
    assert.equal(
      f.coordinator.store.workspaceCommand(f.root.id, "uncertain-after-crash")
        .state,
      "accepted",
    );
    assert.equal(f.runtime.starts.length, 1);
  } finally {
    await f.close();
  }
});
test("stall and repeated rejection warnings are latched and do not pause by default", async () => {
  const f = await fixture({ stallWarnMs: 100, repeatErrorThreshold: 3 });
  try {
    const i = f.coordinator.store.interaction;
    i.checkIn(f.root.id, 1000);
    i.evaluate(f.root.id, true, 0, 1000);
    for (let k = 0; k < 4; k++)
      f.coordinator.store.note(f.root.id, "tool.rejected", {
        tool: "read_file",
        code: "NOT_FOUND",
      });
    const at = Date.now() + 1000;
    i.stall(f.root.id, at);
    i.stall(f.root.id, at);
    const warnings = f.coordinator.store
      .events(f.root.id)
      .filter((e) => e.kind === "interaction.warning");
    assert.equal(
      warnings.filter(
        (e) => JSON.parse(String(e.body)).reason === "repeated-tool-rejection",
      ).length,
      1,
    );
    assert.equal(f.coordinator.store.agent(f.root.id).desired, "active");
  } finally {
    await f.close();
  }
});

test("late steering ACK stays attached to the original completed Turn", async () => {
  const runtime = new SteeringRuntime();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const original = runtime.steerTurn.bind(runtime);
  runtime.steerTurn = async (...args) => {
    const id = await original(...args);
    await gate;
    return id;
  };
  const f = await fixture({}, runtime);
  try {
    const pending = f.coordinator.submitGuidance(
      f.root.id,
      "late",
      "correction",
    );
    runtime.complete();
    await settle();
    f.coordinator.submitInput(f.root.id, "next", "next work");
    await settle();
    assert.equal(runtime.starts.length, 2);
    release();
    const receipt = await pending;
    assert.equal(receipt.turn_id, runtime.starts[0]!.turnId);
    assert.equal(receipt.state, "delivered");
    assert.equal(f.coordinator.store.agent(f.root.id).turns, 2);
  } finally {
    release();
    await f.close();
  }
});
test("immediate pause during a lost start-ACK window interrupts once the Turn ID arrives", async () => {
  const runtime = new SteeringRuntime();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const original = runtime.startTurn.bind(runtime);
  runtime.startTurn = async (...args) => {
    const id = await original(...args);
    await gate;
    return id;
  };
  const f = await fixture({}, runtime);
  try {
    assert.equal(f.coordinator.store.attempts(f.root.id)[0]!.state, "starting");
    await f.coordinator.control(f.root.id, "pause", "subtree", true);
    assert.equal(runtime.interrupts.length, 0);
    release();
    await settle();
    assert.equal(runtime.interrupts.length, 1);
    assert.equal(runtime.starts.length, 1);
    assert.equal(f.coordinator.store.agent(f.root.id).desired, "paused");
  } finally {
    release();
    await f.close();
  }
});
