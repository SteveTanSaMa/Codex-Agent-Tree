import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../../src/storage/store.ts";

test("SIGKILL retains steering uncertainty and an unapplied protection pause intent", () => {
  const dir = mkdtempSync("/tmp/cat-interaction-crash-");
  const path = join(dir, "business.sqlite");
  const storeModule = pathToFileURL(resolve("src/storage/store.ts")).href;
  const policyModule = pathToFileURL(
    resolve("src/storage/interaction.ts"),
  ).href;
  const script = `import{Store}from ${JSON.stringify(storeModule)};import{rootSettings}from ${JSON.stringify(policyModule)};
 const s=new Store(${JSON.stringify(path)});const p=rootSettings({autonomyPauseMs:1});
 const a=s.createRoot('A','work',p.limits);s.interaction.configure(a.id,p.policy);s.bind(a.id,'thread','fixture');
 const t=s.prepare(a.id,'work');s.markStarting(t.id);s.attachTurn(t.id,1,'turn');
 const id=s.operatorSend(a.id,'key','input');s.interaction.register(a.id,id,'steer');s.interaction.claim(id,s.attempt(t.id));
 s.interaction.evaluate(a.id,true,0,1000);s.interaction.evaluate(a.id,true,0,1002);
 process.kill(process.pid,'SIGKILL');`;
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
      const a = s.agents()[0]!;
      assert.equal(s.interaction.guidance(a.id)[0]!.state, "unknown");
      assert.equal(s.messages(a.id)[0]!.status, "unknown");
      assert.equal(a.turns, 1);
      assert.equal(s.attempts(a.id).length, 1);
      assert.equal(s.binding(a.id)!.thread_id, "thread");
      assert.equal(s.interaction.evaluate(a.id, true, 0, 1003).pause, true);
      assert.equal(
        s.events(a.id).filter((e) => e.kind === "interaction.pause_requested")
          .length,
        1,
      );
    } finally {
      s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
