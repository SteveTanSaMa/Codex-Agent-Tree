// Stateful local Runtime simulation: real Coordinator, SQLite and workspace broker; no Codex executable.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import { workspacePolicy } from "../../src/workspace/broker.ts";
import { rootSettings } from "../../src/storage/interaction.ts";
import { ControlledRuntime } from "../../test/fixtures/controlled-runtime.ts";
const [directory, profile, roundsText = "1000"] = process.argv.slice(2);
const dir = resolve(directory),
  total = Number(roundsText);
assert.ok(["normal", "recovery", "conflict"].includes(profile));
assert.ok(total > 0 && total <= 1000);
mkdirSync(dir, { recursive: true });
const repo = join(dir, "repo"),
  state = join(dir, "state"),
  home = join(dir, "home");
mkdirSync(repo);
mkdirSync(home);
const git = (...args) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
git("init");
git("config", "user.name", "Local stress");
git("config", "user.email", "fixture@example.invalid");
writeFileSync(join(repo, "value.txt"), "0\n");
writeFileSync(
  join(repo, "verify.cjs"),
  "const fs=require('node:fs');if(!/^\\d+\\n$/.test(fs.readFileSync('value.txt','utf8')))throw Error('invalid value');if(process.argv.includes('hold'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);\n",
);
git("add", ".");
git("commit", "-m", "fixture");
const policy = workspacePolicy(repo, {
  unit: { executable: process.execPath, args: ["verify.cjs"] },
  hold: { executable: process.execPath, args: ["verify.cjs", "hold"] },
});
const options = {
  stateDirectory: state,
  runtimeHome: home,
  expectedVersion: "simulation",
  workspace: policy,
};
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({
    profile,
    runtime: "controlled-local",
    codexExecutable: null,
  }),
);
const started = Date.now();
let c,
  completed = 0,
  recoveries = 0,
  rejections = 0,
  requestId = 0,
  failure,
  abort = false;
process.on("SIGTERM", () => (abort = true));
const pending = new Map();
class Runtime extends ControlledRuntime {
  failNext = false;
  async startTurn(threadId, input, attemptId) {
    const id = await super.startTurn(threadId, input, attemptId);
    if (this.failNext) {
      this.failNext = false;
      throw Error("injected lost start ACK after acceptance");
    }
    return id;
  }
  async readThread(threadId) {
    const v = await super.readThread(threadId);
    for (const t of v.thread.turns) {
      const s = this.starts.find((s) => s.turnId === t.id);
      t.items = [
        {
          type: "userMessage",
          content: [
            {
              type: "inputText",
              text: `[AgentTree attempt ${s.attemptId}]\n${s.input}`,
            },
          ],
        },
      ];
    }
    return v;
  }
  respond(r, v) {
    super.respond(r, v);
    pending.get(r.id)?.(v);
    pending.delete(r.id);
  }
  respondError(r, code, message) {
    this.respond(r, {
      success: false,
      contentItems: [{ text: `${code}: ${message}` }],
    });
  }
}
const runtime = new Runtime();
const socket = createServer((s) => s.end("local-simulation-status\n"));
await new Promise((r) => socket.listen(0, "127.0.0.1", r));
const port = socket.address().port;
const output = (name, v) =>
  writeFileSync(join(dir, name), JSON.stringify(v, null, 2) + "\n");
