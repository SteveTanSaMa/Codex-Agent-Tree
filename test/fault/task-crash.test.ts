import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../src/storage/store.ts";

test(
  "SIGKILL inside task creation rolls back task, scopes, request key and event as one transaction",
  { timeout: 15000 },
  async () => {
    const directory = mkdtempSync("/tmp/cat-task-crash-");
    const path = join(directory, "business.sqlite");
    const child = fork(
      fileURLToPath(
        new URL("../fixtures/task-crash-writer.ts", import.meta.url),
      ),
      [path],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    let rootId = "";
    try {
      rootId = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                "Task writer never reached the owned transaction checkpoint",
              ),
            ),
          8000,
        );
        child.once("message", (value: { phase?: string; rootId?: string }) => {
          clearTimeout(timer);
          assert.equal(value.phase, "inside-task-transaction");
          resolve(value.rootId!);
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const observer = new DatabaseSync(path, { readOnly: true });
      try {
        assert.equal(
          observer.prepare("SELECT COUNT(*) AS n FROM tasks").get()?.n,
          0,
        );
      } finally {
        observer.close();
      }
      child.kill("SIGKILL");
      await exited;
      const recovered = new Store(path);
      try {
        assert.equal(recovered.agent(rootId).id, rootId);
        assert.equal(recovered.tasks.list(null, rootId).length, 0);
        assert.equal(
          recovered.db.prepare("SELECT COUNT(*) AS n FROM task_requests").get()
            ?.n,
          0,
        );
        assert.equal(
          recovered.db.prepare("SELECT COUNT(*) AS n FROM task_scopes").get()
            ?.n,
          0,
        );
        assert.equal(
          recovered.events(rootId).filter((e) => e.kind === "task.created")
            .length,
          0,
        );
        recovered.db.exec("DROP TRIGGER pause_task");
        const task = recovered.tasks.create(null, rootId, {
          requestKey: "retry",
          subject: "task",
          description: "atomic task creation",
          writeScopes: ["src"],
        });
        assert.equal(task.revision, 1);
        assert.equal(
          recovered.events(rootId).filter((e) => e.kind === "task.created")
            .length,
          1,
        );
      } finally {
        recovered.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
