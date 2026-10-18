import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import { rootSettings } from "../../src/storage/interaction.ts";
import { runtimeEnvironment } from "../../src/runtime/codex/adapter.ts";
import { scriptedProvider, response } from "../fixtures/scripted-provider.ts";
async function until(check: () => boolean) {
  const end = Date.now() + 15000;
  while (!check()) {
    assert.ok(
      Date.now() < end,
      "scripted native tool callback did not complete",
    );
    await new Promise((r) => setTimeout(r, 10));
  }
}
test(
  "native dynamic tool callback commits one authenticated Task and returns its output to the provider",
  { skip: process.env.CAT_TEST_NATIVE !== "1", timeout: 45000 },
  async () => {
    const base = mkdtempSync("/tmp/cat-callback-"),
      home = join(base, "h");
    const provider = await scriptedProvider(home, (body, res, count) => {
      if (count === 1) {
        const names: string[] = [];
        const visit = (x: any) => {
          if (!x || typeof x !== "object") return;
          if (x.type === "function" && typeof x.name === "string")
            names.push(x.name);
          for (const v of Object.values(x))
            if (typeof v === "object")
              Array.isArray(v) ? v.forEach(visit) : visit(v);
        };
        visit(body.tools);
        const name =
          names.find((n) => n.endsWith("agent_task_create")) ??
          "agent_task_create";
        response(
          res,
          {
            type: "function_call",
            id: "fc_task",
            call_id: "call_task",
            name,
            arguments: JSON.stringify({
              requestKey: "native-create",
              subject: "NativeCallback",
              description: "Authenticated fixture",
            }),
          },
          "resp_tool",
        );
      } else
        response(
          res,
          {
            type: "message",
            id: "msg_done",
            role: "assistant",
            content: [
              { type: "output_text", text: "CALLBACK_DONE", annotations: [] },
            ],
          },
          "resp_done",
        );
    });
    const executable = process.env.CAT_TEST_CODEX ?? "codex";
    const c = new Coordinator({
      stateDirectory: join(base, "s"),
      runtimeHome: home,
      executable,
      credential: provider.credential,
    });
    try {
      await c.start();
      const settings = rootSettings({ maxTurns: 1, maxTotalTurns: 1 });
      const root = c.createRoot(
        "Lead",
        "Use the supplied tool then finish",
        settings.limits,
        "root",
        settings.policy,
      );
      await until(() =>
        c.store.attempts(root.id).some((a) => a.state === "completed"),
      );
      assert.equal(c.store.attemptCount(root.id), 1);
      const tasks = c.store.tasks.list(null, root.id);
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]!.subject, "NativeCallback");
      assert.equal(tasks[0]!.createdBy, root.id);
      assert.equal(provider.bodies.length, 2);
      assert.match(JSON.stringify(provider.bodies[1]), /NativeCallback/);
      assert.match(c.store.attempts(root.id)[0]!.result!, /CALLBACK_DONE/);
      assert.equal(
        c.store.runtimeQualification().qualification.policy,
        "capabilities-v1",
      );
    } finally {
      await c.stop();
      try {
        execFileSync(executable, ["app-server", "daemon", "stop"], {
          env: runtimeEnvironment(home),
          timeout: 20000,
          stdio: "pipe",
        });
      } finally {
        await provider.close();
        rmSync(base, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      }
    }
  },
);
