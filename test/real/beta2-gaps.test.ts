import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  enabled,
  eventually,
  makeRepo,
  newBase,
  team,
  git,
  allConsumed,
} from "../fixtures/gap-real.ts";

test(
  "Beta 2 installed Skill: two repositories, self-contained child tests, recursive static review and integration",
  { skip: !enabled, timeout: 510000 },
  async () => {
    const base = newBase(),
      core = join(base, "Core Lib"),
      app = join(base, "Demo App");
    await makeRepo(core, {
      "add.mjs": "export const add=(a,b)=>a-b;\n",
      "test/unit.test.mjs":
        "import{test}from'node:test';import assert from'node:assert/strict';import{add}from'../add.mjs';test('addition',()=>assert.equal(add(2,3),5));\n",
    });
    await makeRepo(app, {
      "format.mjs": "export const format=x=>'['+x+'}';\n",
      "test/unit.test.mjs":
        "import{test}from'node:test';import assert from'node:assert/strict';import{format}from'../format.mjs';test('format',()=>assert.equal(format(5),'[5]'));\n",
      "integration.mjs":
        "import assert from'node:assert/strict';import{add}from'../Core Lib/add.mjs';import{format}from'./format.mjs';assert.equal(format(add(2,3)),'[5]');console.log('MULTIREPO_GOLDEN_PASS');\n",
    });
    const unit = {
      executable: process.execPath,
      args: ["--test", "test/unit.test.mjs"],
    };
    const f = await team(
      "multi-repository",
      {
        defaultRepository: "app",
        repositories: {
          core: { path: core, tests: { unit } },
          app: { path: app, tests: { unit } },
        },
      },
      base,
      10,
    );
    try {
      await f.start(
        `Small qualification, exact workflow, no extra Agents or tasks. Never install, access network, commit or merge. There are two repositories: core (Core Lib) and app (Demo App). Only change add.mjs and format.mjs. Test entrypoints are already committed and self-contained.
STEP 1: Spawn exactly one L2 CoreCoder (repositoryId core, repositoryIds [core], isolated). Task: run_test unit and record actual failure, fix add.mjs from subtraction to addition using read_file/write_file expectedHash, run_test unit to prove pass, git_diff, then send you its exact file content and actual test results using agent_send. Do NOT spawn a reviewer. CoreCoder ends after reporting. You end this initial Turn after spawn.
STEP 2: On CoreCoder report, ACK the incoming message, inspect its report and patch, integrate its reviewed add.mjs into your original core repo using read_file/write_file with repositoryId core. Then spawn exactly one L2 AppCoder with repositoryId app, repositoryIds [app,core], isolated. Task: run_test unit to reproduce format failure, fix format.mjs from closing } to ], run_test unit to prove pass, then spawn exactly one L3 Reviewer (repositoryId app, repositoryIds [app,core], worktree inherit). Reviewer must read AppCoder's changed format.mjs and core add.mjs, report static review and observed file content to AppCoder, and end, with no writes/tests/terminal. AppCoder ends its initial Turn after spawn. On review reply AppCoder ACKs, runs unit again, reports exact patch/test/review to you via agent_send and ends.
IMPORTANT: AppCoder's sibling Core Lib worktree starts at the registered commit, so it STILL contains subtraction despite your original core repo being fixed. AppCoder/Reviewer should report that fact, not fix it or pretend it inherited your changes. App unit tests do not import core; only your final integration does. No general terminal exists for L2 or L3.
STEP 3: After AppCoder report, ACK it, integrate only format.mjs in your app repo with expectedHash. Use Lead terminal in repositoryId app to run ${process.execPath} integration.mjs. You must obtain actual MULTIREPO_GOLDEN_PASS output before final MULTIREPO_DONE. You may inspect child diffs using terminal and their actual workspace paths. Never claim unexecuted tests. Exactly 4 Agents including you, no retries or extra members.`,
        2,
        4,
        420000,
      );
      await eventually(
        async () => {
          const t = await f.tree();
          return (
            t.length === 4 &&
            allConsumed(t) &&
            t
              .find((a) => a.id === f.root.id)
              .attempts.some((a: any) => a.result?.includes("MULTIREPO_DONE"))
          );
        },
        420000,
        "multi-repository team did not complete",
      );
      const tree = await f.snapshots("completed");
      assert.ok(
        tree.every((a) =>
          a.attempts.every((t: any) => t.state === "completed"),
        ),
      );
      const attempts = tree.flatMap((a) => a.attempts);
      assert.ok(attempts.length <= 10);
      assert.equal(new Set(tree.map((a) => a.binding.thread_id)).size, 4);
      const coreCoder =
        tree.find(
          (a) => a.depth === 1 && a.workspace.repositoryId === "core",
        ) ?? tree.find((a) => a.depth === 1 && a.name === "CoreCoder");
      const appCoder = tree.find(
        (a) => a.depth === 1 && a.id !== coreCoder?.id,
      );
      const reviewer = tree.find((a) => a.depth === 2);
      assert.ok(coreCoder && appCoder && reviewer);
      assert.equal(reviewer.parent_id, appCoder.id);
      const db = new DatabaseSync(join(f.state, "business.sqlite"), {
        readOnly: true,
      });
      try {
        const commands = db
          .prepare("SELECT agent_id,result_json,state FROM workspace_commands")
          .all();
        const records = (id: string) =>
          commands
            .filter((r) => r.agent_id === id)
            .map((r) => JSON.parse(String(r.result_json ?? "{}")));
        for (const coder of [coreCoder, appCoder]) {
          const results = records(coder.id);
          assert.ok(results.some((r) => r.name === "unit" && r.exitCode !== 0));
          assert.ok(results.some((r) => r.name === "unit" && r.exitCode === 0));
        }
        assert.equal(records(reviewer.id).length, 0);
        assert.ok(
          records(f.root.id).some(
            (r) =>
              r.exitCode === 0 && r.output?.includes("MULTIREPO_GOLDEN_PASS"),
          ),
        );
        assert.equal(
          db.prepare("pragma integrity_check").get()!.integrity_check,
          "ok",
        );
        assert.equal(
          db
            .prepare(
              "SELECT count(*) n FROM workspace_commands WHERE state='accepted'",
            )
            .get()!.n,
          0,
        );
      } finally {
        db.close();
      }
      const dependency = appCoder.workspace.repositories.find(
        (r: any) => r.repositoryId === "core",
      );
      assert.ok(dependency);
      assert.match(
        readFileSync(join(dependency.workspace, "add.mjs"), "utf8"),
        /a\s*-\s*b/,
      );
      assert.ok(
        reviewer.workspace.repositories.every(
          (r: any) => r.ownerAgentId === appCoder.id,
        ),
      );
      const appWorkspaces = appCoder.workspace;
      f.save("workspace-projection.json", {
        core: coreCoder.workspace,
        app: appWorkspaces,
        reviewer: reviewer.workspace,
      });
      // Independent golden checks execute only synthetic code, outside the model's assertion path.
      const { execFileSync } = await import("node:child_process");
      assert.match(
        execFileSync(process.execPath, [join(app, "integration.mjs")], {
          encoding: "utf8",
        }),
        /MULTIREPO_GOLDEN_PASS/,
      );
      assert.match(readFileSync(join(core, "add.mjs"), "utf8"), /a\s*\+\s*b/);
      assert.match(readFileSync(join(app, "format.mjs"), "utf8"), /\]/);
      assert.match(await git(core, "diff", "--name-only"), /^add.mjs$/);
      assert.match(await git(app, "diff", "--name-only"), /^format.mjs$/);
      const binding = tree.map((a) => a.binding);
      await f.cli("stop");
      await f.cli("start");
      const after = await f.tree();
      assert.deepEqual(
        after.map((a) => a.binding),
        binding,
      );
      assert.equal(after.flatMap((a) => a.attempts).length, attempts.length);
      f.save("result.json", {
        passed: true,
        agents: tree.length,
        turns: attempts.length,
        distinctThreads: 4,
        independentGolden: true,
        restartPreservedBindings: true,
      });
      f.markPassed();
    } finally {
      await f.close();
    }
  },
);

