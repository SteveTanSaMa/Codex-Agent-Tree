import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeEnvironment } from "../../src/runtime/codex/adapter.ts";
import { writeEvidence } from "../fixtures/evidence.ts";
const execute = promisify(execFile);
const checkout = fileURLToPath(new URL("../../", import.meta.url));

test(
  "real Codex invokes an installed ZIP Skill, creates a recursive team and retrieves its synthesis",
  { skip: process.env.CAT_TEST_REAL !== "1", timeout: 540000 },
  async () => {
    const directory = mkdtempSync("/tmp/cat-skill-real-");
    chmodSync(directory, 0o700);
    const operator = join(directory, "operator");
    const runtime = join(directory, "runtime");
    const state = join(directory, "team");
    const workspace = join(directory, "workspace");
    mkdirSync(join(operator, "skills"), { recursive: true, mode: 0o700 });
    mkdirSync(workspace);
    const auth = join(operator, "auth.json");
    copyFileSync(
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
      auth,
    );
    chmodSync(auth, 0o600);
    const version = JSON.parse(
      readFileSync(join(checkout, "package.json"), "utf8"),
    ).version as string;
    const evidence: Record<string, unknown> = {
      mode: "installed-skill-real-operator",
      startedAt: new Date().toISOString(),
      directory,
    };
    const skill = join(operator, "skills/codex-agent-tree");
    const wrapper = join(skill, "scripts/cat.mjs");
    const call = async (...args: string[]) =>
      JSON.parse(
        (
          await execute(
            process.execPath,
            [wrapper, ...args, "--state", state],
            { cwd: workspace, timeout: 75000 },
          )
        ).stdout,
      ) as unknown;
    try {
      await execute("python3", [join(checkout, "scripts/package-skill.py")]);
      await execute("python3", [
        "-m",
        "zipfile",
        "-e",
        join(checkout, "dist", `codex-agent-tree-${version}.zip`),
        join(operator, "skills"),
      ]);
      await execute(process.execPath, [wrapper, "setup"], {
        cwd: workspace,
        timeout: 120000,
      });
      await execute(
        process.execPath,
        [
          wrapper,
          "init",
          "--state",
          state,
          "--runtime-home",
          runtime,
          "--auth-from",
          auth,
        ],
        { cwd: workspace, timeout: 15000 },
      );
      const prompt = `Use $codex-agent-tree to solve this supplied-text task with a three-node A→B→C recursive team and retrieve the final synthesis: there are six racks, each holding seven packets. Calculate the total and report the actual child result. Root A must delegate to B, B must delegate the calculation to C, and reports must return C→B→A. Do not calculate the answer yourself.\nThe skill is installed at ${skill}. It is already set up. Dedicated team state ${state} is initialized with dedicated runtime home ${runtime}; start it. Use request key installed-skill-acceptance and max-agents 3, max-depth 2, tokens 600000. Instruct A to allocate 300000 tokens to B and B to allocate 120000 to C; the explicit task-tool workflow needs a larger pool than a message-only calculation. Require A to create exactly two tasks using its native agent_task_create tools: calculation, and verification blockedBy calculation. A passes both IDs to B; B passes the calculation ID to C. C gets and claims calculation using agent_task_get/update, computes the total, explicitly completes it with its result, then reports to B. B reads the completed calculation, claims and explicitly completes verification using its tools, and reports to A. A checks both completed results before final synthesis. Use stable requestKey per operation and current expectedRevision, and preserve the two tasks for inspection. End initial delegation Turns and explicitly acknowledge result messages. As operator use view and at least one CLI wait with its cursor while the team works, then retrieve the managed team's result. Operate only this test team and workspace. Do not read or print auth files, change host configuration, or use native subagent tools. Return the stable Root ID and result. Leave the team for the test harness to inspect and stop.`;
      const outputPath = join(directory, "operator-output.jsonl");
      evidence.operatorOutput = outputPath;
      writeFileSync(outputPath, "", { mode: 0o600 });
      const pending = execute(
        "codex",
        [
          "exec",
          "--json",
          "--skip-git-repo-check",
          "--sandbox",
          "danger-full-access",
          "--disable",
          "multi_agent",
          "-c",
          'approval_policy="never"',
          "-C",
          workspace,
          prompt,
        ],
        {
          env: runtimeEnvironment(operator),
          timeout: 420000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      // `codex exec` appends piped stdin even when a prompt argument is supplied.
      pending.child.stdin?.end();
      pending.child.stdout?.on("data", (chunk: Buffer) => {
        appendFileSync(outputPath, chunk);
      });
      const result = await pending;
      type Snapshot = {
        id: string;
        parent_id: string | null;
        binding: { thread_id: string };
        attempts: Array<{ state: string; result: string | null }>;
        messages: Array<{ status: string }>;
      };
      const agents = (await call("tree")) as Snapshot[];
      evidence.agents = agents;
      assert.equal(agents.length, 3);
      assert.equal(new Set(agents.map((a) => a.binding.thread_id)).size, 3);
      const root = agents.find((a) => a.parent_id === null);
      assert.ok(root);
      const child = agents.find((a) => a.parent_id === root.id);
      assert.ok(child);
      assert.ok(agents.some((a) => a.parent_id === child.id));
      assert.ok(
        agents.every((a) => a.attempts.every((t) => t.state === "completed")),
      );
      assert.ok(root.attempts.length >= 2);
      assert.match(root.attempts.at(-1)?.result ?? "", /\b42\b/);
      for (const agent of [root, child])
        assert.ok(agent.messages.some((m) => m.status === "processed"));
      assert.ok(result.stdout.includes("scripts/cat.mjs"));
      assert.ok(result.stdout.includes(root.id));
      const tasks = (await call("task-list", "--target", root.id)) as Array<{
        id: string;
        status: string;
        ownerId: string;
        blockedBy: string[];
      }>;
      evidence.tasks = tasks;
      assert.equal(tasks.length, 2);
      assert.ok(tasks.every((task) => task.status === "completed"));
      const verification = tasks.find((task) => task.blockedBy.length === 1);
      assert.ok(verification);
      const calculation = tasks.find(
        (task) => task.id === verification.blockedBy[0],
      );
      assert.ok(calculation);
      assert.equal(verification.ownerId, child.id);
      assert.equal(
        calculation.ownerId,
        agents.find((agent) => agent.parent_id === child.id)?.id,
      );
      for (const task of tasks) {
        const full = (await call(
          "task-get",
          "--target",
          root.id,
          "--task-id",
          task.id,
        )) as { result: string };
        assert.match(full.result, /\b42\b/);
      }
      const events = (
        await Promise.all(
          agents.map(
            async (agent) =>
              (await call("events", "--target", agent.id)) as Array<{
                kind: string;
                body: string;
              }>,
          ),
        )
      ).flat();
      const invoked = events
        .filter((event) => event.kind === "tool.called")
        .map((event) => JSON.parse(event.body).tool);
      for (const tool of [
        "agent_task_create",
        "agent_task_get",
        "agent_task_update",
      ])
        assert.ok(invoked.includes(tool), `Actual model must invoke ${tool}`);
      assert.match(result.stdout, /cat\.mjs[^\n]*\bwait\b/);
      evidence.passed = true;
    } catch (error) {
      evidence.passed = false;
      evidence.error = String(error);
      throw error;
    } finally {
      try {
        if (existsSync(join(state, "control.sock"))) await call("stop");
      } finally {
        try {
          if (existsSync(join(runtime, "config.toml")))
            await execute("codex", ["app-server", "daemon", "stop"], {
              env: runtimeEnvironment(runtime),
              timeout: 30000,
            });
        } finally {
          for (const path of [auth, join(runtime, "auth.json")])
            if (existsSync(path)) unlinkSync(path);
          evidence.finishedAt = new Date().toISOString();
          writeEvidence("installed-skill.json", evidence);
        }
      }
    }
  },
);
