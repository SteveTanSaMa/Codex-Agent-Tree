import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  WorkspaceBroker,
  multiWorkspacePolicy,
  workspaceTools,
  type WorkspaceAssignment,
} from "../../src/workspace/broker.ts";
import type { Agent } from "../../src/storage/store.ts";
import {
  CodexRuntime,
  record,
  runtimeEnvironment,
} from "../../src/runtime/codex/adapter.ts";

test(
  "actual daemon accepts multi-repository worktree cwd and repository-selecting tool catalog without model Turns",
  { skip: process.env.CAT_TEST_NATIVE !== "1", timeout: 60000 },
  async () => {
    const dir = realpathSync(mkdtempSync("/tmp/cat-multi-native-")),
      state = join(dir, "state"),
      home = join(dir, "home");
    mkdirSync(state);
    mkdirSync(home, { mode: 0o700 });
    const entries: Record<string, { path: string }> = {};
    for (const id of ["app", "dxmt", "lsfg"]) {
      const path = join(dir, "MiPlay " + id);
      mkdirSync(path);
      writeFileSync(join(path, "value"), id);
      const git = (args: string[]) =>
        execFileSync("git", ["-C", path, ...args], { stdio: "pipe" });
      git(["init"]);
      git(["config", "user.name", "Fixture"]);
      git(["config", "user.email", "fixture@example.invalid"]);
      git(["add", "."]);
      git(["commit", "-m", "fixture"]);
      entries[id] = { path };
    }
    copyFileSync(
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
      join(home, "auth.json"),
    );
    chmodSync(join(home, "auth.json"), 0o600);
    writeFileSync(
      join(home, "config.toml"),
      "[features]\nmulti_agent=false\nshell_tool=false\nunified_exec=false\n",
    );
    const runtime = new CodexRuntime({
      home,
      expectedVersion:
        process.env.CAT_TEST_EXPECTED_VERSION ?? "codex-cli 0.162.0-alpha.17.2",
    });
    try {
      const policy = multiWorkspacePolicy({
        defaultRepository: "app",
        repositories: entries,
      });
      const root = { id: "root", depth: 0, parent_id: null } as Agent;
      const agents = new Map<string, Agent>([[root.id, root]]),
        assignments = new Map<string, WorkspaceAssignment>();
      assignments.set(root.id, {
        repositoryId: "app",
        repositoryIds: Object.keys(entries),
        worktree: "original",
      });
      for (const id of Object.keys(entries)) {
        agents.set(id, { id, parent_id: root.id, depth: 1 } as Agent);
        assignments.set(id, {
          repositoryId: id,
          repositoryIds: [id],
          worktree: "isolated",
        });
      }
      const broker = new WorkspaceBroker(
        state,
        policy,
        (id) => agents.get(id)!,
        (id) => assignments.get(id)!,
      );
      await runtime.connect();
      const threads = new Set<string>();
      for (const id of Object.keys(entries)) {
        const agent = agents.get(id)!,
          cwd = broker.cwd(agent);
        const thread = await runtime.createThread(
          cwd,
          workspaceTools(agent.depth, []),
          "Transport fixture only; never start work.",
        );
        threads.add(thread);
        assert.equal(
          record((await runtime.readThread(thread, false)).thread).cwd,
          cwd,
        );
      }
      assert.equal(threads.size, 3);
    } finally {
      runtime.disconnect();
      try {
        execFileSync("codex", ["app-server", "daemon", "stop"], {
          env: runtimeEnvironment(home),
          timeout: 30000,
          stdio: "pipe",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);
