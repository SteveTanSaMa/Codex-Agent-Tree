#!/usr/bin/env node
import { handoff, previewHandoff } from "../workspace/handoff.ts";
import { diagnose } from "./diagnose.ts";
import { rootSettings } from "../storage/interaction.ts";
import { Store } from "../storage/store.ts";
import {
  workspacePolicy,
  multiWorkspacePolicy,
  repositories,
  assertWorkspaceSeparation,
  type TestCommand,
} from "../workspace/broker.ts";
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
import { record, validateCredential } from "../runtime/codex/adapter.ts";
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
function turnLimit(value: unknown): number | null {
  return value === "unlimited" || value === null
    ? null
    : integer(Number(value), "Turn limit", 1);
}
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
    socket.setEncoding("utf8");
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
    socket.setEncoding("utf8");
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
          else if (input.method === "limits")
            result = coordinator.setTurnLimits(
              text(p.target, "target", 256),
              p.patch as {
                maxTotalTurns?: number | null;
                maxTurnsPerAgent?: number | null;
                maxAgents?: number;
              },
              text(p.reason, "reason", 2048),
            );
          else if (input.method === "token-reminder")
            result = coordinator.store.reminders.configure(
              text(p.target, "target", 256),
              (p.scope ?? "agent") as "agent" | "tree",
              p.policy,
            );
          else if (input.method === "interaction")
            result = coordinator.store.interaction.configure(
              text(p.target, "target", 256),
              p.policy,
            );
          else if (input.method === "check-in") {
            coordinator.store.interaction.checkIn(
              text(p.target, "target", 256),
            );
            result = coordinator.status(String(p.target));
          } else if (input.method === "guidance-resolve") {
            requireCondition(
              p.outcome === "delivered" || p.outcome === "retry-next",
              "INVALID_INPUT",
              "Invalid guidance resolution",
            );
            result = await coordinator.resolveGuidance(
              text(p.target, "target", 256),
              text(p.messageId, "message ID", 256),
              p.outcome,
              text(p.reason, "review reason", 2048),
            );
          } else if (input.method === "view")
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
          else if (
            input.method === "handoff-record" ||
            input.method === "handoff-preview"
          ) {
            requireCondition(
              coordinator.workspace,
              "FORBIDDEN",
              "No coding workspace authorized",
            );
            result =
              input.method === "handoff-record"
                ? handoff(
                    coordinator.store,
                    coordinator.workspace,
                    text(p.target, "target", 256),
                    record(p.input),
                  )
                : previewHandoff(
                    coordinator.store,
                    coordinator.workspace,
                    text(p.target, "target", 256),
                    text(p.id, "handoff ID", 128),
                  );
          } else if (input.method === "task-history")
            result = coordinator.store.tasks.page(
              null,
              text(p.target, "target", 256),
              Number(p.after ?? 0),
              Number(p.limit ?? 50),
              true,
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
            const { policy, limits, reminder } = rootSettings(p);
            const rootKey = text(p.requestKey, "root request key", 128);
            const existingRoot = coordinator.store.db
              .prepare("SELECT agent_id FROM root_requests WHERE request_key=?")
              .get(rootKey);
            result = coordinator.createRoot(
              text(p.name, "name", 96),
              text(p.task, "task"),
              limits,
              rootKey,
              policy,
            );
            if (!existingRoot)
              coordinator.store.reminders.configure(
                (result as { id: string }).id,
                "tree",
                reminder,
              );
          } else if (input.method === "send") {
            requireCondition(
              p.delivery === undefined ||
                ["auto", "queue", "steer"].includes(String(p.delivery)),
              "INVALID_INPUT",
              "Invalid delivery mode",
            );
            const guidance = await coordinator.submitGuidance(
              text(p.target, "target", 256),
              text(p.requestKey, "request key", 128),
              text(p.message, "message"),
              (p.delivery ?? "auto") as "auto" | "queue" | "steer",
            );
            result = { messageId: guidance.message_id, guidance };
          } else if (input.method === "command-review") {
            result = await coordinator.reviewUnknownCommand(
              text(p.target, "target", 256),
              text(p.callId, "call ID", 256),
              text(p.reason, "review reason", 2048),
            );
          } else if (input.method === "scope-replace") {
            result = await coordinator.replaceScope(
              text(p.target, "target", 256),
              text(p.requestKey, "request key", 128),
              integer(
                p.expectedGeneration as number,
                "expected scope generation",
              ),
              text(p.task, "replacement assignment"),
            );
          } else if (input.method === "control") {
            const { immediate, ...rest } = p;
            requireCondition(
              immediate === undefined || typeof immediate === "boolean",
              "INVALID_INPUT",
              "Invalid immediate flag",
            );
            const c = controlInput(rest);
            requireCondition(
              !immediate || c.action === "pause",
              "INVALID_INPUT",
              "Immediate applies only to pause",
            );
            result = await coordinator.control(
              c.target,
              c.action,
              c.scope,
              immediate === true,
            );
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
  if (command === "diagnose") {
    console.log(JSON.stringify(diagnose(state), null, 2));
  } else if (command === "handoff-record" || command === "handoff-preview") {
    console.log(
      JSON.stringify(
        await request(command, {
          target: text(flag("target"), "target"),
          ...(command === "handoff-record"
            ? {
                input: JSON.parse(
                  readFileSync(text(flag("input-file"), "input-file"), "utf8"),
                ),
              }
            : { id: text(flag("id"), "handoff ID") }),
        }),
        null,
        2,
      ),
    );
  } else if (command === "init") {
    mkdirSync(state, { recursive: true, mode: 0o700 });
    requireCondition(
      !existsSync(configPath),
      "CONFLICT",
      "Team is already initialized",
    );
    const repository = flag("workspace");
    const testsFile = flag("test-commands");
    const manifestFile = flag("workspace-config");
    requireCondition(
      !manifestFile || (!repository && !testsFile),
      "INVALID_INPUT",
      "--workspace-config cannot be combined with --workspace or --test-commands",
    );
    requireCondition(
      !testsFile || repository,
      "INVALID_INPUT",
      "--test-commands requires --workspace",
    );
    const workspace = manifestFile
      ? multiWorkspacePolicy(
          JSON.parse(readFileSync(resolve(manifestFile), "utf8")),
        )
      : repository
        ? workspacePolicy(
            repository,
            testsFile
              ? (JSON.parse(readFileSync(resolve(testsFile), "utf8")) as Record<
                  string,
                  TestCommand
                >)
              : {},
          )
        : undefined;
    const runtimeHome = resolve(
      flag("runtime-home", join(homedir(), ".cat", "runtime"))!,
    );
    if (workspace)
      for (const repo of Object.values(repositories(workspace)))
        assertWorkspaceSeparation(repo.repository, state, runtimeHome);
    for (const resource of Object.values(workspace?.readOnlyResources ?? {}))
      assertWorkspaceSeparation(resource, state, runtimeHome);
    mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
    const providerEnv = flag("provider-env");
    const keychainService = flag("keychain-service");
    const configFrom = flag("config-from");
    requireCondition(
      !keychainService || providerEnv,
      "INVALID_INPUT",
      "--keychain-service requires --provider-env",
    );
    requireCondition(
      !providerEnv ||
        configFrom ||
        existsSync(join(runtimeHome, "config.toml")),
      "INVALID_INPUT",
      "Provider credentials require --config-from or an existing dedicated runtime config",
    );
    const credential = providerEnv
      ? { envKey: providerEnv, ...(keychainService ? { keychainService } : {}) }
      : undefined;
    if (credential) validateCredential(credential);
    if (configFrom) {
      const destination = join(runtimeHome, "config.toml");
      const content = readFileSync(resolve(configFrom));
      requireCondition(
        !existsSync(destination) || readFileSync(destination).equals(content),
        "CONFLICT",
        "Runtime config already exists with different contents",
      );
      if (!existsSync(destination))
        writeFileSync(destination, content, { mode: 0o600, flag: "wx" });
    }
    const authFrom = resolve(
      flag(
        "auth-from",
        join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
      )!,
    );
    if (
      ((!providerEnv && !configFrom) || flag("auth-from")) &&
      !existsSync(join(runtimeHome, "auth.json"))
    ) {
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
          compatibilityPolicy: "capabilities-v1",
          ...(flag("executable")
            ? { executable: resolve(flag("executable")!) }
            : {}),
          ...(credential ? { credential } : {}),
          ...(workspace ? { workspace } : {}),
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
        mode: flag("mode"),
        autonomyWarnMs: flag("autonomy-warn-ms"),
        autonomyPauseMs: flag("autonomy-pause-ms"),
        stallWarnMs: flag("stall-warn-ms"),
        repeatErrorThreshold: flag("repeat-error-threshold"),
        taskTokenBudget: flag("task-token-budget"),
        taskTimeBudgetMs: flag("task-time-budget-ms"),
        tokenPolicy: flag("token-policy"),
        maxTotalTurns: flag("max-total-turns"),
        tokens: flag("tokens"),
        tokenAlertAt: flag("token-alert-at"),
        tokenAlertEvery: flag("token-alert-every"),
        tokenAlertMetric: flag("token-alert-metric"),
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
    command === "task-history" ||
    command === "task-list" ||
    command === "task-get"
  ) {
    console.log(
      JSON.stringify(
        await request(command, {
          target: text(flag("target"), "target"),
          ...(command === "task-history"
            ? {
                after: Number(flag("after", "0")),
                limit: Number(flag("limit", "50")),
              }
            : {}),
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
  else if (command === "limits") {
    const target = text(flag("target"), "target"),
      reason = text(flag("reason"), "reason", 2048);
    const patch = {
      ...(flag("max-agents") === undefined
        ? {}
        : { maxAgents: integer(Number(flag("max-agents")), "maxAgents", 1) }),
      ...(flag("max-total-turns") === undefined
        ? {}
        : { maxTotalTurns: turnLimit(flag("max-total-turns")) }),
      ...(flag("max-turns") === undefined
        ? {}
        : { maxTurnsPerAgent: turnLimit(flag("max-turns")) }),
    };
    if (args.includes("--offline")) {
      requireCondition(
        existsSync(join(state, "business.sqlite")),
        "NOT_FOUND",
        "State database is missing",
      );
      const store = new Store(join(state, "business.sqlite"));
      try {
        console.log(JSON.stringify(store.setTurnLimits(target, patch, reason)));
      } finally {
        store.close();
      }
    } else
      console.log(
        JSON.stringify(await request("limits", { target, patch, reason })),
      );
  } else if (command === "token-reminder") {
    const policy = args.includes("--disable")
      ? null
      : {
          metric: flag("metric", "total"),
          thresholdTokens: integer(Number(flag("threshold")), "threshold", 1),
          repeatEveryTokens:
            flag("every") === undefined
              ? null
              : integer(Number(flag("every")), "interval", 1),
        };
    console.log(
      JSON.stringify(
        await request("token-reminder", {
          target: text(flag("target"), "target"),
          scope: flag("scope", "agent"),
          policy,
        }),
        null,
        2,
      ),
    );
  } else if (command === "interaction") {
    const policy = JSON.parse(
      readFileSync(text(flag("input-file"), "policy file"), "utf8"),
    );
    console.log(
      JSON.stringify(
        await request("interaction", {
          target: text(flag("target"), "target"),
          policy,
        }),
        null,
        2,
      ),
    );
  } else if (command === "check-in") {
    console.log(
      JSON.stringify(
        await request("check-in", { target: text(flag("target"), "target") }),
        null,
        2,
      ),
    );
  } else if (command === "guidance-resolve") {
    console.log(
      JSON.stringify(
        await request("guidance-resolve", {
          target: text(flag("target"), "target"),
          messageId: text(flag("message-id"), "message ID"),
          outcome: flag("outcome"),
          reason: text(flag("reason"), "reason", 2048),
        }),
        null,
        2,
      ),
    );
  } else if (command === "native-history")
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
  else if (command === "send" || command === "steer")
    console.log(
      JSON.stringify(
        await request("send", {
          delivery: flag("delivery", command === "steer" ? "steer" : "auto"),
          target: text(flag("target"), "target"),
          message: text(flag("message"), "message"),
          requestKey: flag("key", randomUUID()),
        }),
      ),
    );
  else if (command === "command-review")
    console.log(
      JSON.stringify(
        await request("command-review", {
          target: text(flag("target"), "target"),
          callId: text(flag("call-id"), "call ID", 256),
          reason: text(flag("reason"), "review reason", 2048),
        }),
        null,
        2,
      ),
    );
  else if (command === "scope-replace")
    console.log(
      JSON.stringify(
        await request("scope-replace", {
          target: text(flag("target"), "target"),
          requestKey: text(flag("key"), "request key", 128),
          expectedGeneration: integer(
            Number(flag("generation")),
            "expected scope generation",
          ),
          task: text(flag("task"), "replacement assignment"),
        }),
        null,
        2,
      ),
    );
  else if (command === "control")
    console.log(
      JSON.stringify(
        await request("control", {
          target: flag("target"),
          action: flag("action"),
          immediate: args.includes("--immediate"),
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
      "Commands: diagnose (read-only), handoff-record --target ID --input-file JSON, handoff-preview --target LEAD_ID --id HANDOFF_ID, task-history --target ID [--after CURSOR --limit 50], init [--workspace CLEAN_GIT_REPO --test-commands JSON | --workspace-config JSON] [--config-from TOML --provider-env NAME [--keychain-service SERVICE] --executable PATH], start, serve, root --task TEXT [--mode interactive|batch] [--token-alert-at N --token-alert-every N --token-alert-metric total|uncachedInput|output] [--max-total-turns N|unlimited], tree, view --target ID, wait --target ID --after CURSOR [--timeout-ms 25000], task-create --target ID --key KEY --subject TEXT --description TEXT, task-list --target ID, task-get --target ID --task-id TASK, task-update --target ID --task-id TASK --key KEY --revision N --action ACTION [--result TEXT|--owner-id ID|null], status --target ID, send|steer --target ID --message TEXT [--key KEY] [--delivery auto|queue|steer], token-reminder --target ID [--scope agent|tree] --threshold N [--every N --metric total|uncachedInput|output] [--disable], interaction --target ID --input-file POLICY.json, check-in --target ID, guidance-resolve --target ID --message-id ID --outcome delivered|retry-next --reason TEXT, scope-replace --target ID --key KEY --generation N --task TEXT, command-review --target ID --call-id ID --reason TEXT, control --target ID --action pause|resume|cancel|terminate [--immediate], limits --target ID [--max-agents N] --max-total-turns N|unlimited --max-turns N|unlimited --reason TEXT [--offline], native-history --target ID, release-quarantine --target ID --reason TEXT, settle-usage --attempt ID --tokens N --reason TEXT, stop. Task writes accept --input-file JSON. All accept --state DIR.",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
}
