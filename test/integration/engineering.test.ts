import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../../src/storage/store.ts";
import { rootSettings } from "../../src/storage/interaction.ts";
import { diagnose } from "../../src/cli/diagnose.ts";
import { sandboxCommand } from "../../src/workspace/sandbox.ts";
const execute = promisify(execFile);
test("diagnose reads unknown execution, command receipts and incomplete worktrees without acquiring an owner or changing evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "cat-diagnose-"));
  const path = join(dir, "business.sqlite");
  const s = new Store(path);
  const root = s.createRoot("A", "work", rootSettings({}).limits);
  s.bind(root.id, "thread", "fixture");
  const a = s.prepare(root.id, "work");
  s.markStarting(a.id);
  s.uncertain(a.id, "ACK lost");
  s.db
    .prepare(
      "INSERT INTO workspace_commands VALUES(?,?,'fixture','accepted',NULL,?)",
    )
    .run(root.id, "call", new Date().toISOString());
  s.close();
  try {
    mkdirSync(join(dir, "workspaces", "orphan"), { recursive: true });
    writeFileSync(join(dir, "workspaces", "orphan", ".git"), "gitdir: missing");
    const before = readFileSync(path);
    const report = diagnose(dir);
    assert.equal(report.unknownAttempts.length, 1);
    assert.equal(report.unknownCommands.length, 1);
    assert.equal(report.worktrees.length, 1);
    assert.deepEqual(readFileSync(path), before);
    assert.equal(report.readOnly, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test(
  "explicit test TCP endpoint permits only the configured service, preserving default network denial",
  { skip: process.platform !== "darwin" },
  async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "cat-network-")));
    const server = createServer((_q, r) => r.end("allowed"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const args = [
      "-e",
      `require('node:http').get('http://127.0.0.1:${port}',r=>{r.resume();r.on('end',()=>console.log('reached'))}).on('error',()=>process.exit(7))`,
    ];
    const run = async (endpoints?: { address: string; port: number }[]) => {
      const cmd = sandboxCommand(
        {
          executable: process.execPath,
          args,
          ...(endpoints ? { networkEndpoints: endpoints } : {}),
        },
        dir,
        dir,
      );
      return execute(cmd.executable, cmd.args, {
        timeout: 5000,
        env: { PATH: process.env.PATH, HOME: dir, OPENSSL_CONF: "/dev/null" },
      });
    };
    try {
      await assert.rejects(run());
      assert.match(
        (await run([{ address: "127.0.0.1", port }])).stdout,
        /reached/,
      );
      await assert.rejects(
        run([
          { address: "127.0.0.1", port: port === 65535 ? port - 1 : port + 1 },
        ]),
      );
      assert.throws(
        () =>
          sandboxCommand(
            {
              executable: process.execPath,
              args,
              networkEndpoints: [{ address: 'x") (allow network*)', port: 80 }],
            },
            dir,
            dir,
          ),
        /IPv4/,
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("schema 13 completed tasks gain archive metadata without rewriting receipts, history or dependencies", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "cat-archive-upgrade-"));
  const path = join(dir, "business.sqlite");
  let s = new Store(path);
  try {
    const root = s.createRoot("A", "work", rootSettings({}).limits);
    let t = s.tasks.create(null, root.id, {
      requestKey: "create",
      subject: "old",
      description: "retained",
    });
    t = s.tasks.update(null, root.id, {
      requestKey: "claim",
      taskId: t.id,
      expectedRevision: t.revision,
      action: "claim",
    });
    const done = {
      requestKey: "done",
      taskId: t.id,
      expectedRevision: t.revision,
      action: "complete",
      result: "original",
    };
    t = s.tasks.update(null, root.id, done);
    s.close();
    const old = new DatabaseSync(path);
    old.exec(
      "DROP TABLE task_archives;UPDATE schema_version SET version=13;UPDATE task_requests SET response_json=json_remove(response_json,'$.archivedAt')",
    );
    const receipt = JSON.parse(
      String(
        old
          .prepare(
            "SELECT response_json FROM task_requests WHERE request_key='done'",
          )
          .get()!.response_json,
      ),
    );
    const events = old.prepare("SELECT COUNT(*) AS n FROM events").get()!.n;
    old.close();
    s = new Store(path);
    assert.equal(
      s.db.prepare("SELECT version FROM schema_version").get()!.version,
      15,
    );
    assert.ok(s.tasks.get(null, root.id, t.id).archivedAt);
    assert.equal(
      s.db.prepare("SELECT COUNT(*) AS n FROM events").get()!.n,
      events,
    );
    assert.deepEqual(s.tasks.update(null, root.id, done), receipt);
    assert.equal(
      s.tasks.create(null, root.id, {
        requestKey: "dependent",
        subject: "new",
        description: "new",
        blockedBy: [t.id],
      }).ready,
      true,
    );
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