test(
  "Beta 2 installed Skill: live steer during a command, immediate pause, restart and explicit replacement",
  { skip: !enabled, timeout: 330000 },
  async () => {
    const base = newBase(),
      repo = join(base, "repo");
    await makeRepo(repo, {
      "hold.mjs":
        "import fs from'node:fs';fs.appendFileSync('hold-starts.txt','start\\n');console.log('HOLD_STARTED');await new Promise(r=>setTimeout(r,12000));console.log('HOLD_FINISHED');\n",
    });
    const f = await team(
      "interactive-recovery",
      {
        defaultRepository: "app",
        repositories: { app: { path: repo, tests: {} } },
      },
      base,
      3,
    );
    const count = () =>
      existsSync(join(repo, "hold-starts.txt"))
        ? readFileSync(join(repo, "hold-starts.txt"), "utf8").trim().split("\n")
            .length
        : 0;
    try {
      await f.start(
        `No child Agents. Call supplied Lead terminal exactly once to run ${process.execPath} hold.mjs. Wait for its result, then output ORIGINAL_RESULT and end. Do not edit files, run other commands or poll. A later operator correction may change the final response.`,
        0,
        1,
        240000,
      );
      await eventually(
        () => count() === 1,
        90000,
        "first terminal command never started",
      );
      const before = (await f.tree())[0].attempts[0];
      const guidance = await f.cli(
        "steer",
        "--target",
        f.root.id,
        "--key",
        "during-command",
        "--message",
        "Keep the running command; do not start another. After its actual return, acknowledge this input and output exactly GUIDED_SAME_TURN. This replaces ORIGINAL_RESULT.",
      );
      f.save("steer.json", guidance);
      assert.equal(guidance.guidance.state, "delivered");
      const duplicate = await f.cli(
        "steer",
        "--target",
        f.root.id,
        "--key",
        "during-command",
        "--message",
        "Keep the running command; do not start another. After its actual return, acknowledge this input and output exactly GUIDED_SAME_TURN. This replaces ORIGINAL_RESULT.",
      );
      assert.deepEqual(duplicate, guidance);
      await eventually(
        async () => {
          const t = await f.tree();
          return (
            allConsumed(t) &&
            t[0].attempts[0].result?.includes("GUIDED_SAME_TURN")
          );
        },
        90000,
        "model did not follow guidance in original Turn",
      );
      const guided = (await f.tree())[0];
      assert.equal(guided.turns, 1);
      assert.equal(guided.attempts[0].turn_id, before.turn_id);
      assert.equal(count(), 1);
      await f.cli(
        "send",
        "--target",
        f.root.id,
        "--delivery",
        "queue",
        "--key",
        "second-command",
        "--message",
        `Run ${process.execPath} hold.mjs once using terminal, then output STALE_RESULT. No other commands or Agents.`,
      );
      await eventually(
        () => count() === 2,
        60000,
        "second command did not start",
      );
      const pauseStart = Date.now();
      await f.cli(
        "control",
        "--target",
        f.root.id,
        "--action",
        "pause",
        "--immediate",
      );
      await eventually(
        async () => {
          const a = (await f.tree())[0];
          return a.execution === "idle";
        },
        30000,
        "pause did not interrupt active Native Turn",
      );
      const pauseMs = Date.now() - pauseStart;
      await f.cli(
        "send",
        "--target",
        f.root.id,
        "--delivery",
        "queue",
        "--key",
        "obsolete",
        "--message",
        "OBSOLETE_ASSIGNMENT_DO_NOT_REVIVE",
      );
      const paused = (await f.tree())[0];
      const binding = paused.binding;
      assert.equal(paused.desired, "paused");
      const owner = await f.cli("start");
      assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 1);
      process.kill(owner.pid, "SIGKILL");
      await eventually(
        async () => {
          try {
            await f.cli("start");
            return true;
          } catch {
            return false;
          }
        },
        15000,
        "Coordinator did not recover after owned SIGKILL",
      );
      const restarted = (await f.tree())[0];
      assert.deepEqual(restarted.binding, binding);
      assert.equal(restarted.turns, 2);
      assert.equal(restarted.desired, "paused");
      await f.cli("control", "--target", f.root.id, "--action", "cancel");
      assert.ok(
        (await f.tree())[0].messages.some(
          (m: any) =>
            m.body === "OBSOLETE_ASSIGNMENT_DO_NOT_REVIVE" &&
            m.status === "cancelled",
        ),
      );
      await f.cli("control", "--target", f.root.id, "--action", "resume");
      assert.equal((await f.tree())[0].turns, 2);
      await f.cli(
        "send",
        "--target",
        f.root.id,
        "--delivery",
        "queue",
        "--key",
        "new-scope",
        "--message",
        "Replacement scope: do not use terminal or any other tools except acknowledging this input. Output FINAL_REPLACEMENT_DONE and end.",
      );
      await eventually(
        async () => {
          const a = (await f.tree())[0];
          return (
            a.execution === "idle" &&
            a.attempts.at(-1).result?.includes("FINAL_REPLACEMENT_DONE")
          );
        },
        60000,
        "replacement scope did not complete",
      );
      const final = (await f.snapshots("completed"))[0];
      assert.equal(final.turns, 3);
      assert.equal(count(), 2);
      assert.equal(final.attempts[1].state, "interrupted");
      assert.equal(final.attempts[2].state, "completed");
      assert.deepEqual(final.binding, binding);
      const db = new DatabaseSync(join(f.state, "business.sqlite"), {
        readOnly: true,
      });
      try {
        const receipts = db
          .prepare("SELECT state,result_json FROM workspace_commands")
          .all();
        assert.equal(receipts.length, 2);
        assert.ok(receipts.every((r) => r.state === "completed"));
        f.save("command-receipts.json", receipts);
      } finally {
        db.close();
      }
      f.save("result.json", {
        passed: true,
        turns: 3,
        commandStarts: count(),
        sameTurnSteer: true,
        immediatePauseMs: pauseMs,
        restartPreservedBindings: true,
        obsoleteAssignmentCancelled: true,
        pausedCoordinatorSigkill: true,
      });
      f.markPassed();
    } finally {
      await f.close();
    }
  },
);
