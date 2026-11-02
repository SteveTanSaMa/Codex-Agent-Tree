import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { scriptedProvider, response } from "../fixtures/scripted-provider.ts";
import { runtimeEnvironment } from "../../src/runtime/codex/adapter.ts";
const execute = promisify(execFile);
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 20000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "installed upgrade did not settle");
    await new Promise((r) => setTimeout(r, 30));
  }
}
test(
  "actual published Beta 3 ZIP upgrades to a separate candidate ZIP with native identities, queued work and edited worktrees intact",
  {
    skip:
      process.env.CAT_TEST_NATIVE !== "1" ||
      !process.env.CAT_TEST_BETA3_ZIP ||
      !process.env.CAT_TEST_CANDIDATE_ZIP ||
      !process.env.CAT_TEST_CODEX,
    timeout: 180000,
  },
  async () => {
    const executable = resolve(process.env.CAT_TEST_CODEX!);
    const upgradedExecutable = process.env.CAT_TEST_UPGRADE_CODEX
      ? resolve(process.env.CAT_TEST_UPGRADE_CODEX)
      : executable;
    let cleanupExecutable = executable;
    const env = {
      ...process.env,
      PATH: dirname(executable) + ":" + process.env.PATH,
    };
    const base = mkdtempSync("/tmp/cat-upgrade-"),
      repo = join(base, "r"),
      home = join(base, "h"),
      state = join(base, "s");
    mkdirSync(repo);
    const legacyZip = resolve(process.env.CAT_TEST_BETA3_ZIP!);
    const candidateZip = resolve(process.env.CAT_TEST_CANDIDATE_ZIP!);
    assert.equal(
      createHash("sha256").update(readFileSync(legacyZip)).digest("hex"),
      "b686db0a00c2c0febefcfaf100f62707cfc41ec812c5dcfe96d81f7271399ef8",
      "Expected the official published Beta 3 ZIP",
    );
    await execute("python3", [
      "-m",
      "zipfile",
      "-e",
      legacyZip,
      join(base, "legacy"),
    ]);
    const legacy = join(base, "legacy/codex-agent-tree");
    assert.equal(
      JSON.parse(readFileSync(join(legacy, "package.json"), "utf8")).version,
      "0.1.0-beta.3",
    );
    const git = (...args: string[]) => execute("git", ["-C", repo, ...args]);
    await git("init");
    await git("config", "user.name", "Upgrade fixture");
    await git("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(repo, "value"), "base");
    await git("add", ".");
    await git("commit", "-m", "fixture");
    const provider = await scriptedProvider(home, (_body, res, count) => {
      if (count === 1 || count === 3)
        response(
          res,
          {
            type: "function_call",
            id: `fc_${count}`,
            call_id: `call_${count}`,
            name: count === 1 ? "agent_spawn" : "write_file",
            arguments: JSON.stringify(
              count === 1
                ? {
                    requestKey: "coder",
                    name: "Coder",
                    role: "worker",
                    task: "Write the supplied value fixture",
                  }
                : {
                    path: "value",
                    expectedHash: createHash("sha256")
                      .update("base")
                      .digest("hex"),
                    content: "coder edit",
                  },
            ),
          },
          `resp_${count}`,
        );
      else
        response(
          res,
          {
            type: "message",
            id: `msg_${count}`,
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "UPGRADE_FIXTURE_DONE",
                annotations: [],
              },
            ],
          },
          `resp_${count}`,
        );
    });
    const call = async (skill: string, ...args: string[]) =>
      JSON.parse(
        (
          await execute(
            process.execPath,
            [join(skill, "scripts/cat.mjs"), ...args, "--state", state],
            {
              cwd: base,
              env: { ...env, [provider.credential.envKey]: "fixture-only" },
              timeout: 45000,
              maxBuffer: 4 * 1024 * 1024,
            },
          )
        ).stdout,
      );
    let current = legacy;
    const snapshot = () => {
      const db = new DatabaseSync(join(state, "business.sqlite"), {
        readOnly: true,
      });
      try {
        return JSON.parse(
          JSON.stringify(
            Object.fromEntries(
              [
                "agents",
                "trees",
                "agent_session_bindings",
                "turn_attempts",
                "operator_messages",
                "agent_workspaces",
                "workspace_commands",
                "tasks",
              ].map((t) => [
                t,
                db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),
              ]),
            ),
          ),
        );
      } finally {
        db.close();
      }
    };
    try {
      await execute(
        process.execPath,
        [join(legacy, "scripts/cat.mjs"), "setup"],
        { cwd: base, env, timeout: 60000 },
      );
      await call(
        legacy,
        "init",
        "--runtime-home",
        home,
        "--config-from",
        join(home, "config.toml"),
        "--provider-env",
        provider.credential.envKey,
        "--workspace",
        repo,
        "--executable",
        executable,
      );
      await call(legacy, "start");
      const root = await call(
        legacy,
        "root",
        "--key",
        "upgrade-root",
        "--task",
        "Spawn a coder once then finish",
        "--max-turns",
        "1",
        "--max-total-turns",
        "2",
        "--concurrent",
        "1",
      );
      await until(async () => {
        const s = snapshot();
        return (
          s.agents.length === 2 &&
          s.turn_attempts.length === 2 &&
          s.turn_attempts.every((a: any) => a.state === "completed")
        );
      });
      assert.equal(provider.bodies.length, 4);
      await call(
        legacy,
        "control",
        "--target",
        root.id,
        "--action",
        "pause",
        "--immediate",
      );
      await call(
        legacy,
        "send",
        "--target",
        root.id,
        "--key",
        "queued-before-upgrade",
        "--message",
        "OLD_QUEUED_ASSIGNMENT",
        "--delivery",
        "queue",
      );
      await call(
        legacy,
        "task-create",
        "--target",
        root.id,
        "--key",
        "old-task",
        "--subject",
        "OldTask",
        "--description",
        "Unfinished before upgrade",
      );
      await call(legacy, "stop");
      // Explicitly synthesize the durable remnant of a crash after command
      // acceptance. This tests migration/reconciliation of an unknown receipt;
      // it is not a claim that the legacy daemon experienced a real crash.
      const legacyDb = new DatabaseSync(join(state, "business.sqlite"));
      try {
        legacyDb.exec("BEGIN IMMEDIATE");
        legacyDb
          .prepare(
            "INSERT INTO workspace_commands VALUES(?,?,?,'accepted',NULL,?)",
          )
          .run(
            root.id,
            "unknown-upgrade-fixture",
            "fixture-fingerprint",
            new Date().toISOString(),
          );
        legacyDb
          .prepare("INSERT INTO work_refs VALUES('command',?,?,0)")
          .run("unknown-upgrade-fixture", root.id);
        legacyDb.exec("COMMIT");
      } finally {
        legacyDb.close();
      }
      const before = snapshot();
      const child = before.agents.find((a: any) => a.depth === 1);
      const statusCode = `const {WorkspaceBroker}=await import(${JSON.stringify(pathToFileURL(join(legacy, "src/workspace/broker.ts")).href)}); const fs=await import('node:fs');const cfg=JSON.parse(fs.readFileSync(${JSON.stringify(join(state, "config.json"))},'utf8'));const b=new WorkspaceBroker(cfg.stateDirectory,cfg.workspace,id=>(${JSON.stringify(before.agents[0])}));console.log(b.cwd(${JSON.stringify(child)}));`;
      const childPath = (
        await execute(
          process.execPath,
          ["--input-type=module", "-e", statusCode],
          { cwd: base },
        )
      ).stdout.trim();
      assert.equal(
        readFileSync(join(childPath, "value"), "utf8"),
        "coder edit",
      );
      assert.equal(readFileSync(join(repo, "value"), "utf8"), "base");
      cpSync(state, join(base, "backup"), { recursive: true });
      let configBefore = readFileSync(join(state, "config.json"), "utf8");
      const runtimeBefore = readFileSync(join(home, "config.toml"), "utf8");
      await execute("python3", [
        "-m",
        "zipfile",
        "-e",
        candidateZip,
        join(base, "new"),
      ]);
      current = join(base, "new/codex-agent-tree");
      await execute(
        process.execPath,
        [join(current, "scripts/cat.mjs"), "setup"],
        { cwd: base, env, timeout: 60000 },
      );
      if (upgradedExecutable !== executable) {
        // Stop only this completed fixture's native daemon before changing its
        // launcher. Keep the legacy expectedVersion field to exercise admission.
        await execute(executable, ["app-server", "daemon", "stop"], {
          env: runtimeEnvironment(home),
          timeout: 20000,
        });
        const cfg = JSON.parse(configBefore);
        cfg.executable = upgradedExecutable;
        configBefore = JSON.stringify(cfg, null, 2) + "\n";
        writeFileSync(join(state, "config.json"), configBefore, {
          mode: 0o600,
        });
        cleanupExecutable = upgradedExecutable;
      }
      if (upgradedExecutable !== executable) {
        await assert.rejects(call(current, "start"), /did not become ready/);
        await assert.rejects(
          execute(
            process.execPath,
            [join(current, "scripts/cat.mjs"), "serve", "--state", state],
            {
              cwd: base,
              env: { ...env, [provider.credential.envKey]: "fixture-only" },
              timeout: 15000,
            },
          ),
          /Launcher and running daemon differ/,
        );
        assert.equal(provider.bodies.length, 4);
        assert.deepEqual(snapshot(), before);
        // All fixture Turns are terminal. Use the official, explicit package
        // update; changing the launcher alone does not replace a managed daemon.
        await execute(
          upgradedExecutable,
          ["app-server", "daemon", "update", "--from-cli", "--yes"],
          {
            env: runtimeEnvironment(home, provider.credential),
            timeout: 30000,
          },
        );
      }
      const doctor = await call(current, "doctor");
      assert.equal(doctor.ok, true);
      assert.equal(doctor.checks.codex.policy, "capabilities-v1");
      try {
        await call(current, "start");
      } catch (error) {
        const diagnostic = await execute(
          process.execPath,
          [join(current, "scripts/cat.mjs"), "serve", "--state", state],
          {
            cwd: base,
            env: { ...env, [provider.credential.envKey]: "fixture-only" },
            timeout: 10000,
          },
        ).catch((e) => e);
        throw new Error(
          `${String(error)}\nFixture foreground startup: ${diagnostic.stderr}`,
        );
      }
      const migrated = snapshot();
      for (const [table, rows] of Object.entries(before) as [
        string,
        Record<string, unknown>[],
      ][]) {
        assert.equal(
          migrated[table].length,
          rows.length,
          `${table} row count changed during migration`,
        );
        for (let i = 0; i < rows.length; i++)
          for (const [field, value] of Object.entries(rows[i]!))
            assert.deepEqual(
              migrated[table][i][field],
              value,
              `${table}.${field} changed during migration`,
            );
      }
      assert.equal(
        readFileSync(join(state, "config.json"), "utf8"),
        configBefore,
      );
      assert.equal(
        readFileSync(join(home, "config.toml"), "utf8"),
        runtimeBefore,
      );
      assert.equal(
        readFileSync(join(childPath, "value"), "utf8"),
        "coder edit",
      );
      assert.equal(
        provider.bodies.length,
        4,
        "upgrade must not replay any native work",
      );
      assert.equal(
        migrated.workspace_commands.find(
          (r: any) => r.call_id === "unknown-upgrade-fixture",
        ).state,
        "accepted",
      );
      await call(current, "stop");
      const preBackup = snapshot();
      // Stop the dedicated native daemon as well: the verified backup is a
      // stopped filesystem snapshot, not a snapshot of live native work.
      await execute(cleanupExecutable, ["app-server", "daemon", "stop"], {
        env: runtimeEnvironment(home),
        timeout: 20000,
      });
      const backupDir = join(base, "candidate-backup");
      const backup = await call(current, "backup", "--destination", backupDir);
      assert.equal(backup.complete, true);
      const verification = await call(
        current,
        "backup-verify",
        "--destination",
        backupDir,
      );
      assert.equal(verification.complete, true);
      const manifest = JSON.parse(
        readFileSync(join(backupDir, "manifest.json"), "utf8"),
      ) as {
        roots: { source: string; directory: string }[];
      };
      // All fixture roots belong to this isolated test. Preserve their stopped
      // versions, then restore every verified root to its original path.
      for (const root of manifest.roots) {
        assert.ok(root.source.startsWith("/private/tmp/cat-upgrade-"));
        await execute("mv", [root.source, `${root.source}.pre-restore`]);
      }
      for (const root of manifest.roots)
        cpSync(join(backupDir, root.directory), root.source, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          preserveTimestamps: true,
        });
      assert.deepEqual(snapshot(), preBackup);
      assert.equal(
        snapshot().workspace_commands.find(
          (r: any) => r.call_id === "unknown-upgrade-fixture",
        ).state,
        "accepted",
        "restore must retain the unresolved receipt",
      );
      assert.equal(
        readFileSync(join(childPath, "value"), "utf8"),
        "coder edit",
      );
      await call(current, "start");
      assert.deepEqual(snapshot(), preBackup);
      assert.equal(
        provider.bodies.length,
        4,
        "restored unknown command must not be replayed",
      );
      const replacement = await call(
        current,
        "scope-replace",
        "--target",
        root.id,
        "--key",
        "new-scope",
        "--generation",
        "0",
        "--task",
        "NEW_SCOPE_FIXTURE",
      );
      assert.equal(replacement.state, "draining");
      assert.equal(replacement.commands.length, 1);
      assert.equal(replacement.commands[0].call_id, "unknown-upgrade-fixture");
      assert.equal(
        provider.bodies.length,
        4,
        "unknown work must not be replayed",
      );
      const reviewed = await call(
        current,
        "command-review",
        "--target",
        root.id,
        "--call-id",
        "unknown-upgrade-fixture",
        "--reason",
        "Synthetic isolated fixture reviewed; outcome remains unknown",
      );
      assert.equal(reviewed.outcome, "reviewed-unknown");
      assert.equal(reviewed.replayAllowed, false);
      await call(
        current,
        "limits",
        "--target",
        root.id,
        "--max-turns",
        "unlimited",
        "--max-total-turns",
        "unlimited",
        "--reason",
        "synthetic upgrade acceptance",
      );
      await call(current, "control", "--target", root.id, "--action", "resume");
      await until(
        async () =>
          snapshot().turn_attempts.length === 3 &&
          snapshot().turn_attempts.every((a: any) => a.state === "completed"),
      );
      await call(current, "control", "--target", root.id, "--action", "pause");
      const after = snapshot();
      assert.equal(
        after.operator_messages.find(
          (m: any) => m.input_key === "queued-before-upgrade",
        ).status,
        "cancelled",
      );
      assert.match(after.turn_attempts[2].input, /NEW_SCOPE_FIXTURE/);
      assert.doesNotMatch(
        after.turn_attempts[2].input,
        /OLD_QUEUED_ASSIGNMENT/,
      );
      assert.equal(provider.bodies.length, 5);
      await call(current, "stop");
      const rejectOld = `const {Store}=await import(${JSON.stringify(pathToFileURL(join(legacy, "src/storage/store.ts")).href)});try{new Store(${JSON.stringify(join(state, "business.sqlite"))});process.exit(2)}catch(e){if(!String(e).includes('Unsupported business schema version'))throw e;console.log('DOWNGRADE_REFUSED')}`;
      assert.match(
        (
          await execute(
            process.execPath,
            ["--input-type=module", "-e", rejectOld],
            { cwd: base },
          )
        ).stdout,
        /DOWNGRADE_REFUSED/,
      );
      await call(current, "start");
      assert.deepEqual(snapshot(), after);
      assert.equal(provider.bodies.length, 5);
      const db = new DatabaseSync(join(state, "business.sqlite"), {
        readOnly: true,
      });
      try {
        assert.equal(
          db.prepare("SELECT version FROM schema_version").get()!.version,
          15,
        );
        assert.equal(
          db.prepare("PRAGMA integrity_check").get()!.integrity_check,
          "ok",
        );
        assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      } finally {
        db.close();
      }
    } finally {
      try {
        if (existsSync(join(state, "control.sock")))
          await call(current, "stop");
      } finally {
        try {
          await execute(cleanupExecutable, ["app-server", "daemon", "stop"], {
            env: runtimeEnvironment(home),
            timeout: 20000,
          });
        } finally {
          await provider.close();
          rmSync(base, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 100,
          });
        }
      }
    }
  },
);
