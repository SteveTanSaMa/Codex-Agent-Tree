import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../../src/storage/store.ts";
test("SIGKILL between reminder cursor and event rolls back usage and retries exactly once", () => {
  const dir = mkdtempSync("/tmp/cat-token-crash-");
  const path = join(dir, "business.sqlite");
  const module = pathToFileURL(resolve("src/storage/store.ts")).href;
  const script = `import{Store}from ${JSON.stringify(module)};
 const s=new Store(${JSON.stringify(path)});const a=s.createRoot('A','work',{tokens:100,maxDepth:2,maxAgents:16,maxConcurrentTurns:3,maxTurnsPerAgent:null,maxTotalTurns:null,turnReservation:5});
 s.bind(a.id,'thread','fixture');const t=s.prepare(a.id,'work');s.markStarting(t.id);s.attachTurn(t.id,1,'turn');s.observeNativeUsage(t.id,1,50);
 s.db.function('crash',()=>{process.kill(process.pid,'SIGKILL');return 0;});
 s.db.exec("CREATE TRIGGER die BEFORE INSERT ON events WHEN NEW.kind='usage.reminder' BEGIN SELECT crash(); END");
 s.observeNativeUsage(t.id,1,100);`;
  try {
    assert.throws(
      () =>
        execFileSync(process.execPath, ["--input-type=module", "-e", script], {
          stdio: "pipe",
        }),
      (e: unknown) => (e as { signal?: string }).signal === "SIGKILL",
    );
    const s = new Store(path);
    try {
      const a = s.agents()[0]!,
        t = s.attempts(a.id)[0]!;
      assert.equal(t.observed, 50);
      assert.equal(s.reminders.summary(a.id, "tree").lastThreshold, null);
      assert.equal(s.reminders.summary(a.id, "tree").metrics.totalTokens, 50);
      s.db.exec("DROP TRIGGER die");
      s.observeNativeUsage(t.id, 1, 100);
      s.observeNativeUsage(t.id, 1, 100);
      assert.equal(
        s.events(a.id).filter((e) => e.kind === "usage.reminder").length,
        1,
      );
      assert.equal(s.reminders.summary(a.id, "tree").lastThreshold, 100);
    } finally {
      s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
