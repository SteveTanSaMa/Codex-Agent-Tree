import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CodexRuntime,
  runtimeEnvironment,
} from "../../src/runtime/codex/adapter.ts";
const execute = promisify(execFile);
// Scripted loopback Responses stream: exercises the real pinned CLI, never a paid model.
test(
  "pinned native Turn accepts expected-ID steering and rejects a stale ID",
  { skip: process.env.CAT_TEST_NATIVE !== "1", timeout: 30000 },
  async () => {
    const home = mkdtempSync("/tmp/cat-steer-native-");
    const executable = process.env.CAT_TEST_CODEX ?? "codex";
    let seen!: () => void;
    const requestSeen = new Promise<void>((r) => (seen = r));
    const server = createServer((req, res) => {
      seen();
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_fixture","status":"in_progress","output":[]}}\n\n',
      );
      // Hold until turn/interrupt; no model-generated content or external service.
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    writeFileSync(
      join(home, "config.toml"),
      `model="fixture"\nmodel_provider="loopback"\n[model_providers.loopback]\nname="loopback"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nenv_key="CAT_FIXTURE_API_KEY"\nsupports_websockets=false\nrequires_openai_auth=false\n[features]\nmulti_agent=false\nshell_tool=false\nunified_exec=false\n`,
    );
    const previousKey = process.env.CAT_FIXTURE_API_KEY;
    process.env.CAT_FIXTURE_API_KEY = "local-test-only";
    const runtime = new CodexRuntime({
      home,
      executable,
      credential: { envKey: "CAT_FIXTURE_API_KEY" },
      expectedVersion: "codex-cli 0.162.0-alpha.17.2",
    });
    try {
      await runtime.connect();
      const thread = await runtime.createThread(
        home,
        [],
        "Protocol fixture only.",
      );
      const turn = await runtime.startTurn(thread, "hold", "fixture-attempt");
      await Promise.race([
        requestSeen,
        new Promise<never>((_, reject) => {
          const t = setTimeout(
            () => reject(new Error("Loopback model request did not start")),
            5000,
          );
          t.unref();
        }),
      ]);
      assert.equal(
        await runtime.steerTurn(
          thread,
          turn,
          "change direction",
          "fixture-guidance",
        ),
        turn,
      );
      await assert.rejects(
        runtime.steerTurn(
          thread,
          "stale-turn",
          "wrong target",
          "stale-guidance",
        ),
      );
      try {
        await runtime.interrupt(thread, turn);
      } catch {
        const history = await runtime.readThread(thread);
        const t = (
          history.thread as { turns: { id: string; status: string }[] }
        ).turns.find((t) => t.id === turn);
        assert.ok(
          t && ["completed", "failed", "interrupted"].includes(t.status),
          JSON.stringify(history),
        );
      }
    } finally {
      runtime.disconnect();
      if (previousKey === undefined) delete process.env.CAT_FIXTURE_API_KEY;
      else process.env.CAT_FIXTURE_API_KEY = previousKey;
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      try {
        await execute(executable, ["app-server", "daemon", "stop"], {
          env: runtimeEnvironment(home),
          timeout: 10000,
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  },
);
