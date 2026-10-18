import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store, type Agent } from "../../src/storage/store.ts";
import { rootSettings } from "../../src/storage/interaction.ts";

for (const action of ["pause", "cancel"] as const) {
  for (const window of ["before-commit", "after-commit"] as const) {
    test(`SQLite subtree ${action} and both message origins are atomic across ${window} SIGKILL`, () => {
      for (let repetition = 0; repetition < 3; repetition++) {
        const dir = mkdtempSync("/tmp/cat-scope-crash-"),
          path = join(dir, "business.sqlite");
        let s = new Store(path);
        const root = s.createRoot("Root", "work", rootSettings({}).limits);
        const active = (a: Agent) => {
          const b = s.bind(a.id, "thread-" + a.id, "fixture");
          const t = s.prepare(a.id, "work");
          s.markStarting(t.id);
          s.attachTurn(t.id, b.generation, "turn-" + a.id);
          return s.authenticate(b.thread_id, "turn-" + a.id, b.generation);
        };
        const actor = active(root);
        const child = s.spawn(actor, "child", {
          name: "Child",
          role: "worker",
          task: "work",
        });
        active(child);
        s.send(actor, "old-agent", child.id, "OLD_AGENT_SCOPE");
        s.operatorSend(child.id, "old-human", "OLD_HUMAN_SCOPE");
        s.close();
        const source = pathToFileURL(resolve("src/storage/store.ts")).href;
        const code = `import {Store} from ${JSON.stringify(source)};const s=new Store(${JSON.stringify(path)});
${window === "before-commit" ? `s.db.function('crash',()=>{process.kill(process.pid,'SIGKILL');return 0;});s.db.exec("CREATE TRIGGER die BEFORE INSERT ON events WHEN NEW.kind='agent.control' BEGIN SELECT crash(); END");` : ""}
s.control(null,${JSON.stringify(root.id)},${JSON.stringify(action)},'subtree',true);process.kill(process.pid,'SIGKILL');`;
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
          const committed = window === "after-commit";
          assert.equal(
            s.agent(root.id).desired,
            committed
              ? action === "pause"
                ? "paused"
                : "cancelled"
              : "active",
          );
          assert.equal(s.agent(child.id).desired, s.agent(root.id).desired);
          assert.deepEqual(
            s.messages(child.id).map((m) => m.status),
            [
              committed && action === "cancel" ? "cancelled" : "queued",
              committed && action === "cancel" ? "cancelled" : "queued",
            ],
          );
          assert.equal(
            s.interaction.mustInterrupt(root.id),
            committed && action === "pause",
          );
          assert.equal(
            s.interaction.mustInterrupt(child.id),
            committed && action === "pause",
          );
          assert.equal(s.attempts().length, 2);
          assert.ok(s.attempts().every((t) => t.state === "running"));
          assert.equal(
            s.db.prepare("pragma integrity_check").get()!.integrity_check,
            "ok",
          );
          assert.equal(
            s.db.prepare("pragma foreign_key_check").all().length,
            0,
          );
        } finally {
          s.close();
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  }
}
