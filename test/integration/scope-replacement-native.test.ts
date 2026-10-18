import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import { rootSettings } from "../../src/storage/interaction.ts";
import { runtimeEnvironment } from "../../src/runtime/codex/adapter.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "native replacement did not settle");
    await new Promise((r) => setTimeout(r, 10));
  }
}
for (const candidate of [false, true])
  test(
    `${candidate ? "candidate compatibility" : "native"} scope replacement interrupts old Turn before new dispatch and survives restart without replay`,
    {
      skip: candidate
        ? process.env.CAT_TEST_COMPAT !== "1"
        : process.env.CAT_TEST_NATIVE !== "1",
      timeout: 45000,
    },
    async () => {
      const dir = mkdtempSync("/tmp/cat-scope-native-"),
        home = join(dir, "h");
      mkdirSync(home);
      let requests = 0;
      const server = createServer((req, res) => {
        requests++;
        req.resume();
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_hold","status":"in_progress","output":[]}}\n\n',
        );
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as { port: number }).port;
      writeFileSync(
        join(home, "config.toml"),
        `model="fixture"\nmodel_provider="local"\n[model_providers.local]\nname="local"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nenv_key="CAT_SCOPE_FIXTURE_KEY"\nsupports_websockets=false\nrequires_openai_auth=false\n[features]\nmulti_agent=false\nshell_tool=false\nunified_exec=false\n`,
      );
      const previous = process.env.CAT_SCOPE_FIXTURE_KEY;
      process.env.CAT_SCOPE_FIXTURE_KEY = "fixture-not-a-secret";
      const options = {
        stateDirectory: join(dir, "s"),
        runtimeHome: home,
        executable:
          (candidate
            ? process.env.CAT_COMPAT_CODEX
            : process.env.CAT_TEST_CODEX) ?? "codex",
        expectedVersion: candidate
          ? process.env.CAT_COMPAT_EXPECTED_VERSION!
          : (process.env.CAT_TEST_EXPECTED_VERSION ??
            "codex-cli 0.162.0-alpha.17.2"),
        credential: { envKey: "CAT_SCOPE_FIXTURE_KEY" },
      };
      let c = new Coordinator(options);
      try {
        await c.start();
        const settings = rootSettings({ maxTurns: 2, maxTotalTurns: 2 });
        const root = c.createRoot(
          "Lead",
          "OLD_SCOPE",
          settings.limits,
          "root",
          settings.policy,
        );
        await until(() => requests === 1);
        const original = c.store.attempts(root.id)[0]!;
        const guidance = await c.submitGuidance(
          root.id,
          "steer",
          "same turn correction",
        );
        assert.equal(guidance.state, "delivered");
        assert.equal(c.store.agent(root.id).turns, 1);
        const result = await c.replaceScope(root.id, "replace", 0, "NEW_SCOPE");
        await until(
          () => c.store.attempts(root.id).length === 2 && requests === 2,
        );
        const attempts = c.store.attempts(root.id);
        assert.equal(attempts[0]!.state, "interrupted");
        assert.notEqual(attempts[1]!.turn_id, original.turn_id);
        assert.match(attempts[1]!.input, /NEW_SCOPE/);
        assert.doesNotMatch(attempts[1]!.input, /OLD_SCOPE/);
        await c.control(root.id, "pause", "subtree", true);
        await until(
          () => c.store.attempts(root.id)[1]!.state === "interrupted",
        );
        const binding = c.store.binding(root.id);
        await c.stop();
        c = new Coordinator(options);
        await c.start();
        const replay = await c.replaceScope(root.id, "replace", 0, "NEW_SCOPE");
        assert.deepEqual(replay.receipt, result.receipt);
        assert.equal(replay.state, "ready");
        assert.deepEqual(c.store.binding(root.id), binding);
        assert.equal(c.store.agent(root.id).turns, 2);
        assert.equal(requests, 2);
      } finally {
        await c.stop();
        try {
          execFileSync(options.executable, ["app-server", "daemon", "stop"], {
            env: runtimeEnvironment(home),
            stdio: "pipe",
            timeout: 30000,
          });
        } finally {
          server.closeAllConnections();
          await new Promise<void>((r) => server.close(() => r()));
          if (previous === undefined) delete process.env.CAT_SCOPE_FIXTURE_KEY;
          else process.env.CAT_SCOPE_FIXTURE_KEY = previous;
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  );
