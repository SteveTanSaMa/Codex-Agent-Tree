import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  WorkspaceBroker,
  multiWorkspacePolicy,
  workspacePolicy,
  validateWorkspacePolicy,
  type WorkspaceSelection,
} from "../../src/workspace/broker.ts";
import { Store, type Agent, type Actor } from "../../src/storage/store.ts";
import { spawnInput } from "../../src/tools/inputs.ts";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import { ControlledRuntime } from "../fixtures/controlled-runtime.ts";

const limits = {
  tokenPolicy: "observe" as const,
  tokens: 10000,
  maxDepth: 3,
  maxAgents: 16,
  maxConcurrentTurns: 8,
  maxTurnsPerAgent: 8,
  turnReservation: 100,
};
function fixture() {
  const dir = realpathSync(mkdtempSync("/tmp/cat-multi-"));
  const state = join(dir, "state");
  const roots: Record<string, string> = {};
  const manifest = {
    defaultRepository: "app",
    repositories: {} as Record<string, object>,
  };
  for (const id of ["app", "dxmt", "lsfg"]) {
    const path = join(dir, "MiPlay " + id.toUpperCase());
    mkdirSync(path);
    roots[id] = path;
    const git = (args: string[]) =>
      execFileSync("git", ["-C", path, ...args], { stdio: "pipe" });
    git(["init"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(path, "value.txt"), id);
    writeFileSync(
      join(path, "check.mjs"),
      `import fs from 'node:fs'; console.log(fs.readFileSync('value.txt','utf8'));\n`,
    );
    writeFileSync(
      join(path, "dependency.mjs"),
      `import fs from 'node:fs'; console.log(fs.readFileSync('../MiPlay DXMT/value.txt','utf8'));try {fs.writeFileSync('../MiPlay DXMT/value.txt','escaped');process.exit(22)} catch {}\n`,
    );
    git(["add", "."]);
    git(["commit", "-m", id]);
    manifest.repositories[id] = {
      path,
      tests: {
        unit: { executable: process.execPath, args: ["check.mjs"] },
        dependency: { executable: process.execPath, args: ["dependency.mjs"] },
        slow: {
          executable: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
        },
      },
    };
  }
  const policy = multiWorkspacePolicy(manifest);
  let store = new Store(join(state, "business.sqlite"));
  store.configureWorkspace(policy);
  const root = store.createRoot("Lead", "multi", limits, "root");
  const activate = (agent: Agent): Actor => {
    const b = store.bind(agent.id, "thread-" + agent.id, "fixture");
    const a = store.prepare(agent.id, "fixture");
    store.markStarting(a.id);
    store.attachTurn(a.id, 1, "turn-" + agent.id);
    return store.authenticate(b.thread_id, "turn-" + agent.id, b.generation);
  };
  const actor = activate(root);
  const child = (
    parent: Actor,
    key: string,
    selection: WorkspaceSelection = {},
  ) =>
    store.spawn(parent, key, {
      name: key,
      role: "coder",
      task: "code",
      ...selection,
    });
  const makeBroker = () =>
    new WorkspaceBroker(
      state,
      policy,
      (id) => store.agent(id),
      (id) => store.workspaceAssignment(id),
    );
  const broker = makeBroker();
  return {
    dir,
    state,
    roots,
    policy,
    manifest,
    root,
    actor,
    broker,
    activate,
    child,
    makeBroker,
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = new Store(join(state, "business.sqlite"));
      store.configureWorkspace(policy);
      return makeBroker();
    },
    close() {
      broker.cancel();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("multi-repository worktrees preserve sibling names and independent Git identities; same-repository siblings never share edits", async () => {
  const f = fixture();
  try {
    const a = f.child(f.actor, "A", { repositoryIds: ["app", "dxmt", "lsfg"] });
    const b = f.child(f.actor, "B", { repositoryId: "dxmt" });
    const c = f.child(f.actor, "C", { repositoryId: "dxmt" });
    for (const id of ["app", "dxmt", "lsfg"]) {
      const cwd = f.broker.cwd(a, id);
      assert.equal(
        cwd,
        join(f.state, "workspaces", a.id, "MiPlay " + id.toUpperCase()),
      );
      assert.equal(readFileSync(join(cwd, "value.txt"), "utf8"), id);
      const common = execFileSync(
        "git",
        ["-C", cwd, "rev-parse", "--git-common-dir"],
        { encoding: "utf8" },
      ).trim();
      assert.equal(realpathSync(common), join(f.roots[id]!, ".git"));
    }
    const before = (await f.broker.call(b, "read_file", {
      path: "value.txt",
    })) as { hash: string };
    await f.broker.call(b, "write_file", {
      path: "value.txt",
      content: "changed",
      expectedHash: before.hash,
    });
    assert.notEqual(f.broker.cwd(b), f.broker.cwd(c));
    assert.equal(
      readFileSync(join(f.broker.cwd(c), "value.txt"), "utf8"),
      "dxmt",
    );
    assert.equal(
      readFileSync(join(f.roots.dxmt!, "value.txt"), "utf8"),
      "dxmt",
    );
    const diff = (await f.broker.call(b, "git_diff", {})) as {
      baseCommit: string;
      diff: string;
    };
    assert.equal(diff.baseCommit, f.policy.repositories!.dxmt!.baseCommit);
    assert.match(diff.diff, /changed/);
  } finally {
    f.close();
  }
});

test("third-level inherit observes parent edits; explicit isolated stays on base without granting writes or shell", async () => {
  const f = fixture();
  try {
    const parent = f.child(f.actor, "P", { repositoryIds: ["app", "dxmt"] }),
      actor = f.activate(parent);
    const inherited = f.child(actor, "I", { repositoryId: "dxmt" });
    const isolated = f.child(actor, "S", {
      repositoryId: "dxmt",
      worktree: "isolated",
    });
    const file = (await f.broker.call(parent, "read_file", {
      repositoryId: "dxmt",
      path: "value.txt",
    })) as { hash: string };
    await f.broker.call(parent, "write_file", {
      repositoryId: "dxmt",
      path: "value.txt",
      expectedHash: file.hash,
      content: "parent-edit",
    });
    assert.equal(f.broker.cwd(inherited), f.broker.cwd(parent, "dxmt"));
    assert.notEqual(f.broker.cwd(isolated), f.broker.cwd(inherited));
    assert.equal(
      (
        (await f.broker.call(inherited, "read_file", {
          path: "value.txt",
        })) as { content: string }
      ).content,
      "parent-edit",
    );
    assert.equal(
      (
        (await f.broker.call(isolated, "read_file", { path: "value.txt" })) as {
          content: string;
        }
      ).content,
      "dxmt",
    );
    for (const a of [inherited, isolated]) {
      await assert.rejects(
        () =>
          f.broker.call(a, "write_file", {
            path: "bad",
            content: "x",
            expectedHash: null,
          }),
        /read-only/,
      );
      await assert.rejects(
        () => f.broker.call(a, "terminal", { command: "true" }),
        /cannot execute/,
      );
      await assert.rejects(
        () => f.broker.call(a, "run_test", { name: "unit" }),
        /cannot execute/,
      );
    }
  } finally {
    f.close();
  }
});

test("repository grants only narrow; invalid/idempotently changed spawn rolls back all child state", async () => {
  const f = fixture();
  try {
    const p = f.child(f.actor, "P", { repositoryId: "dxmt" }),
      actor = f.activate(p);
    assert.deepEqual(f.store.workspaceAssignment(p.id).repositoryIds, ["dxmt"]);
    assert.equal(f.child(f.actor, "P", { repositoryId: "dxmt" }).id, p.id);
    f.store.beginWorkspaceCommand(actor, "selected-test", {
      repositoryId: "dxmt",
      name: "unit",
    });
    f.store.finishWorkspaceCommand(p.id, "selected-test", { exitCode: 0 });
    assert.throws(
      () =>
        f.store.beginWorkspaceCommand(actor, "selected-test", {
          repositoryId: "app",
          name: "unit",
        }),
      /changed input/,
    );
    const count = f.store.agents().length;
    for (const selection of [
      { repositoryId: "app" },
      { repositoryId: "dxmt", repositoryIds: ["dxmt", "lsfg"] },
      { repositoryIds: [] },
      { repositoryIds: ["dxmt", "dxmt"] },
    ])
      assert.throws(() => f.child(actor, "bad", selection), /subset/);
    assert.throws(
      () => f.child(f.actor, "inherit", { worktree: "inherit" }),
      /isolated/,
    );
    assert.throws(
      () => f.child(f.actor, "P", { repositoryId: "app" }),
      /different content/,
    );
    assert.equal(f.store.agents().length, count);
    for (const name of [
      "read_file",
      "write_file",
      "git_diff",
      "run_test",
      "workspace_list",
    ])
      await assert.rejects(
        () => f.broker.call(p, name, { repositoryId: "lsfg" }),
        /not granted/,
      );
    assert.equal(
      existsSync(join(f.state, "workspaces", p.id, "MiPlay LSFG")),
      false,
    );
    assert.throws(
      () =>
        spawnInput({
          requestKey: "x",
          name: "x",
          role: "x",
          task: "x",
          worktree: "original",
        }),
      /mode/,
    );
    assert.throws(
      () =>
        spawnInput({
          requestKey: "x",
          name: "x",
          role: "x",
          task: "x",
          repositoryIds: "app",
        }),
      /grant/,
    );
  } finally {
    f.close();
  }
});

test("tests select per-repository allowlists and can read granted sibling dependencies but cannot write them", async () => {
  const f = fixture();
  try {
    const a = f.child(f.actor, "A", { repositoryIds: ["app", "dxmt"] });
    for (const id of ["app", "dxmt"]) {
      const r = (await f.broker.call(a, "run_test", {
        repositoryId: id,
        name: "unit",
      })) as { exitCode: number; output: string };
      assert.equal(r.exitCode, 0);
      assert.equal(r.output.trim(), id);
    }
    const r = (await f.broker.call(a, "run_test", { name: "dependency" })) as {
      exitCode: number;
      output: string;
    };
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /dxmt/);
    assert.equal(
      readFileSync(join(f.broker.cwd(a, "dxmt"), "value.txt"), "utf8"),
      "dxmt",
    );
    const only = f.child(f.actor, "Only");
    const denied = (await f.broker.call(only, "run_test", {
      name: "dependency",
    })) as { exitCode: number };
    assert.notEqual(denied.exitCode, 0);
    assert.equal(
      existsSync(join(f.state, "workspaces", only.id, "MiPlay DXMT")),
      false,
    );
  } finally {
    f.close();
  }
});

test("nonprimary command locks its real cwd and dependency reads; unrelated worktree remains usable", async () => {
  const f = fixture();
  try {
    const a = f.child(f.actor, "A", { repositoryIds: ["app", "dxmt"] }),
      actor = f.activate(a);
    const inherited = f.child(actor, "I", { repositoryId: "dxmt" });
    const unrelated = f.child(f.actor, "Other", { repositoryId: "lsfg" });
    const running = f.broker.call(a, "run_test", {
      repositoryId: "dxmt",
      name: "slow",
    });
    try {
      await assert.rejects(
        () => f.broker.call(inherited, "read_file", { path: "value.txt" }),
        /command is running/,
      );
      await assert.rejects(
        () =>
          f.broker.call(a, "write_file", {
            path: "bad",
            expectedHash: null,
            content: "x",
          }),
        /command is running/,
      );
      assert.ok(await f.broker.call(a, "read_file", { path: "value.txt" }));
      assert.ok(
        await f.broker.call(unrelated, "read_file", { path: "value.txt" }),
      );
    } finally {
      f.broker.cancel(a.id);
      await running;
    }
    assert.ok(
      await f.broker.call(inherited, "read_file", { path: "value.txt" }),
    );
  } finally {
    f.close();
  }
});

test("workspace assignments and ready markers survive restart; changed configuration and incomplete checkout fail closed", () => {
  const f = fixture();
  try {
    const a = f.child(f.actor, "A", {
      repositoryId: "dxmt",
      repositoryIds: ["app", "dxmt"],
    });
    const cwd = f.broker.cwd(a),
      assignment = f.store.workspaceAssignment(a.id);
    writeFileSync(join(cwd, "preserve"), "work");
    const restart = f.restart();
    assert.deepEqual(f.store.workspaceAssignment(a.id), assignment);
    assert.equal(restart.cwd(a), cwd);
    assert.throws(
      () =>
        f.store.configureWorkspace({ ...f.policy, defaultRepository: "lsfg" }),
      /immutable/,
    );
    assert.throws(() => f.store.configureWorkspace(), /immutable/);
    const marker = join(f.state, "worktree-ready", a.id, "dxmt.json");
    const identity = readFileSync(marker, "utf8");
    writeFileSync(
      marker,
      identity.replace('"repositoryId":"dxmt"', '"repositoryId":"app"'),
    );
    assert.throws(() => f.makeBroker().cwd(a), /incomplete or changed/);
    rmSync(marker);
    assert.throws(() => f.makeBroker().cwd(a), /incomplete or changed/);
    assert.equal(readFileSync(join(cwd, "preserve"), "utf8"), "work");
  } finally {
    f.close();
  }
});

test("legacy schema 8 coding migration preserves old worktree paths, markers and native bindings", () => {
  const f = fixture();
  const state = join(f.dir, "legacy"),
    policy = workspacePolicy(f.roots.app!);
  let s = new Store(join(state, "business.sqlite"));
  try {
    const a = s.createRoot("Lead", "legacy", limits),
      b = s.bind(a.id, "legacy-thread", "fixture"),
      attempt = s.prepare(a.id, "legacy");
    s.markStarting(attempt.id);
    s.attachTurn(attempt.id, 1, "legacy-turn");
    const child = s.spawn(
      s.authenticate(b.thread_id, "legacy-turn", 1),
      "child",
      { name: "C", role: "code", task: "code" },
    );
    const old = new WorkspaceBroker(state, policy, (id) => s.agent(id));
    const cwd = old.cwd(child),
      marker = readFileSync(
        join(state, "worktree-ready", child.id + ".json"),
        "utf8",
      );
    s.db.exec(
      "DROP TABLE agent_workspaces; DROP TABLE workspace_registry; UPDATE schema_version SET version=8",
    );
    s.close();
    s = new Store(join(state, "business.sqlite"));
    s.configureWorkspace(policy);
    const migrated = new WorkspaceBroker(
      state,
      policy,
      (id) => s.agent(id),
      (id) => s.workspaceAssignment(id),
    );
    assert.equal(migrated.cwd(child), cwd);
    assert.equal(cwd, join(state, "workspaces", child.id));
    assert.equal(
      readFileSync(join(state, "worktree-ready", child.id + ".json"), "utf8"),
      marker,
    );
    assert.equal(s.binding(a.id)?.thread_id, "legacy-thread");
    assert.equal(s.attempt(attempt.id).turn_id, "legacy-turn");
  } finally {
    s.close();
    f.close();
  }
});

test("manifest rejects shared/nested roots, duplicate directory aliases and missing defaults", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        multiWorkspacePolicy({ ...f.manifest, defaultRepository: "unknown" }),
      /default/,
    );
    assert.throws(
      () =>
        multiWorkspacePolicy({
          defaultRepository: "a",
          repositories: {
            a: { path: f.roots.app },
            b: { path: f.roots.app, directory: "other" },
          },
        }),
      /independent/,
    );
    assert.throws(
      () =>
        multiWorkspacePolicy({
          defaultRepository: "a",
          repositories: {
            a: { path: f.roots.app, directory: "Same" },
            b: { path: f.roots.dxmt, directory: "same" },
          },
        }),
      /unique/,
    );
    for (const directory of ["..", "a/b", ".git", "a\\b"])
      assert.throws(
        () =>
          multiWorkspacePolicy({
            defaultRepository: "a",
            repositories: { a: { path: f.roots.app, directory } },
          }),
        /directory/,
      );
    const linked = join(f.dir, "linked");
    execFileSync(
      "git",
      ["-C", f.roots.app!, "worktree", "add", "--detach", linked],
      { stdio: "pipe" },
    );
    assert.throws(
      () =>
        multiWorkspacePolicy({
          defaultRepository: "a",
          repositories: { a: { path: f.roots.app }, b: { path: linked } },
        }),
      /independent/,
    );
    const nested = join(f.roots.app!, "nested");
    mkdirSync(nested);
    writeFileSync(join(f.roots.app!, ".git", "info", "exclude"), "nested/\n");
    const git = (args: string[]) =>
      execFileSync("git", ["-C", nested, ...args], { stdio: "pipe" });
    git(["init"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(nested, "value"), "nested");
    git(["add", "."]);
    git(["commit", "-m", "nested"]);
    assert.throws(
      () =>
        multiWorkspacePolicy({
          defaultRepository: "a",
          repositories: { a: { path: f.roots.app }, b: { path: nested } },
        }),
      /non-nested/,
    );
    assert.throws(
      () =>
        validateWorkspacePolicy({ ...f.policy, baseCommit: "a".repeat(40) }),
      /disagrees/,
    );
  } finally {
    f.close();
  }
});

