import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../src/storage/store.ts";
import { rootSettings } from "../../src/storage/interaction.ts";

for (const fault of ["sqlite-full", "busy-writer"] as const)
  test(`message admission rolls back on ${fault} without accepting lost input`, () => {
    for (let repetition = 0; repetition < 3; repetition++) {
      const dir = mkdtempSync("/tmp/cat-storage-fail-"),
        path = join(dir, "business.sqlite");
      const s = new Store(path);
      let writer: DatabaseSync | undefined;
      try {
        const root = s.createRoot("Lead", "work", rootSettings({}).limits);
        const cursor = s.eventCursor();
        if (fault === "sqlite-full") {
          const pages = Number(
            s.db.prepare("PRAGMA page_count").get()!.page_count,
          );
          s.db.exec(`PRAGMA max_page_count=${pages}`);
        } else {
          s.db.exec("PRAGMA busy_timeout=20");
          writer = new DatabaseSync(path);
          writer.exec("BEGIN IMMEDIATE");
        }
        assert.throws(
          () => s.operatorSend(root.id, "input", "x".repeat(12000)),
          fault === "sqlite-full" ? /full/ : /locked|busy/,
        );
        writer?.exec("ROLLBACK");
        assert.equal(s.messageCounts(root.id).total, 0);
        assert.equal(s.eventCursor(), cursor);
        assert.equal(s.attemptCount(root.id), 0);
        assert.equal(
          s.db.prepare("PRAGMA integrity_check").get()!.integrity_check,
          "ok",
        );
      } finally {
        writer?.close();
        s.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
