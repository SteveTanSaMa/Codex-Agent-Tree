#!/usr/bin/env node
import { createServer, createConnection, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  unlinkSync,
  lstatSync,
  constants,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Coordinator,
  type CoordinatorOptions,
} from "../coordinator/coordinator.ts";
import { record } from "../runtime/codex/adapter.ts";
import { requireCondition, text, integer } from "../core/errors.ts";
import { controlInput } from "../tools/inputs.ts";

const args = process.argv.slice(2);
const command = args.shift() ?? "help";
function flag(name: string, fallback?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
}
const state = resolve(flag("state", join(homedir(), ".cat", "team"))!);
const configPath = join(state, "config.json");
const tokenPath = join(state, "operator-token");
const socketPath = join(state, "control.sock");
function config(): CoordinatorOptions {
  return JSON.parse(readFileSync(configPath, "utf8")) as CoordinatorOptions;
}
function token(): string {
  return readFileSync(tokenPath, "utf8").trim();
}
function sameToken(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const a = Buffer.from(value);
  const b = Buffer.from(token());
  return a.length === b.length && timingSafeEqual(a, b);
}
async function request(
  method: string,
  params: object = {},
  timeout = 30000,
): Promise<unknown> {
  return new Promise((yes, no) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(
      () =>
        socket.destroy(
          new Error("Control request timed out; outcome may be unknown"),
        ),
      timeout,
    );
    socket.once("connect", () =>
      socket.write(JSON.stringify({ token: token(), method, params }) + "\n"),
    );
    socket.on("data", (data) => {
      buffer += data.toString();
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
        socket.destroy(new Error("Control response too large"));
        return;
      }
      const i = buffer.indexOf("\n");
      if (i < 0) return;
      try {
        const response = record(JSON.parse(buffer.slice(0, i)));
        if (response.error) no(new Error(String(response.error)));
        else yes(response.result);
      } catch (e) {
        no(e);
      } finally {
        socket.end();
        clearTimeout(timer);
      }
    });
    socket.once("error", (e) => {
      clearTimeout(timer);
      no(e);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      if (!buffer.includes("\n"))
        no(
          new Error(
            "Control connection closed before acknowledgment; inspect status before retry",
          ),
        );
    });
  });
}
async function serve() {
  requireCondition(
    Buffer.byteLength(socketPath) < 104,
    "INVALID_INPUT",
    "Choose a shorter state directory for the control socket",
  );
  const existing = lstatSync(socketPath, { throwIfNoEntry: false });
  requireCondition(
    !existing || existing.isSocket(),
    "CONFLICT",
    "Refusing to remove a non-socket control path; choose a dedicated state directory",
  );
  const coordinator = new Coordinator(config()); // Claims ownership before touching a stale socket.
  const stale = lstatSync(socketPath, { throwIfNoEntry: false });
  if (stale && !stale.isSocket()) {
    await coordinator.stop();
    throw new Error("Control path changed to a non-socket; nothing removed");
  }
  if (stale) unlinkSync(socketPath);
  let ownSocket: { ino: bigint; dev: bigint } | undefined;
  const connections = new Set<Socket>();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const channelClosed = new Promise<void>((yes, no) => {
      const timer = setTimeout(() => {
        for (const socket of connections) socket.destroy();
      }, 5000);
      server.close((error) => {
        clearTimeout(timer);
        if (error) {
          no(error);
          return;
        }
        try {
          const entry = lstatSync(socketPath, {
            bigint: true,
            throwIfNoEntry: false,
          });
          if (
            entry &&
            entry.isSocket() &&
            entry.ino === ownSocket?.ino &&
            entry.dev === ownSocket.dev
          )
            unlinkSync(socketPath);
          yes();
        } catch (error) {
          no(error);
        }
      });
    });
    // Keep the DB owner until the old control channel is completely closed and cleaned up.
    await coordinator.stop(channelClosed);
  };
  const server = createServer((socket) => {
    connections.add(socket);
    const abandoned = new AbortController();
    socket.once("close", () => abandoned.abort());
    socket.once("close", () => connections.delete(socket));
    let buffer = "";
    socket.setTimeout(10000, () => socket.destroy());
    socket.on("error", () => {
      /* A client disconnection does not cancel an accepted operation. */
    });
    socket.on("data", (data) => {
      buffer += data.toString();
      if (Buffer.byteLength(buffer) > 128 * 1024) {
        socket.destroy();
        return;
      }
      const i = buffer.indexOf("\n");
      if (i < 0) return;
      socket.removeAllListeners("data");
      void (async () => {
        try {
          const input = record(JSON.parse(buffer.slice(0, i)));
          requireCondition(
            sameToken(input.token),
            "FORBIDDEN",
            "Operator authentication failed",
          );
          requireCondition(
            !closing,
            "STATE_BLOCKED",
            "Coordinator is stopping",
          );
          const p = record(input.params);
          let result: unknown;
          if (input.method === "ping") result = coordinator.diagnostics();
          else if (input.method === "view")
            result = coordinator.view(text(p.target, "target", 256));
          else if (input.method === "wait") {
            socket.setTimeout(0); // Coordinator owns a bounded deadline and disconnect cancellation.
            result = await coordinator.wait(
              text(p.target, "target", 256),
              integer(p.after as number, "after cursor"),
              integer(p.timeoutMs as number, "timeoutMs"),
              abandoned.signal,
            );
          } else if (input.method === "task-create")
            result = coordinator.store.tasks.create(
              null,
              text(p.target, "target", 256),
              p.input,
            );
          else if (input.method === "task-update")
            result = coordinator.store.tasks.update(
              null,
              text(p.target, "target", 256),
              p.input,
            );
          else if (input.method === "task-get")
            result = coordinator.store.tasks.get(
              null,
              text(p.target, "target", 256),
              text(p.taskId, "task ID", 256),
            );
          else if (input.method === "task-list")
            result = coordinator.store.tasks.list(
              null,
              text(p.target, "target", 256),
            );
          else if (input.method === "list")
            result = coordinator.store
              .agents()
              .map((a) => coordinator.status(a.id));
          else if (input.method === "status")
            result = coordinator.status(text(p.target, "target", 256));
          else if (input.method === "events")
            result = coordinator.store.events(text(p.target, "target", 256));
          else if (input.method === "native-history")
            result = await coordinator.nativeHistory(
              text(p.target, "target", 256),
            );
          else if (input.method === "settle-usage")
            result = await coordinator.settleUsage(
              text(p.attempt, "attempt", 256),
              integer(p.tokens as number, "final tokens"),
              text(p.reason, "settlement reason", 2048),
            );
          else if (input.method === "release-quarantine")
            result = await coordinator.releaseQuarantine(
              text(p.target, "target", 256),
              text(p.reason, "review reason", 2048),
            );
          else if (input.method === "root") {
            const defaults = {
              tokens: 200000,
              maxDepth: 2,
              maxAgents: 16,
              maxConcurrentTurns: 3,
              maxTurnsPerAgent: 20,
              turnReservation: 5000,
            };
            const limits = {
              tokenPolicy: (p.tokenPolicy ?? "observe") as
                "observe" | "enforce",
              maxTotalTurns: Number(p.maxTotalTurns ?? 100),
              tokens: Number(p.tokens ?? defaults.tokens),
              maxDepth: Number(p.maxDepth ?? defaults.maxDepth),
              maxAgents: Number(p.maxAgents ?? defaults.maxAgents),
              maxConcurrentTurns: Number(
                p.concurrent ?? defaults.maxConcurrentTurns,
              ),
              maxTurnsPerAgent: Number(p.maxTurns ?? defaults.maxTurnsPerAgent),
              turnReservation: Number(p.reserve ?? defaults.turnReservation),
            };
            result = coordinator.createRoot(
              text(p.name, "name", 96),
              text(p.task, "task"),
              limits,
              text(p.requestKey, "root request key", 128),
            );
          } else if (input.method === "send")
            result = {
              messageId: coordinator.submitInput(
                text(p.target, "target", 256),
                text(p.requestKey, "request key", 128),
                text(p.message, "message"),
              ),
            };
          else if (input.method === "control") {
            const c = controlInput(p);
            result = await coordinator.control(c.target, c.action, c.scope);
          } else if (input.method === "stop") result = { stopping: true };
          else throw new Error("Unknown control method");
          socket.end(JSON.stringify({ result }) + "\n");
          if (input.method === "stop")
            setImmediate(() => {
              void shutdown().catch(() => {
                process.exitCode = 1;
              });
            });
        } catch (error) {
          socket.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : "Control failed",
            }) + "\n",
          );
        }
      })();
    });
  });
  try {
    await coordinator.start();
    await new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen(socketPath, () => {
        chmodSync(socketPath, 0o600);
        const entry = lstatSync(socketPath, { bigint: true });
        ownSocket = { ino: entry.ino, dev: entry.dev };
        yes();
      });
    });
  } catch (error) {
    await coordinator.stop();
    throw error;
  }
  process.once("SIGTERM", () => {
    void shutdown().catch(() => {
      process.exitCode = 1;
    });
  });
  process.once("SIGINT", () => {
    void shutdown().catch(() => {
      process.exitCode = 1;
    });
  });
}
try {
  if (command === "init") {
    mkdirSync(state, { recursive: true, mode: 0o700 });
    requireCondition(
      !existsSync(configPath),
      "CONFLICT",
      "Team is already initialized",
    );
    const runtimeHome = resolve(
      flag("runtime-home", join(homedir(), ".cat", "runtime"))!,
    );
    mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
    const authFrom = resolve(
      flag(
        "auth-from",
        join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
      )!,
    );
    if (!existsSync(join(runtimeHome, "auth.json"))) {
      copyFileSync(
        authFrom,
        join(runtimeHome, "auth.json"),
        constants.COPYFILE_EXCL,
      );
      chmodSync(join(runtimeHome, "auth.json"), 0o600);
    }
    if (!existsSync(join(runtimeHome, "config.toml")))
      writeFileSync(
        join(runtimeHome, "config.toml"),
        "[features]\nmulti_agent=false\nshell_tool=false\nunified_exec=false\n",
        { mode: 0o600, flag: "wx" },
      );
    writeFileSync(tokenPath, randomBytes(32).toString("hex") + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          stateDirectory: state,
          runtimeHome,
          expectedVersion: "codex-cli 0.162.0-alpha.17.2",
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    console.log(JSON.stringify({ initialized: state, runtimeHome }));
  } else if (command === "serve") await serve();
  else if (command === "start") {
    let existing = false;
    try {
      await request("ping", {}, 1000);
      existing = true;
    } catch {
      /* The SQLite owner check remains authoritative in serve. */
    }
    if (!existing) {
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), "serve", "--state", state],
        { detached: true, stdio: "ignore" },
      );
      let failure: string | undefined;
      child.once("exit", (code, signal) => {
        failure = `exit ${code ?? signal ?? "unknown"}`;
      });
      child.once("error", () => {
        failure = "process launch failed";
      });
      child.unref();
      let ready = false;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        try {
          await request("ping", {}, 1000);
          ready = true;
          break;
        } catch {
          if (failure) break;
          await new Promise<void>((r) => setTimeout(r, 200));
        }
      }
      requireCondition(
        ready,
        "STATE_BLOCKED",
        `Coordinator did not become ready${failure ? ` (${failure})` : ""}; run serve in foreground to inspect startup`,
      );
    }
    console.log(JSON.stringify(await request("ping")));
  } else if (command === "root") {
    const root = record(
      await request("root", {
        name: flag("name", "Root"),
        task: text(flag("task"), "task"),
        requestKey: flag("key", randomUUID()),
        tokenPolicy: flag("token-policy"),
        maxTotalTurns: flag("max-total-turns"),
        tokens: flag("tokens"),
        maxDepth: flag("max-depth"),
        maxAgents: flag("max-agents"),
        concurrent: flag("concurrent"),
        maxTurns: flag("max-turns"),
        reserve: flag("reserve"),
      }),
    );
    if (args.includes("--wait-for-child")) {
      const deadline = Date.now() + 120000;
      let observed = false;
      while (Date.now() < deadline) {
        const agents = (await request("list")) as Array<{
          parent_id: string | null;
        }>;
        if (agents.some((a) => a.parent_id === root.id)) {
          observed = true;
          break;
        }
        await new Promise<void>((r) => setTimeout(r, 100));
      }
      requireCondition(
        observed,
        "STATE_BLOCKED",
        "Root has not created a child; inspect the existing team before retrying",
      );
    }
    console.log(JSON.stringify(root));
  } else if (
    command === "view" ||
    command === "task-list" ||
    command === "task-get"
  ) {
    console.log(
      JSON.stringify(
        await request(command, {
          target: text(flag("target"), "target"),
          ...(command === "task-get"
            ? { taskId: text(flag("task-id"), "task ID") }
            : {}),
        }),
        null,
        2,
      ),
    );
  } else if (command === "wait") {
    const timeoutMs = integer(Number(flag("timeout-ms", "25000")), "timeoutMs");
    requireCondition(
      timeoutMs <= 30000,
      "INVALID_INPUT",
      "Wait timeout must be at most 30000 ms",
    );
    console.log(
      JSON.stringify(
        await request(
          "wait",
          {
            target: text(flag("target"), "target"),
            after: integer(Number(flag("after", "0")), "after cursor"),
            timeoutMs,
          },
          timeoutMs + 5000,
        ),
        null,
        2,
      ),
    );
  } else if (command === "task-create" || command === "task-update") {
    const inputFile = flag("input-file");
    const input: unknown = inputFile
      ? JSON.parse(readFileSync(inputFile, "utf8"))
      : {
          requestKey: text(flag("key"), "request key", 128),
          ...(command === "task-create"
            ? {
                subject: text(flag("subject"), "task subject", 200),
                description: text(
                  flag("description"),
                  "task description",
                  8000,
                ),
              }
            : {
                taskId: text(flag("task-id"), "task ID", 256),
                expectedRevision: integer(
                  Number(flag("revision")),
                  "revision",
                  1,
                ),
                action: text(flag("action"), "task action", 32),
              }),
          ...(flag("subject") && command === "task-update"
            ? { subject: flag("subject") }
            : {}),
          ...(flag("description") && command === "task-update"
            ? { description: flag("description") }
            : {}),
          ...(flag("blocked-by") === undefined
            ? {}
            : { blockedBy: JSON.parse(flag("blocked-by")!) }),
          ...(flag("write-scopes") === undefined
            ? {}
            : { writeScopes: JSON.parse(flag("write-scopes")!) }),
          ...(flag("owner-id") === undefined
            ? {}
            : {
                ownerId: flag("owner-id") === "null" ? null : flag("owner-id"),
              }),
          ...(flag("result") === undefined ? {} : { result: flag("result") }),
        };
    console.log(
      JSON.stringify(
        await request(command, {
          target: text(flag("target"), "target"),
          input,
        }),
        null,
        2,
      ),
    );
  } else if (command === "tree" || command === "list")
    console.log(JSON.stringify(await request("list"), null, 2));
  else if (command === "status")
    console.log(
      JSON.stringify(
        await request("status", { target: text(flag("target"), "target") }),
        null,
        2,
      ),
    );
  else if (command === "native-history")
    console.log(
      JSON.stringify(
        await request("native-history", {
          target: text(flag("target"), "target"),
        }),
        null,
        2,
      ),
    );
  else if (command === "settle-usage")
    console.log(
      JSON.stringify(
        await request("settle-usage", {
          attempt: text(flag("attempt"), "attempt"),
          tokens: integer(Number(flag("tokens")), "final tokens"),
          reason: text(flag("reason"), "settlement reason"),
        }),
        null,
        2,
      ),
    );
  else if (command === "release-quarantine")
    console.log(
      JSON.stringify(
        await request("release-quarantine", {
          target: text(flag("target"), "target"),
          reason: text(flag("reason"), "review reason"),
        }),
        null,
        2,
      ),
    );
  else if (command === "events")
    console.log(
      JSON.stringify(
        await request("events", { target: text(flag("target"), "target") }),
        null,
        2,
      ),
    );
  else if (command === "send")
    console.log(
      JSON.stringify(
        await request("send", {
          target: text(flag("target"), "target"),
          message: text(flag("message"), "message"),
          requestKey: flag("key", randomUUID()),
        }),
      ),
    );
  else if (command === "control")
    console.log(
      JSON.stringify(
        await request("control", {
          target: flag("target"),
          action: flag("action"),
          scope: flag("scope", "subtree"),
        }),
        null,
        2,
      ),
    );
  else if (command === "stop")
    console.log(JSON.stringify(await request("stop")));
  else
    console.log(
      "Commands: init, start, serve, root --task TEXT [--token-policy observe|enforce] [--max-total-turns 100], tree, view --target ID, wait --target ID --after CURSOR [--timeout-ms 25000], task-create --target ID --key KEY --subject TEXT --description TEXT, task-list --target ID, task-get --target ID --task-id TASK, task-update --target ID --task-id TASK --key KEY --revision N --action ACTION [--result TEXT|--owner-id ID|null], status --target ID, send --target ID --message TEXT [--key KEY], control --target ID --action pause|resume|cancel|terminate, native-history --target ID, release-quarantine --target ID --reason TEXT, settle-usage --attempt ID --tokens N --reason TEXT, stop. Task writes accept --input-file JSON. All accept --state DIR.",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
}
