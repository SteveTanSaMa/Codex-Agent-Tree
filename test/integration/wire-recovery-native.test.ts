import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";
import {
  CodexRuntime,
  runtimeEnvironment,
} from "../../src/runtime/codex/adapter.ts";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import { rootSettings } from "../../src/storage/interaction.ts";
import { emit, scriptedProvider } from "../fixtures/scripted-provider.ts";
async function until(check: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "wire recovery did not settle");
    await new Promise((r) => setTimeout(r, 10));
  }
}
test(
  "actual Unix/WebSocket proxy loses accepted start ACK, then duplicates completion and delays start without native replay",
  { skip: process.env.CAT_TEST_NATIVE !== "1", timeout: 120000 },
  async () => {
    for (let repetition = 0; repetition < 3; repetition++) {
      const base = mkdtempSync("/tmp/cat-wire-"),
        home = join(base, "h"),
        proxyPath = join(base, "p.sock");
      const provider = await scriptedProvider(home, (_body, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        emit(res, "response.created", {
          response: { id: "resp_hold", status: "in_progress", output: [] },
        });
      });
      const server = createServer(),
        wss = new WebSocketServer({ server });
      let nativePath = "",
        startId: string | number | undefined,
        acceptedId: string | undefined,
        dropped = false,
        heldStart: string | undefined;
      const sockets = new Set<WebSocket>();
      wss.on("connection", (downstream) => {
        const upstream = new WebSocket(`ws+unix://${nativePath}:/`);
        sockets.add(downstream);
        sockets.add(upstream);
        downstream.on("error", () => {});
        upstream.on("error", () => {});
        const pending: string[] = [];
        upstream.on("open", () => {
          for (const packet of pending) upstream.send(packet);
        });
        downstream.on("message", (bytes) => {
          const packet = String(bytes),
            value = JSON.parse(packet);
          if (value.method === "turn/start" && !dropped) startId = value.id;
          if (upstream.readyState === WebSocket.OPEN) upstream.send(packet);
          else pending.push(packet);
        });
        upstream.on("message", (bytes) => {
          const packet = String(bytes),
            value = JSON.parse(packet);
          if (
            !dropped &&
            startId !== undefined &&
            value.method === "turn/started"
          ) {
            heldStart = packet;
            return;
          }
          if (
            !dropped &&
            startId !== undefined &&
            value.id === startId &&
            value.result?.turn?.id
          ) {
            acceptedId = value.result.turn.id;
            dropped = true;
            // Drop a real wire reply after the native server accepted the Turn.
            downstream.terminate();
            upstream.terminate();
            return;
          }
          if (downstream.readyState !== WebSocket.OPEN) return;
          downstream.send(packet);
          if (dropped && value.method === "turn/completed") {
            downstream.send(packet);
            if (heldStart) downstream.send(heldStart);
          }
        });
        downstream.on("close", () => {
          if (upstream.readyState === WebSocket.OPEN) upstream.close();
        });
      });
      await new Promise<void>((r) => server.listen(proxyPath, r));
      const executable = process.env.CAT_TEST_CODEX ?? "codex";
      class ProxyRuntime extends CodexRuntime {
        protected override async command(args: string[]) {
          const result = await super.command(args);
          if (args.join(" ") === "app-server daemon start") {
            const lifecycle = JSON.parse(result);
            nativePath = lifecycle.socketPath;
            lifecycle.socketPath = proxyPath;
            return JSON.stringify(lifecycle);
          }
          return result;
        }
      }
      const options = {
        stateDirectory: join(base, "s"),
        runtimeHome: home,
        executable,
        credential: provider.credential,
      };
      const runtime = () =>
        new ProxyRuntime({ home, executable, credential: provider.credential });
      let c = new Coordinator(options, runtime());
      try {
        await c.start();
        const settings = rootSettings({ maxTurns: 2, maxTotalTurns: 2 });
        const root = c.createRoot(
          "Lead",
          "Hold the scripted stream",
          settings.limits,
          "root",
          settings.policy,
        );
        await until(
          () => dropped && c.store.attempts(root.id)[0]?.state === "unknown",
        );
        await until(() => provider.bodies.length === 1);
        const binding = c.store.binding(root.id);
        await c.stop();
        c = new Coordinator(options, runtime());
        await c.start();
        const adopted = c.store.attempts(root.id);
        assert.equal(adopted.length, 1);
        assert.equal(adopted[0]!.turn_id, acceptedId);
        assert.equal(adopted[0]!.state, "running");
        assert.deepEqual(c.store.binding(root.id), binding);
        await c.control(root.id, "pause", "subtree", true);
        await until(
          () => c.store.attempts(root.id)[0]!.state === "interrupted",
        );
        await c.control(root.id, "resume");
        assert.equal(c.store.attemptCount(root.id), 1);
        assert.equal(provider.bodies.length, 1);
        assert.equal(c.status(root.id).execution, "idle");
      } finally {
        await c.stop();
        for (const socket of sockets) socket.terminate();
        await new Promise<void>((r) => wss.close(() => r()));
        await new Promise<void>((r) => server.close(() => r()));
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
    }
  },
);
