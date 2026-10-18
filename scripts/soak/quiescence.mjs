// One SQLite statement observes all queue/dispatch states in one read snapshot.
const quiet = `NOT EXISTS(SELECT 1 FROM turn_attempts WHERE state IN ('prepared','starting','running','unknown'))
 AND NOT EXISTS(SELECT 1 FROM messages WHERE status='queued')
 AND NOT EXISTS(SELECT 1 FROM operator_messages WHERE status='queued')`;
export function laneIdle(db) {
  return db.prepare(`SELECT ${quiet} AS ready`).get().ready === 1;
}
// Idleness is not proof that this round's inputs, reports and integration ran.
// Require the exact three inputs and reports to belong to completed Attempts.
export function roundReady(db, round, leadId, workers) {
  if (workers.length !== 3)
    throw new Error("Expected exactly three fixture workers");
  const inputs = workers
    .map(() => "(o.recipient_id=? AND o.input_key=?)")
    .join(" OR ");
  const reports = workers
    .map(() => "(m.sender_id=? AND m.body=?)")
    .join(" OR ");
  const inputParams = workers.flatMap((w) => [
    w.id,
    `round-${round}-${w.role}`,
  ]);
  const reportParams = workers.flatMap((w, i) => [
    w.id,
    `CATSOAK_lead_${round * 10 + i + 1}_normal source=${w.role} value=${round}`,
  ]);
  return (
    db
      .prepare(
        `SELECT ${quiet}
    AND (SELECT COUNT(*) FROM operator_messages o JOIN turn_attempts t ON t.id=o.attempt_id
      WHERE o.status='processed' AND t.state='completed' AND (${inputs}))=3
    AND (SELECT COUNT(*) FROM messages m JOIN turn_attempts t ON t.id=m.attempt_id
      WHERE m.recipient_id=? AND m.status='processed' AND t.state='completed' AND (${reports}))=3
    AND NOT EXISTS(SELECT 1 FROM tasks WHERE status NOT IN ('completed','deleted')) AS ready`,
      )
      .get(...inputParams, leadId, ...reportParams).ready === 1
  );
}

// A reviewer inheriting a coder workspace must wait for its command to finish.
export function workersCompleted(db, round, workers) {
  return workers.every(
    (w) =>
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM operator_messages o
    JOIN turn_attempts t ON t.id=o.attempt_id WHERE o.recipient_id=? AND o.input_key=?
    AND o.status='processed' AND t.state='completed'`,
        )
        .get(w.id, `round-${round}-${w.role}`).n === 1,
  );
}
