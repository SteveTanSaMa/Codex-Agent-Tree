import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import { rootSettings } from "../../src/storage/interaction.ts";
import {
  CodexRuntime,
  runtimeEnvironment,
} from "../../src/runtime/codex/adapter.ts";
import { RpcFailure } from "../../src/runtime/codex/vendor/jsonrpc-client.ts";
import { writeEvidence } from "../fixtures/evidence.ts";
const execute = promisify(execFile);
async function until(check: () => boolean, ms = 7000) {
  const end = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < end, "native condition did not settle");
    await new Promise((r) => setTimeout(r, 10));
  }
}
class DiscardSteerReply extends CodexRuntime {
  calls = 0;
  acceptedTurn: string | undefined;
  override async steerTurn(
    thread: string,
    turn: string,
    input: string,
    id: string,
  ): Promise<string> {
    this.calls++;
    this.acceptedTurn = await super.steerTurn(thread, turn, input, id);
    throw new RpcFailure(
      "Injected caller-side loss after actual native acceptance",
      "unknown",
    );
  }
}

test(
  "native accepted steer with discarded reply remains quarantined across Coordinator restart without replay",
  { skip: process.env.CAT_TEST_NATIVE !== "1", timeout: 45000 },
  async () => {
    const base = mkdtempSync("/tmp/cat-guidance-loss-");
    const home = join(base, "h");
    const { mkdirSync } = await import("node:fs");
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
      `model="fixture"\nmodel_provider="loopback"\n[model_providers.loopback]\nname="loopback"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nenv_key="CAT_GAP_LOOPBACK_KEY"\nsupports_websockets=false\nrequires_openai_auth=false\n[features]\nmulti_agent=false\nshell_tool=false\nunified_exec=false\n`,
    );
    const previous = process.env.CAT_GAP_LOOPBACK_KEY;
    process.env.CAT_GAP_LOOPBACK_KEY = "local-fixture-only";
    const executable = process.env.CAT_TEST_CODEX ?? "codex";
    const options = {
      stateDirectory: join(base, "s"),
      runtimeHome: home,
      executable,
      expectedVersion: "codex-cli 0.162.0-alpha.17.2",
      credential: { envKey: "CAT_GAP_LOOPBACK_KEY" },
    };
    const runtime = new DiscardSteerReply({
      home,
      executable,
      expectedVersion: options.expectedVersion,
      credential: options.credential,
    });
    let c = new Coordinator(options, runtime);
    try {
      await c.start();
      const settings = rootSettings({ maxTotalTurns: 3, maxTurns: 3 });
      const root = c.createRoot(
        "Lead",
        "hold",
        settings.limits,
        "root",
        settings.policy,
      );
      await until(() => requests > 0);
      const original = c.store.attempts(root.id)[0]!;
      const message = await c.submitGuidance(
        root.id,
        "lost-steer-reply",
        "correction",
      );
      assert.equal(message.state, "unknown");
      assert.equal(runtime.calls, 1);
      assert.equal(runtime.acceptedTurn, original.turn_id);
      await c.stop();
      c = new Coordinator(options, runtime);
      await c.start();
      const after = c.store.attempts(root.id);
      assert.equal(after.length, 1);
      assert.equal(after[0]!.turn_id, original.turn_id);
      assert.equal(c.store.interaction.guidance(root.id)[0]!.state, "unknown");
      const again = await c.submitGuidance(
        root.id,
        "lost-steer-reply",
        "correction",
      );
      assert.equal(again.message_id, message.message_id);
      assert.equal(again.state, "unknown");
      assert.equal(runtime.calls, 1);
      await c.control(root.id, "pause", "subtree", true);
      await until(() =>
        c.store
          .attempts(root.id)
          .every((t) =>
            ["completed", "failed", "interrupted"].includes(t.state),
          ),
      );
      assert.equal(c.store.agent(root.id).turns, 1);
      assert.equal(c.store.messages(root.id)[0]!.status, "unknown");
      writeEvidence("guidance-ack-loss-native.json", {
        origin:
          "actual pinned CLI + local scripted SSE; native acceptance reply deliberately discarded at caller, not a random network-loss claim",
        nativeTurn: original.turn_id,
        steerCalls: runtime.calls,
        preparedTurns: 1,
        guidance: c.store.interaction.guidance(root.id),
        attempt: c.store.attempts(root.id)[0],
        history: await runtime.readThread(original.thread_id),
      });
    } finally {
      await c.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      try {
        await execute(executable, ["app-server", "daemon", "stop"], {
          env: runtimeEnvironment(home),
          timeout: 10000,
        });
      } finally {
        if (previous === undefined) delete process.env.CAT_GAP_LOOPBACK_KEY;
        else process.env.CAT_GAP_LOOPBACK_KEY = previous;
        rmSync(base, { recursive: true, force: true });
      }
    }
  },
);

