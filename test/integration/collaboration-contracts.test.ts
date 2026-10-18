import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import { Store } from "../../src/storage/store.ts";
import { rootSettings } from "../../src/storage/interaction.ts";
import {
  WorkspaceBroker,
  workspacePolicy,
} from "../../src/workspace/broker.ts";
import { reserveScenario } from "../fixtures/gap-real.ts";
import { ControlledRuntime } from "../fixtures/controlled-runtime.ts";

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "fixture condition did not settle");
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}
class Runtime extends ControlledRuntime {
  steers: string[] = [];
  async steerTurn(thread: string, _turn: string, _input: string, _id: string) {
    this.steers.push(thread);
    return this.starts.findLast((s) => s.threadId === thread)!.turnId;
  }
}
async function fixture() {
  const dir = mkdtempSync("/tmp/cat-collab-");
  const runtime = new Runtime();
  const c = new Coordinator(
    {
      stateDirectory: dir,
      runtimeHome: join(dir, "h"),
      expectedVersion: "fixture",
    },
    runtime,
  );
  await c.start();
  const settings = rootSettings({ maxAgents: 3, concurrent: 3 });
  const root = c.createRoot(
    "Lead",
    "initial",
    settings.limits,
    "root",
    settings.policy,
  );
  await until(() => runtime.starts.length === 1);
  return {
    dir,
    runtime,
    c,
    root,
    async close() {
      await c.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("queued status visibility does not authorize ACK; drain pause preserves the queued assignment", async () => {
  const f = await fixture();
  try {
    const result = await f.c.submitGuidance(
      f.root.id,
      "later",
      "VISIBLE_BUT_NOT_DELIVERED",
      "queue",
    );
    const message = f.c
      .status(f.root.id)
      .messages.find((m) => m.id === result.message_id)!;
    assert.equal(message.body, "VISIBLE_BUT_NOT_DELIVERED");
    assert.equal(message.status, "queued");
    assert.equal(message.attempt_id, null);
    const t = f.c.store.attempts(f.root.id)[0]!;
    const actor = f.c.store.authenticate(t.thread_id, t.turn_id!, 1);
    assert.throws(
      () => f.c.store.acknowledge(actor, [message.id]),
      /delivered|current|Message|message/,
    );
    await f.c.control(f.root.id, "pause");
    f.runtime.complete(0);
    await until(() => f.c.store.attempts(f.root.id)[0]!.state === "completed");
    assert.equal(f.runtime.starts.length, 1);
    assert.equal(f.c.store.messages(f.root.id)[0]!.status, "queued");
    const binding = f.c.store.binding(f.root.id);
    await f.c.control(f.root.id, "resume");
    await until(() => f.runtime.starts.length === 2);
    assert.match(f.runtime.starts[1]!.input, /VISIBLE_BUT_NOT_DELIVERED/);
    assert.deepEqual(f.c.store.binding(f.root.id), binding);
  } finally {
    await f.close();
  }
});

test("cancel then resume does not revive a superseded queued assignment", async () => {
  const f = await fixture();
  try {
    await f.c.submitGuidance(
      f.root.id,
      "old",
      "OLD_SCOPE_SHOULD_NOT_RUN",
      "queue",
    );
    await f.c.control(f.root.id, "cancel");
    f.runtime.complete(0);
    await until(() => f.c.store.attempts(f.root.id)[0]!.state === "completed");
    assert.equal(f.c.store.messages(f.root.id)[0]!.status, "cancelled");
    await f.c.control(f.root.id, "resume");
    assert.equal(f.runtime.starts.length, 1);
    await f.c.submitGuidance(
      f.root.id,
      "replacement",
      "NEW_SCOPE_ONLY",
      "queue",
    );
    await until(() => f.runtime.starts.length === 2);
    assert.match(f.runtime.starts[1]!.input, /NEW_SCOPE_ONLY/);
    assert.doesNotMatch(f.runtime.starts[1]!.input, /OLD_SCOPE_SHOULD_NOT_RUN/);
    assert.equal(f.c.store.agent(f.root.id).turns, 2);
  } finally {
    await f.close();
  }
});

test("steering Lead is not descendant broadcast; subtree pause fences both active Turns", async () => {
  const f = await fixture();
  try {
    const t = f.c.store.attempts(f.root.id)[0]!;
    f.runtime.onRequest({
      id: "spawn-child",
      method: "item/tool/call",
      connectionGeneration: 1,
      params: {
        threadId: t.thread_id,
        turnId: t.turn_id!,
        tool: "agent_spawn",
        arguments: {
          requestKey: "child",
          name: "Child",
          role: "worker",
          task: "work",
        },
      },
    });
    await until(() => f.runtime.starts.length === 2);
    const child = f.c.store.agents(f.root.tree_id).find((a) => a.depth === 1)!;
    await f.c.submitGuidance(f.root.id, "scope-change", "Lead correction");
    assert.deepEqual(f.runtime.steers, [t.thread_id]);
    assert.equal(f.c.store.messages(child.id).length, 0);
    await f.c.control(f.root.id, "pause", "subtree", true);
    assert.equal(f.c.store.agent(f.root.id).desired, "paused");
    assert.equal(f.c.store.agent(child.id).desired, "paused");
    f.runtime.complete(0);
    f.runtime.complete(1);
    await until(() =>
      f.c.store.attempts().every((a) => a.state === "completed"),
    );
    assert.equal(f.runtime.starts.length, 2);
  } finally {
    await f.close();
  }
});

test("tree usage reminders and task budgets survive child activity, check-in and restart independently", () => {
  const dir = mkdtempSync("/tmp/cat-collab-usage-");
  const path = join(dir, "business.sqlite");
  let s = new Store(path);
  try {
    const p = rootSettings({ taskTokenBudget: 700, tokenAlertAt: 500 });
    const root = s.createRoot("Lead", "work", p.limits);
    s.interaction.configure(root.id, p.policy);
    const run = (id: string) => {
      const b = s.bind(id, "thread-" + id, "fixture");
      const t = s.prepare(id, "work");
      s.markStarting(t.id);
      s.attachTurn(t.id, b.generation, "turn-" + id);
      return s.attempt(t.id);
    };
    const a = run(root.id);
    const actor = s.authenticate(a.thread_id, a.turn_id!, 1);
    const child = s.spawn(actor, "child", {
      name: "Child",
      role: "worker",
      task: "work",
    });
    const b = run(child.id);
    s.observeNativeUsage(a.id, 1, 280);
    s.observeNativeUsage(b.id, 1, 220);
    assert.equal(
      s.events(root.id).filter((e) => e.kind === "usage.reminder").length,
      1,
    );
    s.interaction.evaluate(root.id, true, 500, 1000);
    s.interaction.checkIn(root.id, 2000);
    s.close();
    s = new Store(path);
    s.observeNativeUsage(b.id, 1, 220);
    s.observeNativeUsage(b.id, 1, 440);
    assert.equal(
      s.events(root.id).filter((e) => e.kind === "usage.reminder").length,
      1,
    );
    assert.equal(s.reminders.summary(root.id, "tree").metrics.totalTokens, 720);
    assert.equal(s.interaction.evaluate(root.id, true, 720, 2100).pause, true);
    assert.equal(s.agent(root.id).turns, 1);
    assert.equal(s.agent(child.id).turns, 1);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a committed self-contained test runs in a child while a Lead-only uncommitted entrypoint does not leak", async () => {
  const dir = mkdtempSync("/tmp/cat-collab-tests-");
  const repo = join(dir, "repo");
  mkdirSync(repo);
  mkdirSync(join(repo, "test"));
  const git = (args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git(["init"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repo, "value.mjs"), "export const value=42;\n");
  writeFileSync(
    join(repo, "test/unit.test.mjs"),
    "import {test} from 'node:test';import assert from 'node:assert/strict';import{value}from '../value.mjs';test('actual child assertion',()=>assert.equal(value,42));\n",
  );
  git(["add", "."]);
  git(["commit", "-m", "fixture"]);
  mkdirSync(join(dir, "s"));
  const policy = workspacePolicy(repo, {
    unit: {
      executable: process.execPath,
      args: ["--test", "test/unit.test.mjs"],
    },
    missing: {
      executable: process.execPath,
      args: ["--test", "test/lead-only.mjs"],
    },
  });
  const store = new Store(join(dir, "s", "business.sqlite"));
  store.configureWorkspace(policy);
  const lead = store.createRoot("Lead", "fixture", rootSettings({}).limits);
  const binding = store.bind(lead.id, "fixture-thread", "fixture");
  const attempt = store.prepare(lead.id, "fixture");
  store.markStarting(attempt.id);
  store.attachTurn(attempt.id, binding.generation, "fixture-turn");
  const child = store.spawn(
    store.authenticate(binding.thread_id, "fixture-turn", binding.generation),
    "child",
    { name: "Child", role: "worker", task: "fixture" },
  );
  const broker = new WorkspaceBroker(
    join(dir, "s"),
    policy,
    (id) => store.agent(id),
    (id) => store.workspaceAssignment(id),
  );
  writeFileSync(
    join(repo, "test/lead-only.mjs"),
    "throw new Error('this uncommitted entry must not be copied');\n",
  );
  try {
    const missing = (await broker.call(child, "run_test", {
      name: "missing",
    })) as Record<string, unknown>;
    assert.notEqual(missing.exitCode, 0);
    assert.equal(
      existsSync(join(broker.cwd(child), "test/lead-only.mjs")),
      false,
    );
    const good = (await broker.call(child, "run_test", {
      name: "unit",
    })) as Record<string, unknown>;
    assert.equal(good.exitCode, 0);
    assert.match(String(good.output), /actual child assertion/);
    assert.match(
      readFileSync(join(repo, "test/lead-only.mjs"), "utf8"),
      /must not be copied/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("qualification admission is retained before launch and blocks a repeat even without a returned identity", () => {
  const dir = mkdtempSync("/tmp/cat-qualification-slot-");
  try {
    reserveScenario(dir, 10);
    const first = readFileSync(join(dir, "admission.json"), "utf8");
    assert.throws(() => reserveScenario(dir, 10), { code: "EEXIST" });
    assert.equal(readFileSync(join(dir, "admission.json"), "utf8"), first);
    assert.equal(existsSync(join(dir, "identity.json")), false);
    const legacy = join(dir, "legacy");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "identity.json"), "{}");
    assert.throws(() => reserveScenario(legacy, 3), /already ran/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
