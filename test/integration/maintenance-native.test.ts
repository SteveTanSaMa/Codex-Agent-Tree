import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
import { Store } from "../../src/storage/store.ts";
import { rootSettings } from "../../src/storage/interaction.ts";
import { runtimeEnvironment } from "../../src/runtime/codex/adapter.ts";
const execute = promisify(execFile);
test(
  "native CLI host and Skill command wrapper persist handoff/integration receipts and expose offline maintenance without model Turns",
  { skip: process.env.CAT_TEST_NATIVE !== "1", timeout: 70000 },
  async () => {
    const directory = mkdtempSync("/tmp/cat-maint-native-"),
      repo = join(directory, "repo"),
      home = join(directory, "home"),
      state = join(directory, "state");
    const wrapper = resolve("scripts/cat.mjs");
    mkdirSync(repo);
    mkdirSync(home);
    const git = async (...args: string[]) =>
      (await execute("git", ["-C", repo, ...args])).stdout.trim();
    const call = async (...args: string[]) =>
      JSON.parse(
        (
          await execute(
            process.execPath,
            [wrapper, ...args, "--state", state],
            { timeout: 40000 },
          )
        ).stdout,
      );
    try {
      await git("init");
      await git("config", "user.name", "Fixture");
      await git("config", "user.email", "fixture@example.invalid");
      writeFileSync(join(repo, "file"), "fixture");
      await git("add", ".");
      await git("commit", "-m", "fixture");
      const sha = await git("rev-parse", "HEAD");
      await call("init", "--runtime-home", home, "--workspace", repo);
      const store = new Store(join(state, "business.sqlite"));
      const root = store.createRoot(
        "Lead",
        "No model execution",
        rootSettings({}).limits,
      );
      store.db
        .prepare("UPDATE work_epochs SET initial_enabled=0 WHERE agent_id=?")
        .run(root.id);
      store.close();
      await call("start");
      const input = join(directory, "handoff.json");
      writeFileSync(
        input,
        JSON.stringify({
          requestKey: "one",
          baseCommit: sha,
          commit: sha,
          validation: "No tests claimed",
        }),
      );
      const h = await call(
        "handoff-record",
        "--target",
        root.id,
        "--input-file",
        input,
      );
      const preview = await call(
        "handoff-preview",
        "--target",
        root.id,
        "--id",
        h.id,
      );
      assert.equal(preview.checkComplete, true);
      assert.equal(preview.retention.status, "verified");
      writeFileSync(
        input,
        JSON.stringify({
          requestKey: "result",
          handoffId: h.id,
          targetBaseline: sha,
          integrationCommit: sha,
          status: "unverified",
          validation: {
            command: "not run",
            result: "unverified",
            evidence: "none",
          },
        }),
      );
      const integration = await call(
        "integration-record",
        "--target",
        root.id,
        "--input-file",
        input,
      );
      assert.equal(integration.hostVerifiedSuccess, false);
      assert.deepEqual(
        await call(
          "integration-record",
          "--target",
          root.id,
          "--input-file",
          input,
        ),
        integration,
      );
      assert.equal(
        (await call("integration-history", "--target", root.id)).items.length,
        1,
      );
      assert.equal(
        (
          await call(
            "history-export",
            "--target",
            root.id,
            "--kind",
            "integrations",
          )
        ).items.length,
        1,
      );
      const usage = await call("capacity");
      assert.equal(usage.automaticCleanup, false);
      assert.equal(usage.artifacts.unreferenced.length, 0);
      assert.equal((await call("preflight")).ownerActive, true);
      assert.equal((await call("diagnose")).readOnly, true);
      assert.equal(
        (await call("task-history", "--target", root.id)).items.length,
        0,
      );
      assert.equal((await call("status", "--target", root.id)).attemptCount, 0);
      await call("stop");
      await call("start");
      assert.equal(
        (await call("integration-history", "--target", root.id)).items[0].id,
        integration.id,
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
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  },
);