test("Lead terminal writes selected repository only while reading registered siblings", async () => {
  const f = fixture();
  try {
    const code = `const fs=require("node:fs");fs.writeFileSync("selected.txt","ok");console.log(fs.readFileSync(${JSON.stringify(join(f.roots.app!, "value.txt"))},"utf8"));try{fs.writeFileSync(${JSON.stringify(join(f.roots.app!, "escape"))},"bad");process.exit(23)}catch{}`;
    const command = `'${process.execPath}' -e '${code}'`;
    const result = (await f.broker.call(f.root, "terminal", {
      repositoryId: "dxmt",
      command,
    })) as { exitCode: number; output: string };
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /app/);
    assert.equal(
      readFileSync(join(f.roots.dxmt!, "selected.txt"), "utf8"),
      "ok",
    );
    assert.equal(existsSync(join(f.roots.app!, "escape")), false);
  } finally {
    f.close();
  }
});

test("CLI manifest initialization persists captured commits and checks separation from every repository", () => {
  const f = fixture();
  try {
    const manifestFile = join(f.dir, "manifest.json"),
      source = join(f.dir, "provider.toml");
    writeFileSync(manifestFile, JSON.stringify(f.manifest));
    writeFileSync(source, 'model="fixture"\n');
    const args = [
      "src/cli/main.ts",
      "init",
      "--state",
      join(f.dir, "cli"),
      "--runtime-home",
      join(f.dir, "home"),
      "--workspace-config",
      manifestFile,
      "--config-from",
      source,
      "--provider-env",
      "CAT_FIXTURE_KEY",
    ];
    execFileSync(process.execPath, args, { stdio: "pipe" });
    const config = JSON.parse(
      readFileSync(join(f.dir, "cli", "config.json"), "utf8"),
    );
    assert.deepEqual(config.workspace, JSON.parse(JSON.stringify(f.policy)));
    const mixed = [...args, "--workspace", f.roots.app!];
    mixed[mixed.indexOf("--state") + 1] = join(f.dir, "mixed-state");
    assert.throws(
      () => execFileSync(process.execPath, mixed, { stdio: "pipe" }),
      (e: unknown) =>
        String((e as { stderr: Buffer }).stderr).includes("cannot be combined"),
    );
    const bad = [...args];
    bad[bad.indexOf("--state") + 1] = join(f.dir, "bad-state");
    bad[bad.indexOf("--runtime-home") + 1] = join(
      f.roots.lsfg!,
      "private-runtime",
    );
    assert.throws(() => execFileSync(process.execPath, bad, { stdio: "pipe" }));
    assert.equal(existsSync(join(f.roots.lsfg!, "private-runtime")), false);
  } finally {
    f.close();
  }
});

