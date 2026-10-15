import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import {
  CodexRuntime,
  record,
  runtimeEnvironment,
} from "../../src/runtime/codex/adapter.ts";
import { workspacePolicy } from "../../src/workspace/broker.ts";
const execute = promisify(execFile);
test(
  "real coding team: audited Lead terminal, isolated coder and read-only recursive reviewer",
  { skip: process.env.CAT_TEST_CODING !== "1", timeout: 240000 },
  async () => {
    const binary = process.env.CAT_CODEX_EXECUTABLE;
    assert.ok(binary, "Explicit CAT_CODEX_EXECUTABLE is required");
    const source = join(homedir(), ".codex-cli/config.toml"),
      original = readFileSync(source);
    const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const base = mkdtempSync("/tmp/cat-beta-live-");
    const repo = join(base, "repo"),
      state = join(base, "s"),
      home = join(base, "h");
    const evidence = resolve(
      ".artifacts/beta-qualification",
      new Date().toISOString().replaceAll(":", "-"),
    );
    mkdirSync(evidence, { recursive: true });
    mkdirSync(repo);
    mkdirSync(home, { mode: 0o700 });
    const git = (args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" })
        .toString()
        .trim();
    git(["init"]);
    git(["config", "user.name", "Beta fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(
      join(repo, "sum.mjs"),
      "export const sum = (a, b) => a - b;\n",
    );
    writeFileSync(
      join(repo, "verify.mjs"),
      "import { sum } from './sum.mjs'; if(sum(2,3)!==5) process.exit(1); console.log('CODING_TEST_PASS');\n",
    );
    git(["add", "."]);
    git(["commit", "-m", "fixture"]);
    copyFileSync(source, join(home, "config.toml"));
    const policy = workspacePolicy(repo, {
      unit: { executable: process.execPath, args: ["verify.mjs"] },
    });
    const options = {
      stateDirectory: state,
      runtimeHome: home,
      expectedVersion: "codex-cli 0.162.0-alpha.17.2",
      executable: binary,
      credential: {
        envKey: "COMMAND_CODE_API_KEY",
        keychainService: "codex-cli-command-code",
      },
      workspace: policy,
    };
    const runtime = new CodexRuntime({
      home,
      executable: binary,
      expectedVersion: options.expectedVersion,
      credential: options.credential,
    });
    // This qualification phase has a new, explicit sixteen-Turn ceiling. Never reads
    // or resets the previous rigorous audit's exhausted thirty-Turn counter.
    const dispatches: {
      attempt: string;
      thread: string;
      turn?: string;
      state: string;
    }[] = existsSync(
      resolve(".artifacts/beta-qualification/dispatch-budget.json"),
    )
      ? JSON.parse(
          readFileSync(
            resolve(".artifacts/beta-qualification/dispatch-budget.json"),
            "utf8",
          ),
        ).dispatches
      : [];
    const previousDispatches = dispatches.length;
    const saveBudget = () => {
      writeFileSync(
        resolve(".artifacts/beta-qualification/dispatch-budget.json"),
        JSON.stringify({ limit: 16, concurrentLimit: 2, dispatches }, null, 2),
      );
      writeFileSync(
        join(evidence, "dispatches.json"),
        JSON.stringify({ limit: 16, concurrentLimit: 2, dispatches }, null, 2),
      );
    };
    const start = runtime.startTurn.bind(runtime);
    runtime.startTurn = async (thread, input, attempt) => {
      assert.ok(
        dispatches.length < 16,
        "Beta qualification sixteen-Turn ceiling reached",
      );
      const row: {
        attempt: string;
        thread: string;
        turn?: string;
        state: string;
      } = { attempt, thread, state: "dispatching" };
      dispatches.push(row);
      saveBudget();
      try {
        row.turn = await start(thread, input, attempt);
        row.state = "accepted";
        saveBudget();
        return row.turn;
      } catch (e) {
        row.state = "uncertain";
        saveBudget();
        throw e;
      }
    };
    let c = new Coordinator(options, runtime);
    let rootId: string | undefined;
    try {
      await c.start();
      const root = c.createRoot(
        "Lead",
        `Fix sum.mjs so sum(2,3) is 5. You are Lead in coding mode. Follow this exact small workflow, no extra Agents: spawn one second-level Coder using agent_spawn. Its assignment: read sum.mjs and run_test unit to observe the failure, use write_file with expectedHash to replace subtraction with addition in its isolated worktree, then spawn exactly one third-level Reviewer. Reviewer must use read_file and search_code to inspect the changed sum.mjs, then send its actual review result to Coder and end. Coder ends its initial Turn after spawn; after Reviewer message it must run_test unit, get git_diff, send Lead the actual successful test exit code, changed file content and worktree path, then agent_ack messages and end. You end your initial Turn promptly after spawning Coder. When Coder reports, inspect its actual report, read your own sum.mjs, integrate the small reviewed change with write_file and expectedHash, and use the supplied terminal tool to run the absolute Node executable ${process.execPath} verify.mjs in your workspace. You MUST use supplied terminal tool for this final verification (not run_test). Acknowledge Coder's message and report final result. Do not claim any test passed without its actual tool output. Do not commit, install packages or access network.`,
        {
          tokenPolicy: "observe",
          tokens: 300000,
          maxDepth: 2,
          maxAgents: 3,
          maxConcurrentTurns: 2,
          maxTurnsPerAgent: 3,
          maxTotalTurns: 8,
          turnReservation: 5000,
        },
        "beta-coding",
      );
      rootId = root.id;
      const deadline = Date.now() + 180000;
      let done = false;
      while (Date.now() < deadline) {
        const agents = c.store.agents(root.tree_id),
          attempts = c.store.attempts();
        if (
          agents.length === 3 &&
          agents.every((a) =>
            c.store.messages(a.id).every((m) => m.status === "processed"),
          ) &&
          attempts.length >= 5 &&
          attempts.every((a) =>
            ["completed", "failed", "interrupted"].includes(a.state),
          )
        ) {
          done = true;
          break;
        }
        await new Promise<void>((r) => setTimeout(r, 250));
      }
      const snapshots = c.store.agents(root.tree_id).map((a) => c.status(a.id));
      writeFileSync(
        join(evidence, "status.json"),
        JSON.stringify(snapshots, null, 2),
      );
      writeFileSync(
        join(evidence, "events.json"),
        JSON.stringify(
          c.store.agents(root.tree_id).flatMap((a) => c.store.events(a.id)),
          null,
          2,
        ),
      );
      const histories = [];
      for (const a of c.store.agents(root.tree_id)) {
        const b = c.store.binding(a.id);
        if (b)
          histories.push({
            agent: a,
            history: await runtime.readThread(b.thread_id),
          });
      }
      writeFileSync(
        join(evidence, "native-history.json"),
        JSON.stringify(histories, null, 2),
      );
      assert.ok(
        done,
        "Coding team did not complete within qualification deadline",
      );
      assert.equal(c.store.agents(root.tree_id).length, 3);
      assert.equal(
        c.store.attempts().filter((a) => a.state !== "completed").length,
        0,
      );
      assert.match(readFileSync(join(repo, "sum.mjs"), "utf8"), /a\s*\+\s*b/);
      const coder = c.store.agents(root.tree_id).find((a) => a.depth === 1)!;
      assert.match(
        readFileSync(join(c.workspace!.cwd(coder), "sum.mjs"), "utf8"),
        /a\s*\+\s*b/,
      );
      const nativeItems = (history: unknown) => {
        const t = record(record(history).thread);
        return (t.turns as unknown[]).flatMap((v) =>
          ((record(v).items as unknown[]) ?? []).map(record),
        );
      };
      const terminalReceipts = c.store.db
        .prepare(
          "SELECT w.result_json FROM workspace_commands w JOIN agents a ON a.id=w.agent_id WHERE a.depth=0 AND w.state='completed'",
        )
        .all();
      assert.ok(
        terminalReceipts.some((r) => {
          const output = JSON.parse(String(r.result_json));
          return (
            output.exitCode === 0 &&
            String(output.output).includes("CODING_TEST_PASS")
          );
        }),
        "No successful host-audited Lead terminal test receipt",
      );
      for (const h of histories.filter((h) => h.agent.depth > 0))
        assert.ok(
          !nativeItems(h.history).some((i) => i.type === "commandExecution"),
          "Descendant unexpectedly executed supplied terminal tool",
        );
      assert.ok(
        c.store
          .agents(root.tree_id)
          .flatMap((a) => c.store.events(a.id))
          .some((e) => e.kind === "workspace.command.completed"),
      );
      const originalBindings = c.store
        .agents(root.tree_id)
        .map((a) => c.store.binding(a.id));
      await c.stop();
      c = new Coordinator(options, runtime);
      await c.start();
      assert.deepEqual(
        c.store.agents(root.tree_id).map((a) => c.store.binding(a.id)),
        originalBindings,
      );
      assert.equal(
        c.store.attempts().length,
        dispatches.length - previousDispatches,
        "Restart unexpectedly dispatched additional work",
      );
      writeFileSync(
        join(evidence, "result.json"),
        JSON.stringify(
          {
            passed: true,
            turns: dispatches.length - previousDispatches,
            rootId,
            providerConfigUnchanged:
              digest(readFileSync(source)) === digest(original),
            patch: git(["diff", "--no-ext-diff", "--no-textconv"]),
            scope:
              "one small real coding workflow; not a general quality benchmark",
          },
          null,
          2,
        ),
      );
      console.log("Coding qualification evidence: " + evidence);
    } finally {
      if (rootId) {
        try {
          await c.control(rootId, "terminate");
        } catch {}
      }
      await c.stop();
      await execute(binary, ["app-server", "daemon", "stop"], {
        env: runtimeEnvironment(home),
        timeout: 30000,
      });
      assert.equal(digest(readFileSync(source)), digest(original));
      rmSync(base, { recursive: true, force: true });
    }
  },
);
