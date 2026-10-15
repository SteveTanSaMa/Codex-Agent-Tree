import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../../src/storage/store.ts";
import { runtimeEnvironment } from "../../src/runtime/codex/adapter.ts";
const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

test(
  "native CLI task JSON, CAS, view and cursor waiting survive restart without calling a model",
  { skip: process.env.CAT_TEST_NATIVE !== "1", timeout: 100000 },
  async () => {
    const home = mkdtempSync("/tmp/cat-task-cli-");
    const state = join(home, "team");
    const call = async (...args: string[]) =>
      JSON.parse(
        (
          await execute(process.execPath, [cli, ...args, "--state", state], {
            timeout: 70000,
          })
        ).stdout,
      ) as Record<string, unknown>;
    try {
      await call("init", "--runtime-home", home);
      const seed = new Store(join(state, "business.sqlite"));
      const root = seed.createRoot("A", "paused fixture: no model dispatch", {
        tokens: 1000,
        maxDepth: 1,
        maxAgents: 2,
        maxConcurrentTurns: 1,
        maxTurnsPerAgent: 4,
        turnReservation: 100,
      });
      seed.control(null, root.id, "pause", "agent");
      seed.close();
      await call("start");
      const before = await call("view", "--target", root.id);
      const file = join(home, "task input.json");
      const description =
        'Literal "quotes"\n$(touch never-execute) `text` $HOME';
      writeFileSync(
        file,
        JSON.stringify({ requestKey: "one", subject: "task", description }),
      );
      const created = await call(
        "task-create",
        "--target",
        root.id,
        "--input-file",
        file,
      );
      assert.equal(created.description, description);
      const claim = await call(
        "task-update",
        "--target",
        root.id,
        "--task-id",
        String(created.id),
        "--key",
        "claim",
        "--revision",
        "1",
        "--action",
        "claim",
      );
      assert.equal(claim.revision, 2);
      const done = await call(
        "task-update",
        "--target",
        root.id,
        "--task-id",
        String(created.id),
        "--key",
        "done",
        "--revision",
        "2",
        "--action",
        "complete",
        "--result",
        "42",
      );
      assert.equal(done.status, "completed");
      await assert.rejects(
        call(
          "task-update",
          "--target",
          root.id,
          "--task-id",
          String(created.id),
          "--key",
          "stale",
          "--revision",
          "1",
          "--action",
          "claim",
        ),
        /revision is 3/,
      );
      const changed = await call(
        "wait",
        "--target",
        root.id,
        "--after",
        String(before.cursor),
        "--timeout-ms",
        "0",
      );
      assert.equal(changed.reason, "changed");
      const view = await call("view", "--target", root.id);
      assert.equal(
        (
          await call(
            "wait",
            "--target",
            root.id,
            "--after",
            String(view.cursor),
          )
        ).reason,
        "noProgress",
      );
      assert.equal(
        (
          await call(
            "task-get",
            "--target",
            root.id,
            "--task-id",
            String(created.id),
          )
        ).result,
        "42",
      );
      await call("stop");
      await call("start");
      const after = await call("view", "--target", root.id);
      assert.equal(after.cursor, view.cursor);
      assert.equal((after.tasks as { id: string }[])[0]?.id, created.id);
      assert.equal(
        (after.agents as { desired: string; attemptCount: number }[])[0]
          ?.desired,
        "paused",
      );
      assert.equal(
        (after.agents as { attemptCount: number }[])[0]?.attemptCount,
        0,
      );
    } finally {
      try {
        if (existsSync(join(state, "control.sock"))) await call("stop");
      } finally {
        try {
          await execute("codex", ["app-server", "daemon", "stop"], {
            env: runtimeEnvironment(home),
            timeout: 30000,
          });
        } finally {
          if (existsSync(join(home, "auth.json")))
            unlinkSync(join(home, "auth.json"));
        }
      }
    }
  },
);