test("Coordinator binds native Thread to selected primary cwd and exposes authorized repository tools", async () => {
  const f = fixture(),
    runtime = new ControlledRuntime();
  const created: unknown[][] = [];
  runtime.createThread = async (...args: unknown[]) => {
    created.push(args);
    return `thread-${++runtime.threads}`;
  };
  const c = new Coordinator(
    {
      stateDirectory: join(f.dir, "coordinator"),
      runtimeHome: join(f.dir, "home"),
      expectedVersion: "fixture",
      workspace: f.policy,
    },
    runtime,
  );
  const wait = async (p: () => boolean) => {
    const end = Date.now() + 5000;
    while (!p() && Date.now() < end)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(p());
  };
  try {
    await c.start();
    const root = c.createRoot("Lead", "multi", limits);
    await wait(
      () => runtime.starts.length === 1 && !!c.store.attempts()[0]?.turn_id,
    );
    const turn = runtime.starts[0]!,
      actor = c.store.authenticate(turn.threadId, turn.turnId, 1);
    const child = c.store.spawn(actor, "child", {
      name: "child",
      role: "coder",
      task: "code",
      repositoryId: "lsfg",
    });
    c.submitInput(root.id, "tick", "tick");
    await wait(() => !!c.store.binding(child.id));
    assert.equal(
      created[1]?.[0],
      join(f.dir, "coordinator", "workspaces", child.id, "MiPlay LSFG"),
    );
    await wait(() => runtime.starts.length === 2);
    const childTurn = runtime.starts.find(
      (t) => t.threadId === c.store.binding(child.id)!.thread_id,
    )!;
    runtime.onRequest({
      id: 1,
      method: "item/tool/call",
      connectionGeneration: 1,
      params: {
        threadId: childTurn.threadId,
        turnId: childTurn.turnId,
        callId: "list",
        tool: "workspace_list",
        arguments: {},
      },
    });
    await wait(() => runtime.responses.length === 1);
    assert.equal((runtime.responses[0] as { success: boolean }).success, true);
  } finally {
    await c.stop();
    f.close();
  }
});

