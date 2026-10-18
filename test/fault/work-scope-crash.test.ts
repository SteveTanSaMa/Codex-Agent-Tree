import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../../src/storage/store.ts";
import { rootSettings } from "../../src/storage/interaction.ts";

const source = pathToFileURL(resolve("src/storage/store.ts")).href;
for (const window of ["before-commit", "after-commit"] as const) {
  test(`scope replacement survives ${window} SIGKILL without partial queue/epoch/task changes`, () => {
    for (let repetition = 0; repetition < 3; repetition++) {
      const dir = mkdtempSync("/tmp/cat-replace-kill-"),
        path = join(dir, "business.sqlite");
      let s = new Store(path);
      const root = s.createRoot("Lead", "old", rootSettings({}).limits);
      s.bind(root.id, "thread-root", "fixture");
      const t = s.prepare(root.id, "old");
      s.operatorSend(root.id, "old", "OLD_QUEUED");
      const task = s.tasks.create(null, root.id, {
        requestKey: "old",
        subject: "Old",
        description: "old",
      });
      s.close();
      try {
        const code = `import {Store} from ${JSON.stringify(source)};const s=new Store(${JSON.stringify(path)});
${window === "before-commit" ? `s.db.function('crash',()=>{process.kill(process.pid,'SIGKILL');return 0;});s.db.exec("CREATE TRIGGER die BEFORE INSERT ON events WHEN NEW.kind='scope.replacement.accepted' BEGIN SELECT crash(); END");` : ""}
s.scopes.replace(${JSON.stringify(root.id)},'replace',0,'NEW_SCOPE');process.kill(process.pid,'SIGKILL');`;
        assert.throws(
          () =>
            execFileSync(
              process.execPath,
              ["--input-type=module", "-e", code],
              { stdio: "pipe" },
            ),
          (e) => (e as { signal: string }).signal === "SIGKILL",
        );
        s = new Store(path);
        const committed = window === "after-commit";
        assert.equal(s.scopes.epoch(root.id).generation, committed ? 1 : 0);
        assert.equal(s.agent(root.id).task, committed ? "NEW_SCOPE" : "old");
        assert.equal(
          s.attempt(t.id).state,
          committed ? "cancelled" : "prepared",
        );
        assert.equal(
          s.tasks.get(null, root.id, task.id).status,
          committed ? "deleted" : "pending",
        );
        assert.deepEqual(
          s.messages(root.id).map((m) => m.status),
          committed ? ["cancelled", "queued"] : ["queued"],
        );
        assert.equal(
          s.db.prepare("SELECT COUNT(*) AS n FROM scope_replacements").get()!.n,
          committed ? 1 : 0,
        );
        assert.equal(s.agent(root.id).turns, 1);
        if (committed) {
          const replay = s.scopes.replace(root.id, "replace", 0, "NEW_SCOPE");
          s.scopes.advance();
          assert.equal(s.scopes.progress(replay.receipt.id).state, "ready");
          assert.equal(s.messages(root.id).length, 2);
        }
        assert.equal(
          s.db.prepare("pragma integrity_check").get()!.integrity_check,
          "ok",
        );
        assert.equal(s.db.prepare("pragma foreign_key_check").all().length, 0);
      } finally {
        s.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
}

for (const window of [
  "before-effect",
  "after-effect",
  "after-receipt",
] as const) {
  test(`external command ${window} crash preserves uncertainty or cached receipt, never automatically repeats effect`, () => {
    for (let repetition = 0; repetition < 3; repetition++) {
      const dir = mkdtempSync("/tmp/cat-effect-kill-"),
        path = join(dir, "business.sqlite"),
        counter = join(dir, "counter");
      let s = new Store(path);
      const root = s.createRoot("Lead", "work", rootSettings({}).limits);
      const b = s.bind(root.id, "thread-root", "fixture"),
        t = s.prepare(root.id, "work");
      s.markStarting(t.id);
      s.attachTurn(t.id, b.generation, "native-turn");
      const actor = s.authenticate(b.thread_id, "native-turn", b.generation);
      s.close();
      const effect = `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(counter)},'1')`;
      const code = `import{execFileSync}from'node:child_process';import{Store}from ${JSON.stringify(source)};const s=new Store(${JSON.stringify(path)});const a=${JSON.stringify(actor)};
s.beginWorkspaceCommand(a,'call',{task:'effect'});
${window === "before-effect" ? "process.kill(process.pid,'SIGKILL');" : ""}
execFileSync(process.execPath,['--input-type=module','-e',${JSON.stringify(effect)}]);
${window === "after-effect" ? "process.kill(process.pid,'SIGKILL');" : ""}
s.finishWorkspaceCommand(a.agentId,'call',{exitCode:0});process.kill(process.pid,'SIGKILL');`;
      try {
        assert.throws(
          () =>
            execFileSync(
              process.execPath,
              ["--input-type=module", "-e", code],
              { stdio: "pipe" },
            ),
          (e) => (e as { signal: string }).signal === "SIGKILL",
        );
        s = new Store(path);
        const completed = window === "after-receipt";
        if (completed)
          assert.deepEqual(
            s.beginWorkspaceCommand(actor, "call", { task: "effect" }),
            { cached: true, result: { exitCode: 0 } },
          );
        else
          assert.throws(
            () => s.beginWorkspaceCommand(actor, "call", { task: "effect" }),
            /unknown or still running/,
          );
        assert.equal(
          s.workspaceCommandSummary(root.id)!.unresolved,
          completed ? 0 : 1,
        );
        assert.equal(existsSync(counter), window !== "before-effect");
        if (existsSync(counter))
          assert.equal(readFileSync(counter, "utf8"), "1");
        assert.equal(s.attempts(root.id).length, 1);
      } finally {
        s.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
}
