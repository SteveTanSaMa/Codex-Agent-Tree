import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../../src/storage/store.ts";
import { rootSettings } from "../../src/storage/interaction.ts";
import { environment } from "../../src/cli/environment.ts";
import { diagnose } from "../../src/cli/diagnose.ts";

test("environment reports policy and requested host paths without executing or exposing arguments and credentials", () => {
  const state = mkdtempSync(join(tmpdir(), "cat-environment-"));
  const db = new Store(join(state, "business.sqlite"));
  try {
    const resource = join(state, "resource");
    mkdirSync(resource);
    const policy = {
      repository: state,
      baseCommit: "a".repeat(40),
      readOnlyResources: { sdk: resource },
      tests: {
        test: {
          executable: process.execPath,
          args: ["fixture-secret"],
          networkEndpoints: [{ address: "127.0.0.1", port: 1234 }],
        },
      },
    };
    db.db
      .prepare("INSERT INTO workspace_registry VALUES(1,?)")
      .run(JSON.stringify(policy));
    writeFileSync(
      join(state, "config.json"),
      JSON.stringify({ credential: "fixture-secret", workspace: policy }),
    );
    const before = readFileSync(join(state, "config.json"));
    const report = environment(state, [
      { name: "node", path: process.execPath },
      { name: "missing", path: join(state, "missing") },
    ]);
    assert.equal(report.readOnly, true);
    assert.equal(report.evidence.policySource, "persisted-registry");
    assert.equal(report.workspace.repositories[0]!.tests[0]!.name, "test");
    assert.equal(report.commandPolicy.terminalNetwork, "denied");
    assert.equal(report.commandPolicy.synchronousTimeoutMs, 30000);
    assert.equal(report.commandPolicy.leadBackgroundTerminalTimeoutMs, 600000);
    assert.equal(report.tools[0]!.exists, true);
    assert.equal(report.tools[1]!.exists, false);
    assert.equal(JSON.stringify(report).includes("fixture-secret"), false);
    assert.deepEqual(readFileSync(join(state, "config.json")), before);
    const request = join(state, "tools.json");
    writeFileSync(
      request,
      JSON.stringify([{ name: "node", path: process.execPath }]),
    );
    const wrapper = fileURLToPath(
      new URL("../../scripts/cat.mjs", import.meta.url),
    );
    const invocation = spawnSync(
      process.execPath,
      [wrapper, "environment", "--state", state, "--tools", request],
      { encoding: "utf8" },
    );
    assert.equal(invocation.status, 0, invocation.stderr);
    assert.equal(JSON.parse(invocation.stdout).tools[0].name, "node");
    assert.equal(invocation.stdout.includes("fixture-secret"), false);
    assert.throws(
      () => environment(state, [{ name: "relative", path: "foo" }]),
      /absolute paths/,
    );
  } finally {
    db.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test("diagnose exposes quarantines and unknown guidance without automatically changing state or echoing raw errors", () => {
  const state = mkdtempSync(join(tmpdir(), "cat-diagnostic-runtime-"));
  const db = new Store(join(state, "business.sqlite"));
  try {
    const agent = db.createRoot("Lead", "task", rootSettings({}).limits);
    db.db
      .prepare(
        "INSERT INTO runtime_blocks(agent_id,reason,created_at) VALUES(?,?,?)",
      )
      .run(agent.id, "fixture-secret", "2026-01-01");
    db.db
      .prepare("UPDATE agents SET last_error=? WHERE id=?")
      .run("fixture-secret", agent.id);
    db.db
      .prepare(
        "INSERT INTO operator_messages(id,recipient_id,input_key,body,status,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run("msg", agent.id, "key", "body", "unknown", "2026-01-01");
    db.db
      .prepare(
        "INSERT INTO operator_guidance(message_id,agent_id,mode,state) VALUES(?,?,?,?)",
      )
      .run("msg", agent.id, "steer", "unknown");
    const report = diagnose(state);
    assert.equal(report.runtimeBlocks.length, 1);
    assert.equal(report.unknownGuidance.length, 1);
    assert.equal(report.agentsWithErrors.length, 1);
    assert.equal(JSON.stringify(report).includes("fixture-secret"), false);
    assert.equal(
      db.db
        .prepare("SELECT state FROM operator_guidance WHERE message_id='msg'")
        .get()!.state,
      "unknown",
    );
    assert.equal(
      db.db.prepare("SELECT COUNT(*) AS n FROM runtime_blocks").get()!.n,
      1,
    );
  } finally {
    db.close();
    rmSync(state, { recursive: true, force: true });
  }
});

test("diagnose distinguishes unavailable historical tables and columns from empty evidence without migration", () => {
  const state = mkdtempSync(join(tmpdir(), "cat-diagnostic-legacy-"));
  const db = new Store(join(state, "business.sqlite"));
  try {
    db.createRoot("Lead", "task", rootSettings({}).limits);
    db.db.exec(
      "DROP TABLE operator_guidance; DROP TABLE workspace_commands; UPDATE schema_version SET version=11",
    );
    let report = diagnose(state);
    assert.equal(
      report.diagnosticAvailability.unknownGuidance,
      "table-missing",
    );
    assert.equal(
      report.diagnosticAvailability.unknownCommands,
      "table-missing",
    );
    assert.equal(report.diagnosticAvailability.runtimeBlocks, "available");
    db.db.exec(
      "CREATE TABLE operator_guidance(message_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, state TEXT NOT NULL)",
    );
    report = diagnose(state);
    assert.equal(
      report.diagnosticAvailability.unknownGuidance,
      "columns-missing",
    );
    assert.equal(
      db.db.prepare("SELECT version FROM schema_version").get()!.version,
      11,
    );
    assert.equal(
      db.db.prepare("SELECT COUNT(*) AS n FROM operator_guidance").get()!.n,
      0,
    );
  } finally {
    db.close();
    rmSync(state, { recursive: true, force: true });
  }
});