test("Lead detects conflicting sibling patches and stale dependency handoff, then recovers partial multi-repository integration", async () => {
  const f = fixture();
  try {
    const a = f.child(f.actor, "Left", { repositoryIds: ["app", "dxmt"] });
    const b = f.child(f.actor, "Right", { repositoryId: "app" });
    const reviewer = f.child(f.activate(a), "Review", {
      repositoryIds: ["app", "dxmt"],
    });
    let broker = f.broker;
    const read = async (agent: Agent, repositoryId: string) =>
      (await broker.call(agent, "read_file", {
        repositoryId,
        path: "value.txt",
      })) as { hash: string; content: string };
    const write = async (
      agent: Agent,
      repositoryId: string,
      content: string,
      hash: string,
    ) =>
      broker.call(agent, "write_file", {
        repositoryId,
        path: "value.txt",
        content,
        expectedHash: hash,
      });
    const originalApp = await read(f.root, "app"),
      originalDependency = await read(f.root, "dxmt");
    const leftBase = await read(a, "app"),
      rightBase = await read(b, "app"),
      dependencyBase = await read(a, "dxmt");
    await write(a, "app", "left", leftBase.hash);
    await write(b, "app", "right", rightBase.hash);
    await write(a, "dxmt", "right", dependencyBase.hash);
    assert.equal((await read(reviewer, "dxmt")).content, "right");
    await assert.rejects(
      () => write(reviewer, "app", "forbidden", leftBase.hash),
      /read-only/,
    );
    const appDiff = (await broker.call(a, "git_diff", {
      repositoryId: "app",
    })) as { baseCommit: string; diff: string };
    const competing = (await broker.call(b, "git_diff", {
      repositoryId: "app",
    })) as { diff: string };
    assert.equal(appDiff.baseCommit, f.policy.repositories!.app!.baseCommit);
    assert.match(appDiff.diff, /left/);
    await write(f.root, "app", "left", originalApp.hash);
    await assert.rejects(
      () => write(f.root, "app", "right", originalApp.hash),
      /hash|changed|conflict/i,
    );
    await broker.call(f.root, "write_file", {
      repositoryId: "app",
      path: "conflict.patch",
      content: competing.diff,
      expectedHash: null,
    });
    const conflict = (await broker.call(f.root, "terminal", {
      repositoryId: "app",
      command: "git apply --check conflict.patch",
    })) as { exitCode: number };
    assert.notEqual(conflict.exitCode, 0);
    assert.equal((await read(f.root, "app")).content, "left");
    await write(f.root, "dxmt", "upstream", originalDependency.hash);
    const upstream = (await broker.call(f.root, "terminal", {
      repositoryId: "dxmt",
      command:
        "git add value.txt && git commit -m 'upstream fixture' && git rev-parse HEAD",
    })) as { exitCode: number; output: string };
    assert.equal(upstream.exitCode, 0);
    assert.equal(
      (await read(a, "dxmt")).content,
      "right",
      "worktree must not silently follow upstream",
    );
    await assert.rejects(
      () => write(f.root, "dxmt", "right", originalDependency.hash),
      /hash|changed|conflict/i,
    );
    const task = f.store.tasks.create(f.actor, f.root.id, {
      requestKey: "integration",
      subject: "Integrate both repositories",
      description: "Require actual cross-repository golden",
    });
    const claimed = f.store.tasks.update(f.actor, f.root.id, {
      requestKey: "claim",
      taskId: task.id,
      expectedRevision: task.revision,
      action: "claim",
    });
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    const golden = `const fs=require('node:fs');require('node:assert/strict').deepEqual([fs.readFileSync(${JSON.stringify(join(f.roots.app!, "value.txt"))},'utf8'),fs.readFileSync(${JSON.stringify(join(f.roots.dxmt!, "value.txt"))},'utf8')],['left','right']);console.log('MULTIREPO_RECOVERY_OK')`;
    const command = quote(process.execPath) + " -e " + quote(golden);
    const partial = (await broker.call(f.root, "terminal", {
      repositoryId: "app",
      command,
    })) as { exitCode: number };
    assert.notEqual(partial.exitCode, 0);
    assert.equal(
      f.store.tasks.get(null, f.root.id, task.id).status,
      "in_progress",
    );
    broker = f.restart();
    assert.equal((await read(f.root, "app")).content, "left");
    assert.equal((await read(f.root, "dxmt")).content, "upstream");
    const reviewedDependency = await read(f.root, "dxmt");
    await write(f.root, "dxmt", "right", reviewedDependency.hash);
    const final = (await broker.call(f.root, "terminal", {
      repositoryId: "app",
      command,
    })) as { exitCode: number; output: string };
    assert.equal(final.exitCode, 0);
    assert.match(final.output, /MULTIREPO_RECOVERY_OK/);
    const completed = f.store.tasks.update(f.actor, f.root.id, {
      requestKey: "complete",
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: "complete",
      result: JSON.stringify({
        appBase: appDiff.baseCommit,
        dependencyHead: upstream.output.trim().split("\n").at(-1),
        golden: final.output,
      }),
    });
    assert.equal(completed.status, "completed");
  } finally {
    f.close();
  }
});