const snapshot = () => ({
  profile,
  runtime: "controlled-local-no-cli",
  phase: failure ? "failed" : "running",
  pid: process.pid,
  port,
  roundsRequested: total,
  completedRounds: completed,
  recoveries,
  expectedRejections: rejections,
  elapsedMs: Date.now() - started,
  state,
  home,
  repo,
  failure,
});
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!fn()) {
    assert.ok(!abort, "operator stop");
    assert.ok(Date.now() < end, label);
    await new Promise((r) => setTimeout(r, 1));
  }
}
const active = (id) => {
  assert.equal(typeof id, "string");
  return c.store.attempts(id).find((a) => a.state === "running");
};
async function running(id) {
  await until(() => active(id), "no active Attempt");
  return active(id);
}
async function invoke(agent, tool, args, allow = false) {
  const a = await running(agent);
  const id = ++requestId;
  const promise = new Promise((yes, no) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      no(Error("tool response timed out"));
    }, 15000);
    pending.set(id, (v) => {
      clearTimeout(timer);
      yes(v);
    });
  });
  runtime.onRequest({
    id,
    method: "item/tool/call",
    connectionGeneration: 1,
    params: {
      threadId: a.thread_id,
      turnId: a.turn_id,
      callId: "sim-" + id,
      tool,
      arguments: args,
    },
  });
  const v = await promise;
  if (!allow) assert.equal(v.success, true, JSON.stringify(v));
  return v.success ? JSON.parse(v.contentItems[0].text) : v;
}
async function finish(id) {
  const a = await running(id);
  const i = runtime.starts.findIndex((t) => t.turnId === a.turn_id);
  assert.ok(i >= 0);
  runtime.complete(i);
  await until(
    () => c.store.attempt(a.id).state === "completed",
    "completion not committed",
  );
}
async function ack(id) {
  const a = await running(id);
  const ids = c.store.db
    .prepare(
      "SELECT id FROM messages WHERE attempt_id=? UNION ALL SELECT id FROM operator_messages WHERE attempt_id=?",
    )
    .all(a.id, a.id)
    .map((x) => x.id);
  if (ids.length) await invoke(id, "agent_ack", { messageIds: ids });
}
let root, worker, reviewer;
try {
  c = new Coordinator(options, runtime);
  root = c.store.createRoot("Lead", "bootstrap", rootSettings({}).limits);
  await c.start();
  worker = await invoke(root.id, "agent_spawn", {
    requestKey: "worker",
    name: "Coder",
    role: "coder",
    task: "bootstrap",
  });
  worker.id = worker.agentId;
  await finish(root.id);
  reviewer = await invoke(worker.id, "agent_spawn", {
    requestKey: "reviewer",
    name: "Reviewer",
    role: "reviewer",
    task: "bootstrap",
  });
  reviewer.id = reviewer.agentId;
  await finish(worker.id);
  await finish(reviewer.id);
  for (let n = 1; n <= total; n++) {
    assert.ok(!abort, "operator stop");
    if (profile === "recovery") runtime.failNext = true;
    c.submitInput(worker.id, "round-" + n, "Produce value " + n);
    if (profile === "recovery") {
      await until(
        () => c.store.attempts(worker.id).some((a) => a.state === "unknown"),
        "lost ACK must be unknown",
      );
      const before = c.store
          .attempts(worker.id)
          .find((a) => a.state === "unknown"),
        starts = runtime.starts.length;
      await c.stop();
      c = new Coordinator(options, runtime);
      await c.start();
      const after = await running(worker.id);
      assert.equal(after.id, before.id);
      assert.equal(runtime.starts.length, starts);
      assert.ok(after.turn_id);
      recoveries++;
    }
    await ack(worker.id);
    const old = await invoke(worker.id, "read_file", { path: "value.txt" });
    const write = {
      path: "value.txt",
      expectedHash: old.hash,
      content: n + "\n",
    };
    await invoke(worker.id, "write_file", write);
    await invoke(worker.id, "write_file", write); // same-content retry, no second effect
    if (profile === "conflict") {
      c.submitInput(reviewer.id, "round-" + n, "Read shared value " + n);
      await ack(reviewer.id);
      const command = invoke(worker.id, "run_test", { name: "hold" });
      await until(
        () =>
          c.store.db
            .prepare(
              "SELECT 1 FROM workspace_commands WHERE agent_id=? AND state='accepted'",
            )
            .get(worker.id),
        "command lock not accepted",
      );
      const refused = await invoke(
        reviewer.id,
        "read_file",
        { path: "value.txt" },
        true,
      );
      assert.equal(refused.success, false);
      assert.match(refused.contentItems[0].text, /STATE_BLOCKED/);
      rejections++;
      assert.equal((await command).exitCode, 0);
    } else {
      assert.equal(
        (await invoke(worker.id, "run_test", { name: "unit" })).exitCode,
        0,
      );
      c.submitInput(reviewer.id, "round-" + n, "Read shared value " + n);
      await ack(reviewer.id);
    }
    assert.equal(
      (await invoke(reviewer.id, "read_file", { path: "value.txt" })).content,
      n + "\n",
    );
    for (const member of [worker, reviewer]) {
      const msg = {
        requestKey: "report-" + n,
        target: root.id,
        message: JSON.stringify({ round: n, source: member.id, value: n }),
      };
      const first = await invoke(member.id, "agent_send", msg);
      const retry = await invoke(member.id, "agent_send", msg);
      assert.deepEqual(first, retry);
      await finish(member.id);
    }
    while (true) {
      await until(
        () =>
          active(root.id) ||
          c.store.messages(root.id).every((m) => m.status === "processed"),
        "Lead did not wake",
      );
      if (!active(root.id)) break;
      await ack(root.id);
      const oldRoot = await invoke(root.id, "read_file", { path: "value.txt" });
      await invoke(root.id, "write_file", {
        path: "value.txt",
        expectedHash: oldRoot.hash,
        content: n + "\n",
      });
      const a = active(root.id);
      let task = await invoke(root.id, "agent_task_create", {
        requestKey: "task-" + a.id,
        subject: "round-" + n,
        description: "Integrate verified patch",
      });
      for (const action of ["claim", "complete", "delete"])
        task = await invoke(root.id, "agent_task_update", {
          requestKey: action + "-" + task.id,
          taskId: task.id,
          expectedRevision: task.revision,
          action,
          ...(action === "complete" ? { result: "verified " + n } : {}),
        });
      await finish(root.id);
    }
    assert.equal(readFileSync(join(repo, "value.txt"), "utf8"), n + "\n");
    const db = c.store.db;
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE status!='processed'")
        .get().n,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM operator_messages WHERE status!='processed'",
        )
        .get().n,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM turn_attempts WHERE state!='completed'",
        )
        .get().n,
      0,
    );
    completed = n;
    if (n % 25 === 0 || n === total) output("status.json", snapshot());
  }
  const db = c.store.db;
  assert.equal(
    db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM (SELECT thread_id,turn_id,COUNT(*) AS n FROM turn_attempts GROUP BY thread_id,turn_id HAVING n>1)",
      )
      .get().n,
    0,
  );
  const attempts = db
    .prepare("SELECT state,COUNT(*) AS n FROM turn_attempts GROUP BY state")
    .all();
  assert.equal(
    runtime.starts.length,
    c.store.db.prepare("SELECT COUNT(*) AS n FROM turn_attempts").get().n,
  );
  assert.ok(
    runtime.starts.every((t) => t.completed),
    "simulated Runtime contains unfinished Turn",
  );
  for (const agent of c.store.agents()) {
    const thread = c.store.binding(agent.id).thread_id;
    assert.deepEqual(
      c.store
        .attempts(agent.id)
        .map((a) => a.turn_id)
        .sort(),
      runtime.starts
        .filter((t) => t.threadId === thread)
        .map((t) => t.turnId)
        .sort(),
    );
  }
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status!='deleted'").get()
      .n,
    0,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM workspace_commands WHERE state!='completed'",
      )
      .get().n,
    0,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind='tool.rejected'")
      .get().n,
    rejections,
  );
  output("result.json", {
    ...snapshot(),
    phase: "completed",
    attempts,
    tasks: db
      .prepare("SELECT status,COUNT(*) AS n FROM tasks GROUP BY status")
      .all(),
    messages: db
      .prepare("SELECT status,COUNT(*) AS n FROM messages GROUP BY status")
      .all(),
    inputs: db
      .prepare(
        "SELECT status,COUNT(*) AS n FROM operator_messages GROUP BY status",
      )
      .all(),
    nativeCliUsed: false,
    syntheticRuntime: true,
    integrity: "ok",
    runtimeStarts: runtime.starts.length,
  });
} catch (e) {
  failure = String(e.stack ?? e);
  output("result.json", { ...snapshot(), phase: "failed" });
  process.exitCode = 1;
} finally {
  await c?.stop();
  await new Promise((r) => socket.close(r));
  output("cleanup.json", {
    pid: process.pid,
    finishedAt: new Date().toISOString(),
    closed: true,
  });
}
