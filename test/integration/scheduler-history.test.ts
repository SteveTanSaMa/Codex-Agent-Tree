import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import { rootSettings } from "../../src/storage/interaction.ts";
import { ControlledRuntime } from "../fixtures/controlled-runtime.ts";

async function until(check: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, "independent preflight was blocked");
    await new Promise((r) => setTimeout(r, 5));
  }
}
test("bounded preflight dispatches independent ready Agents while one RPC remains held, without exceeding tree admission", async () => {
  const dir = mkdtempSync("/tmp/cat-rpc-fair-");
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  class Runtime extends ControlledRuntime {
    pending = 0;
    peak = 0;
    override async readThread(threadId: string) {
      this.peak = Math.max(this.peak, ++this.pending);
      try {
        if (threadId === "thread-1") await gate;
        return await super.readThread(threadId);
      } finally {
        this.pending--;
      }
    }
  }
  const runtime = new Runtime();
  const c = new Coordinator(
    {
      stateDirectory: dir,
      runtimeHome: join(dir, "h"),
      expectedVersion: "fixture",
    },
    runtime,
  );
  let starting: Promise<void> | undefined;
  try {
    const root = c.store.createRoot(
      "Slow",
      "slow",
      rootSettings({ concurrent: 1 }).limits,
    );
    const binding = c.store.bind(root.id, "thread-1", "fixture");
    runtime.threads = 1;
    c.store.prepare(root.id, "slow");
    for (let n = 0; n < 2; n++)
      c.store.createRoot(
        `Fast${n}`,
        "fast",
        rootSettings({ concurrent: 1 }).limits,
      );
    starting = c.start();
    await until(() => runtime.starts.length === 2);
    assert.ok(runtime.starts.every((t) => t.threadId !== binding.thread_id));
    assert.ok(runtime.peak <= 3);
    release();
    await starting;
    assert.equal(runtime.starts.length, 3);
    assert.equal(new Set(runtime.starts.map((t) => t.attemptId)).size, 3);
  } finally {
    release();
    await starting;
    await c.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status and view page 1000 historical Turns and 10000 messages without materializing full histories", async () => {
  const dir = mkdtempSync("/tmp/cat-history-scale-");
  const runtime = new ControlledRuntime();
  const c = new Coordinator(
    {
      stateDirectory: dir,
      runtimeHome: join(dir, "h"),
      expectedVersion: "fixture",
    },
    runtime,
  );
  try {
    const root = c.store.createRoot("Lead", "work", rootSettings({}).limits);
    const db = c.store.db;
    const agents = [root.id];
    for (let n = 1; n < 20; n++) {
      const id = `fixture-member-${n}`;
      db.prepare(
        "INSERT INTO agents(id,tree_id,parent_id,name,role,task,depth,capacity,turns,created_at) VALUES(?,?,?,?,?,?,1,0,50,?)",
      ).run(
        id,
        root.tree_id,
        root.id,
        id,
        "worker",
        "completed historical fixture",
        new Date(0).toISOString(),
      );
      db.prepare("INSERT INTO work_epochs VALUES(?,0,1)").run(id);
      agents.push(id);
    }
    db.prepare("UPDATE agents SET turns=50 WHERE id=?").run(root.id);
    const insert = db.prepare(
      "INSERT INTO turn_attempts(id,agent_id,thread_id,binding_generation,owner_generation,state,input,trace_id,reserved,observed,result,created_at) VALUES(?,?,?,1,1,'completed',?,'fixture',1,NULL,'done',?)",
    );
    const msg = db.prepare(
      "INSERT INTO operator_messages(id,recipient_id,input_key,body,status,created_at) VALUES(?,?,?,?,'processed',?)",
    );
    db.exec("BEGIN");
    for (let n = 0; n < 1000; n++)
      insert.run(
        `attempt-${String(n).padStart(4, "0")}`,
        agents[n % agents.length]!,
        "thread",
        "fixture input ".repeat(50),
        new Date(n).toISOString(),
      );
    db.exec(
      "INSERT INTO attempt_accounting(attempt_id,charged,finalized) SELECT id,0,0 FROM turn_attempts",
    );
    for (let n = 0; n < 10000; n++)
      msg.run(
        `message-${n}`,
        agents[n % agents.length]!,
        `input-${n}`,
        "fixture message ".repeat(100),
        new Date(n).toISOString(),
      );
    db.exec("COMMIT");
    db.prepare("UPDATE agents SET reserved=50 WHERE tree_id=?").run(
      root.tree_id,
    );
    const oldAttempts = c.store.attempts.bind(c.store),
      oldMessages = c.store.messages.bind(c.store);
    c.store.attempts = (id, limit) => {
      assert.ok(limit !== undefined, "unbounded attempt history read");
      return oldAttempts(id, limit);
    };
    c.store.messages = (id, limit) => {
      assert.ok(limit !== undefined, "unbounded message history read");
      return oldMessages(id, limit);
    };
    const status = c.status(root.id);
    assert.equal(status.attemptCount, 50);
    assert.equal(status.attempts.length, 20);
    assert.equal(status.messageCount, 500);
    assert.equal(status.messages.length, 50);
    assert.equal(status.budget.unknownUsageAttemptCount, 1000);
    assert.equal(status.budget.unknownUsageAttempts.length, 100);
    assert.equal(status.budget.unknownUsageTruncated, true);
    const view = c.view(root.id);
    assert.equal(view.agents.length, 20);
    assert.equal(
      view.agents.reduce((n, a) => n + a.attemptCount, 0),
      1000,
    );
    assert.equal(
      view.agents.reduce((n, a) => n + a.messages.processed, 0),
      10000,
    );
    c.store.attempts = oldAttempts;
    c.store.messages = oldMessages;
  } finally {
    await c.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("new arrivals during a held preflight are retained and dispatch on the next wave", async () => {
  const dir = mkdtempSync("/tmp/cat-wave-arrival-");
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let held = false;
  class Runtime extends ControlledRuntime {
    override async readThread(id: string) {
      if (id === "thread-1") {
        held = true;
        await gate;
      }
      return super.readThread(id);
    }
  }
  const runtime = new Runtime();
  const c = new Coordinator(
    { stateDirectory: dir, runtimeHome: join(dir, "h") },
    runtime,
  );
  let starting: Promise<void> | undefined;
  try {
    const root = c.store.createRoot(
      "Held",
      "work",
      rootSettings({ concurrent: 1 }).limits,
    );
    c.store.bind(root.id, "thread-1", "fixture");
    runtime.threads = 1;
    c.store.prepare(root.id, "work");
    starting = c.start();
    await until(() => held);
    const arrival = c.createRoot(
      "Arrival",
      "work",
      rootSettings({ concurrent: 1 }).limits,
    );
    const arrived = performance.now();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      c.store.attempts(arrival.id).length,
      0,
      "current wave deliberately retains its snapshot",
    );
    release();
    await starting;
    await until(() => runtime.starts.length === 2);
    assert.equal(c.store.attempts(arrival.id).length, 1);
    assert.ok(performance.now() - arrived >= 100);
    assert.equal(new Set(runtime.starts.map((t) => t.attemptId)).size, 2);
  } finally {
    release();
    await starting;
    await c.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