test(
  "native configured-provider HTTP 401 becomes one failed Attempt without a business retry",
  { skip: process.env.CAT_TEST_NATIVE !== "1", timeout: 45000 },
  async () => {
    const base = mkdtempSync("/tmp/cat-provider-401-");
    const home = join(base, "h");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(home);
    let requests = 0;
    let expectedCredential = true;
    const server = createServer((req, res) => {
      requests++;
      expectedCredential =
        expectedCredential &&
        req.headers.authorization === "Bearer local-401-fixture";
      req.resume();
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "qualification fixture unauthorized",
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    writeFileSync(
      join(home, "config.toml"),
      `model="fixture"\nmodel_provider="negative"\n[model_providers.negative]\nname="negative"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nenv_key="CAT_GAP_NEGATIVE_KEY"\nsupports_websockets=false\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n[features]\nmulti_agent=false\nshell_tool=false\nunified_exec=false\n`,
    );
    const previous = process.env.CAT_GAP_NEGATIVE_KEY;
    process.env.CAT_GAP_NEGATIVE_KEY = "local-401-fixture";
    const executable = process.env.CAT_TEST_CODEX ?? "codex";
    const options = {
      stateDirectory: join(base, "s"),
      runtimeHome: home,
      executable,
      expectedVersion: "codex-cli 0.162.0-alpha.17.2",
      credential: { envKey: "CAT_GAP_NEGATIVE_KEY" },
    };
    const runtime = new CodexRuntime({
      home,
      executable,
      expectedVersion: options.expectedVersion,
      credential: options.credential,
    });
    const c = new Coordinator(options, runtime);
    try {
      await c.start();
      const settings = rootSettings({ maxTotalTurns: 2, maxTurns: 2 });
      const root = c.createRoot(
        "Lead",
        "Never execute tools; authentication-negative fixture only",
        settings.limits,
        "root",
        settings.policy,
      );
      await until(
        () => c.store.attempts(root.id).some((a) => a.state === "failed"),
        15000,
      );
      const attempts = c.store.attempts(root.id);
      assert.equal(attempts.length, 1);
      assert.ok(requests > 0);
      assert.ok(expectedCredential);
      const history = await runtime.readThread(
        c.store.binding(root.id)!.thread_id,
      );
      writeEvidence("provider-http-401-native.json", {
        origin:
          "actual pinned CLI with scripted localhost HTTP 401; no real provider credentials",
        requests,
        expectedFixtureCredentialOnly: expectedCredential,
        attempts,
        history,
      });
    } finally {
      await c.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      try {
        await execute(executable, ["app-server", "daemon", "stop"], {
          env: runtimeEnvironment(home),
          timeout: 10000,
        });
      } finally {
        if (previous === undefined) delete process.env.CAT_GAP_NEGATIVE_KEY;
        else process.env.CAT_GAP_NEGATIVE_KEY = previous;
        rmSync(base, { recursive: true, force: true });
      }
    }
  },
);
