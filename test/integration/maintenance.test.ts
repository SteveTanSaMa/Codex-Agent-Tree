import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  cpSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../src/storage/store.ts";
import { rootSettings } from "../../src/storage/interaction.ts";
import { diagnose } from "../../src/cli/diagnose.ts";
import {
  capacity,
  historyExport,
  preflight,
  backupState,
  verifyBackup,
} from "../../src/cli/maintenance.ts";

test("diagnose cross-checks persisted workspace identities, no-git residuals, missing directories and malformed markers read-only", () => {
  const dir = realpathSync(mkdtempSync("/tmp/cat-diagnostic-followup-")),
    s = new Store(join(dir, "business.sqlite"));
  try {
    const root = s.createRoot("Lead", "work", rootSettings({}).limits);
    const policy = {
      repository: join(dir, "external"),
      baseCommit: "a".repeat(40),
      tests: {},
    };
    s.db
      .prepare("INSERT INTO workspace_registry VALUES(1,?)")
      .run(JSON.stringify(policy));
    const missing = join(dir, "workspaces", "missing"),
      early = join(dir, "workspaces", "early");
    mkdirSync(join(early, "src"), { recursive: true });
    writeFileSync(join(early, "src", "keep"), "preserve");
    mkdirSync(join(dir, "worktree-ready"));
    writeFileSync(
      join(dir, "worktree-ready", "missing.json"),
      JSON.stringify({ path: missing, baseCommit: policy.baseCommit }),
    );
    writeFileSync(join(dir, "worktree-ready", "bad.json"), "not JSON");
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ workspace: { ...policy, baseCommit: "b".repeat(40) } }),
    );
    const report = diagnose(dir);
    assert.ok(
      report.worktrees.some(
        (w) =>
          w.path === missing && w.reasons.includes("marker-directory-missing"),
      ),
    );
    assert.ok(
      report.worktrees.some(
        (w) => w.path === early && w.reasons.includes("directory-without-git"),
      ),
    );
    assert.ok(
      report.worktrees.some(
        (w) =>
          w.path === policy.repository &&
          w.sources.includes("persisted-workspace-assignment"),
      ),
    );
    assert.equal(report.malformedMarkers.length, 1);
    assert.ok(report.configurationIssues.length);
    assert.equal(readFileSync(join(early, "src", "keep"), "utf8"), "preserve");
    assert.equal(existsSync(missing), false);
    assert.ok(root.id);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("capacity thresholds and bounded exports preserve audit and FIFO histories without mutation", () => {
  const dir = mkdtempSync("/tmp/cat-capacity-"),
    s = new Store(join(dir, "business.sqlite"));
  try {
    const root = s.createRoot("Lead", "work", rootSettings({}).limits);
    s.operatorSend(root.id, "human-1", "one");
    const before = s.eventCursor();
    const report = capacity(dir, { warnBytes: 1, warnRows: 1 });
    assert.equal(report.warnings.length, 2);
    assert.equal(report.automaticCleanup, false);
    const page = historyExport(dir, root.id, "events", 0, 1);
    assert.equal(page.items.length, 1);
    const messages = historyExport(dir, root.id, "messages", 0, 1);
    assert.equal(messages.items[0]?.body, "one");
    assert.equal(s.eventCursor(), before);
    assert.throws(() => historyExport(dir, root.id, "events", 0, 101), /page/);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("stopped complete backup includes state/runtime, verifies hashes, refuses live owners and restores schema 14 evidence through schema 15", () => {
  const dir = mkdtempSync("/tmp/cat-backup-followup-"),
    state = join(dir, "state"),
    home = join(dir, "runtime"),
    path = join(state, "business.sqlite");
  let s = new Store(path);
  try {
    const root = s.createRoot("Lead", "work", rootSettings({}).limits);
    const taskInput = {
      requestKey: "retained-task",
      subject: "history",
      description: "evidence",
    };
    const task = s.tasks.create(null, root.id, taskInput);
    const message = s.operatorSend(
      root.id,
      "retained-message",
      "preserve pending work",
    );
    s.bind(root.id, "retained-thread", "fixture");
    const attempt = s.prepare(root.id, "unknown fixture");
    s.markStarting(attempt.id);
    s.uncertain(attempt.id, "ACK lost");
    s.control(null, root.id, "pause");
    mkdirSync(home);
    writeFileSync(join(home, "runtime-history"), "retained");
    writeFileSync(
      join(state, "config.json"),
      JSON.stringify({ stateDirectory: state, runtimeHome: home }),
    );
    assert.equal(preflight(state).ownerActive, true);
    assert.throws(() => backupState(state, join(dir, "live")), /stopped/);
    s.close();
    const old = new DatabaseSync(path);
    old.exec(
      "DROP TABLE integration_results;UPDATE schema_version SET version=14",
    );
    old.close();
    assert.equal(preflight(state).migrationRequired, true);
    const result = backupState(state, join(dir, "backup"));
    assert.equal(result.complete, true);
    assert.equal(verifyBackup(join(dir, "backup")).complete, true);
    const manifest = JSON.parse(readFileSync(result.manifest, "utf8"));
    assert.equal(manifest.roots.length, 2);
    assert.throws(() => backupState(state, join(dir, "backup")), /exists/);
    const entry = manifest.roots.find(
      (r: { source: string }) => r.source === realpathSync(state),
    );
    const restored = join(dir, "restored");
    cpSync(join(dir, "backup", entry.directory), restored, { recursive: true });
    s = new Store(join(restored, "business.sqlite"));
    assert.equal(
      s.db.prepare("SELECT version FROM schema_version").get()!.version,
      15,
    );
    assert.equal(s.agent(root.id).desired, "paused");
    assert.equal(s.attempt(attempt.id).state, "unknown");
    assert.equal(s.messages(root.id)[0]?.id, message);
    assert.deepEqual(s.tasks.create(null, root.id, taskInput), task);
    writeFileSync(
      join(dir, "backup", entry.directory, "config.json"),
      "tampered",
    );
    assert.equal(verifyBackup(join(dir, "backup")).complete, false);
    assert.equal(s.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
