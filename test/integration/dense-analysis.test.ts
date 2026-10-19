import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
test("dense analysis separates native correctness, 1001 rounds, and 200/min throughput", () => {
  const dir = mkdtempSync(join(tmpdir(), "cat-dense-analysis-"));
  try {
    const run = join(dir, "normal");
    mkdirSync(run);
    const db = new DatabaseSync(join(run, "business.sqlite"));
    db.exec(
      "CREATE TABLE tasks(status TEXT); CREATE TABLE messages(status TEXT); CREATE TABLE operator_messages(status TEXT); CREATE TABLE turn_attempts(state TEXT); INSERT INTO tasks VALUES('deleted'); INSERT INTO messages VALUES('processed'); INSERT INTO turn_attempts VALUES('completed')",
    );
    db.close();
    const put = (name: string, value: unknown) =>
      writeFileSync(join(run, name), JSON.stringify(value));
    writeFileSync(
      join(dir, "launch.json"),
      JSON.stringify({
        smoke: false,
        durationSeconds: 3600,
        runs: [{ profile: "normal", runDir: run }],
      }),
    );
    put("watchdog-result.json", { runnerExitCode: 0, forcedDeadline: false });
    const result = {
      phase: "completed",
      elapsedMs: 3600000,
      completedRounds: 900,
      requests: 30000,
      checkpoints: [{ kind: "native.history.pass" }],
      paths: { coding: { state: run } },
    };
    const analyze = () =>
      JSON.parse(
        execFileSync(
          "python3",
          [resolve("scripts/soak/dense-analysis.py"), dir],
          { encoding: "utf8" },
        ),
      ).teams[0];
    put("result.json", result);
    let v = analyze();
    assert.equal(v.outcome, "targets-not-met");
    assert.deepEqual(v.targetFlags, [
      "below-1001-rounds",
      "below-200-rounds-per-minute",
    ]);
    put("result.json", { ...result, completedRounds: 12000 });
    v = analyze();
    assert.equal(v.outcome, "passed");
    assert.equal(v.actualRoundsPerMinute, 200);
    put("result.json", {
      ...result,
      completedRounds: 12000,
      phase: "failed",
      failure: "tool rejection",
    });
    assert.equal(analyze().outcome, "review-required");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
