import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
const { laneIdle, roundReady, workersCompleted } = await import(
  new URL("../../scripts/soak/quiescence.mjs", import.meta.url).href
);
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE turn_attempts(id TEXT PRIMARY KEY,state TEXT);
 CREATE TABLE operator_messages(recipient_id TEXT,input_key TEXT,status TEXT,attempt_id TEXT);
 CREATE TABLE messages(sender_id TEXT,recipient_id TEXT,body TEXT,status TEXT,attempt_id TEXT);
 CREATE TABLE tasks(status TEXT);`);
  return db;
}
test("single-snapshot quiescence rejects dispatch between the legacy two reads", () => {
  const db = fixture();
  try {
    db.exec(
      "INSERT INTO operator_messages VALUES('a','round-1-coderA','queued',NULL)",
    );
    const noActive =
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM turn_attempts WHERE state='running'",
        )
        .get()!.n === 0;
    db.exec(
      "BEGIN; INSERT INTO turn_attempts VALUES('a-turn','running'); UPDATE operator_messages SET status='delivering',attempt_id='a-turn'; COMMIT;",
    );
    const noQueued =
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM operator_messages WHERE status='queued'",
        )
        .get()!.n === 0;
    assert.equal(
      noActive && noQueued,
      true,
      "legacy split reads falsely declare idle",
    );
    assert.equal(laneIdle(db), false);
    db.exec(
      "UPDATE turn_attempts SET state='completed'; UPDATE operator_messages SET status='processed'",
    );
    assert.equal(laneIdle(db), true);
  } finally {
    db.close();
  }
});
test("round barrier requires every exact input/report and its completed integration Attempt", () => {
  const db = fixture();
  const workers = ["coderA", "coderB", "reviewer"].map((role, i) => ({
    role,
    id: "worker-" + i,
  }));
  try {
    assert.equal(laneIdle(db), true);
    assert.equal(roundReady(db, 77, "lead", workers), false);
    for (const [i, w] of workers.entries()) {
      db.prepare("INSERT INTO turn_attempts VALUES(?,?)").run(
        w.id,
        "completed",
      );
      db.prepare("INSERT INTO operator_messages VALUES(?,?,?,?)").run(
        w.id,
        `round-77-${w.role}`,
        "processed",
        w.id,
      );
      if (i < 2) {
        db.prepare("INSERT INTO turn_attempts VALUES(?,?)").run(
          "lead-" + i,
          "completed",
        );
        db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(
          w.id,
          "lead",
          `CATSOAK_lead_${771 + i}_normal source=${w.role} value=77`,
          "processed",
          "lead-" + i,
        );
      }
    }
    assert.equal(laneIdle(db), true);
    assert.equal(
      roundReady(db, 77, "lead", workers),
      false,
      "missing report cannot be mistaken for completion",
    );
    db.exec("INSERT INTO turn_attempts VALUES('lead-2','running')");
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)").run(
      workers[2]!.id,
      "lead",
      "CATSOAK_lead_773_normal source=reviewer value=77",
      "acknowledged",
      "lead-2",
    );
    assert.equal(roundReady(db, 77, "lead", workers), false);
    db.exec(
      "UPDATE turn_attempts SET state='completed'; UPDATE messages SET status='processed'; INSERT INTO tasks VALUES('in_progress')",
    );
    assert.equal(
      roundReady(db, 77, "lead", workers),
      false,
      "task completion remains explicit",
    );
    db.exec("UPDATE tasks SET status='completed'");
    assert.equal(roundReady(db, 77, "lead", workers), true);
    db.exec("UPDATE tasks SET status='deleted'");
    assert.equal(roundReady(db, 77, "lead", workers), true);
    db.exec("UPDATE messages SET status='unknown' WHERE sender_id='worker-2'");
    assert.equal(roundReady(db, 77, "lead", workers), false);
  } finally {
    db.close();
  }
});

test("inherited-workspace reviewer waits for both coder Attempts to complete", () => {
  const db = fixture();
  const workers = [
    { id: "a", role: "coderA" },
    { id: "b", role: "coderB" },
  ];
  try {
    db.exec(
      "INSERT INTO turn_attempts VALUES('a','running'),('b','completed'); INSERT INTO operator_messages VALUES('a','round-173-coderA','acknowledged','a'),('b','round-173-coderB','processed','b')",
    );
    assert.equal(workersCompleted(db, 173, workers), false);
    db.exec("UPDATE turn_attempts SET state='completed'");
    assert.equal(workersCompleted(db, 173, workers), false);
    db.exec("UPDATE operator_messages SET status='processed'");
    assert.equal(workersCompleted(db, 173, workers), true);
    assert.equal(workersCompleted(db, 174, workers), false);
  } finally {
    db.close();
  }
});
