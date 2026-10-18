import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../../src/storage/store.ts";

test("SQLite online WAL backup refuses a live owner and restores paused scopes, identity and unknown cost after writer exit", async () => {
  for (let repetition = 0; repetition < 3; repetition++) {
    const dir = mkdtempSync("/tmp/cat-wal-backup-"),
      path = join(dir, "source.sqlite"),
      copy = join(dir, "restore.sqlite");
    const source = pathToFileURL(resolve("src/storage/store.ts")).href;
    const code = `import{Store}from ${JSON.stringify(source)};import{backup}from'node:sqlite';
const s=new Store(${JSON.stringify(path)});s.db.exec('PRAGMA wal_autocheckpoint=0');
const root=s.createRoot('Lead','work',{tokens:5000000,maxDepth:2,maxAgents:20,maxConcurrentTurns:3,maxTurnsPerAgent:null,maxTotalTurns:null,turnReservation:100});
const b=s.bind(root.id,'thread-source','fixture');const t=s.prepare(root.id,'work');s.markStarting(t.id);s.attachTurn(t.id,1,'turn-source');s.observeUsage(t.id,1,17);s.finish(t.id,1,'interrupted','partial');s.control(null,root.id,'pause');
const scope=s.scopes.replace(root.id,'replace',0,'new assignment');
await backup(s.db,${JSON.stringify(copy)});
console.log(JSON.stringify({root:root.id,attempt:t.id,receipt:scope.receipt,binding:s.binding(root.id),cost:s.accounting(t.id),messages:s.messages(root.id),turns:s.agent(root.id).turns}));setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let restored: Store | undefined;
    try {
      const saved = await new Promise<any>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(
          () => reject(new Error("backup child deadline")),
          10000,
        );
        child.stdout.on("data", (b) => {
          output += String(b);
          if (output.includes("\n")) {
            clearTimeout(timer);
            resolve(JSON.parse(output.split("\n")[0]!));
          }
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("backup child exited early"));
        });
      });
      assert.ok(
        statSync(path + "-wal").size > 32,
        "source must contain a live WAL",
      );
      assert.throws(
        () => new Store(copy),
        /coordinator owns|owns this database/,
      );
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      restored = new Store(copy);
      assert.deepEqual(
        JSON.parse(JSON.stringify(restored.binding(saved.root))),
        saved.binding,
      );
      assert.deepEqual(restored.accounting(saved.attempt), saved.cost);
      assert.equal(restored.accounting(saved.attempt).finalized, false);
      assert.equal(restored.agent(saved.root).turns, saved.turns);
      assert.equal(restored.agent(saved.root).desired, "paused");
      assert.deepEqual(
        JSON.parse(JSON.stringify(restored.messages(saved.root))),
        saved.messages,
      );
      assert.equal(restored.scopes.epoch(saved.root).generation, 1);
      restored.scopes.advance();
      assert.equal(restored.scopes.progress(saved.receipt.id).state, "ready");
      assert.equal(restored.attemptCount(saved.root), 1);
      assert.equal(
        restored.db.prepare("PRAGMA integrity_check").get()!.integrity_check,
        "ok",
      );
      assert.equal(
        restored.db.prepare("PRAGMA foreign_key_check").all().length,
        0,
      );
    } finally {
      child.kill("SIGKILL");
      restored?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
