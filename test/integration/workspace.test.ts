import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  linkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  WorkspaceBroker,
  workspacePolicy,
  workspaceTools,
} from "../../src/workspace/broker.ts";
import { Store, type Actor } from "../../src/storage/store.ts";
import { Coordinator } from "../../src/coordinator/coordinator.ts";
import { ControlledRuntime } from "../fixtures/controlled-runtime.ts";
function fixture() {
  const dir = mkdtempSync("/tmp/cat-ws-");
  const repo = join(dir, "repo"),
    state = join(dir, "state");
  mkdirSync(repo);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" })
      .toString()
      .trim();
  git(["init"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repo, "sum.js"), "export const sum = (a,b) => a-b;\n");
  writeFileSync(
    join(repo, "verify.mjs"),
    "import { sum } from './sum.js'; if(sum(2,3)!==5) process.exit(1); console.log('passed');\n",
  );
  git(["add", "."]);
  git(["commit", "-m", "fixture"]);
  const policy = workspacePolicy(repo, {
    unit: { executable: process.execPath, args: ["verify.mjs"] },
  });
  const store = new Store(join(state, "business.sqlite"));
  const a = store.createRoot("Lead", "code", {
    tokenPolicy: "observe",
    tokens: 10000,
    maxDepth: 2,
    maxAgents: 4,
    maxConcurrentTurns: 3,
    maxTurnsPerAgent: 8,
    turnReservation: 100,
  });
  const activate = (id: string): Actor => {
    const b = store.bind(id, "thread-" + id, "fixture");
    const t = store.prepare(id, "fixture");
    store.markStarting(t.id);
    store.attachTurn(t.id, 1, "turn-" + id);
    return store.authenticate(b.thread_id, "turn-" + id, 1);
  };
  const actor = activate(a.id);
  const b = store.spawn(actor, "B", { name: "B", role: "coder", task: "fix" });
  const ba = activate(b.id);
  const c = store.spawn(ba, "C", {
    name: "C",
    role: "reviewer",
    task: "review",
  });
  const broker = new WorkspaceBroker(state, policy, (id) => store.agent(id));
  return {
    dir,
    repo,
    state,
    policy,
    store,
    a,
    b,
    c,
    actor,
    ba,
    broker,
    close() {
      broker.cancel();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("coding hierarchy isolates sibling writes and enforces third-level read-only; CAS retry survives broker restart", async () => {
  const f = fixture();
  try {
    const rootPath = f.broker.cwd(f.a),
      childPath = f.broker.cwd(f.b);
    assert.equal(rootPath, f.policy.repository);
    assert.notEqual(childPath, rootPath);
    assert.equal(f.broker.cwd(f.c), childPath);
    const old = (await f.broker.call(f.b, "read_file", { path: "sum.js" })) as {
      hash: string;
    };
    const write = {
      path: "sum.js",
      expectedHash: old.hash,
      content: "export const sum = (a,b) => a+b;\n",
    };
    const before = (await f.broker.call(f.b, "run_test", { name: "unit" })) as {
      exitCode: number;
    };
    assert.equal(before.exitCode, 1);
    await f.broker.call(f.b, "write_file", write);
    assert.match(readFileSync(join(f.repo, "sum.js"), "utf8"), /a-b/);
    assert.match(
      (
        (await f.broker.call(f.c, "read_file", { path: "sum.js" })) as {
          content: string;
        }
      ).content,
      /a\+b/,
    );
    await assert.rejects(
      () => f.broker.call(f.c, "write_file", write),
      /read-only/,
    );
    await assert.rejects(
      () => f.broker.call(f.c, "run_test", { name: "unit" }),
      /cannot execute/,
    );
    const restart = new WorkspaceBroker(f.state, f.policy, (id) =>
      f.store.agent(id),
    );
    assert.equal(
      ((await restart.call(f.b, "write_file", write)) as { unchanged: boolean })
        .unchanged,
      true,
    );
    await assert.rejects(
      () => restart.call(f.b, "write_file", { ...write, content: "changed" }),
      /File changed/,
    );
    const result = (await restart.call(f.b, "run_test", { name: "unit" })) as {
      exitCode: number;
      output: string;
    };
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /passed/);
    const diff = (await restart.call(f.b, "git_diff", {})) as { diff: string };
    assert.match(diff.diff, /a\+b/);
    assert.ok(
      !workspaceTools(2, ["unit"]).some((t) =>
        ["write_file", "run_test"].includes(t.name),
      ),
    );
  } finally {
    f.close();
  }
});
test("workspace broker refuses escapes, links, protected files, command/identity injection and unbounded input", async () => {
  const f = fixture();
  try {
    const path = f.broker.cwd(f.b);
    symlinkSync(f.repo, join(path, "link"));
    linkSync(join(path, "sum.js"), join(path, "hard.js"));
    for (const input of [
      "../repo/sum.js",
      "/etc/passwd",
      "link/sum.js",
      "hard.js",
      "sum.js",
      ".git",
      ".env",
      "foo/../../sum.js",
      "foo\\bar",
      "/dev/null",
    ])
      await assert.rejects(() =>
        f.broker.call(f.b, "read_file", { path: input }),
      );
    await assert.rejects(
      () => f.broker.call(f.b, "run_test", { name: "unit; touch PWNED" }),
      /not operator-approved/,
    );
    await assert.rejects(
      () =>
        f.broker.call(f.b, "run_test", {
          name: "unit",
          args: ["--eval", "bad"],
        }),
      /Unknown/,
    );
    await assert.rejects(
      () =>
        f.broker.call(f.b, "read_file", {
          path: "verify.mjs",
          agentId: f.a.id,
        }),
      /Unknown/,
    );
    await assert.rejects(
      () =>
        f.broker.call(f.b, "write_file", {
          path: "big",
          content: "x".repeat(65537),
          expectedHash: null,
        }),
      /64 KiB/,
    );
    assert.equal(existsSync(join(path, "PWNED")), false);
  } finally {
    f.close();
  }
});
test("test environment excludes host credentials, output is bounded and cancellation kills supervised command", async () => {
  const f = fixture();
  try {
    const path = f.broker.cwd(f.b);
    writeFileSync(
      join(path, "env.mjs"),
      "console.log(process.env.CAT_WORKSPACE_SECRET ?? 'excluded');console.log('x'.repeat(100000));",
    );
    f.policy.tests.env = { executable: process.execPath, args: ["env.mjs"] };
    process.env.CAT_WORKSPACE_SECRET = "never-forward-this";
    const result = (await f.broker.call(f.b, "run_test", { name: "env" })) as {
      output: string;
      truncated: boolean;
    };
    assert.match(result.output, /excluded/);
    assert.equal(result.output.includes("never-forward-this"), false);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.output) <= 65536);
    writeFileSync(join(path, "slow.mjs"), "setInterval(()=>{},1000)");
    f.policy.tests.slow = { executable: process.execPath, args: ["slow.mjs"] };
    const running = f.broker.call(f.b, "run_test", { name: "slow" });
    setTimeout(() => f.broker.cancel(f.b.id), 150);
    const ended = (await running) as {
      exitCode: number | null;
      stopped: string;
    };
    assert.equal(ended.stopped, "cancelled");
    assert.notEqual(ended.exitCode, 0);
  } finally {
    delete process.env.CAT_WORKSPACE_SECRET;
    f.close();
  }
});
test("test command receipts cache completed calls and retain uncertain accepted work after restart", () => {
  const f = fixture();
  try {
    assert.deepEqual(
      f.store.beginWorkspaceCommand(f.ba, "once", { name: "unit" }),
      { cached: false },
    );
    assert.throws(
      () => f.store.beginWorkspaceCommand(f.ba, "once", { name: "unit" }),
      /unknown or still running/,
    );
    f.store.finishWorkspaceCommand(f.b.id, "once", { exitCode: 0 });
    assert.deepEqual(
      f.store.beginWorkspaceCommand(f.ba, "once", { name: "unit" }),
      { cached: true, result: { exitCode: 0 } },
    );
    assert.throws(
      () => f.store.beginWorkspaceCommand(f.ba, "once", { name: "other" }),
      /changed input/,
    );
    f.store.beginWorkspaceCommand(f.ba, "uncertain", { name: "unit" });
    f.store.close();
    const reopened = new Store(join(f.state, "business.sqlite"));
    try {
      assert.throws(
        () =>
          reopened.beginWorkspaceCommand(f.ba, "uncertain", { name: "unit" }),
        /unknown or still running/,
      );
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});
test("Coordinator checks actual native identity and lifecycle even for hidden descendant tool calls", async () => {
  const f = fixture();
  f.store.close();
  const runtime = new ControlledRuntime();
  const c = new Coordinator(
    {
      stateDirectory: join(f.dir, "other"),
      runtimeHome: join(f.dir, "home"),
      expectedVersion: "fixture",
      workspace: f.policy,
    },
    runtime,
  );
  try {
    await c.start();
    const a = c.createRoot("Lead", "code", {
      tokenPolicy: "observe",
      tokens: 10000,
      maxDepth: 2,
      maxAgents: 3,
      maxConcurrentTurns: 3,
      maxTurnsPerAgent: 4,
      turnReservation: 100,
    });
    const gate = async (p: () => boolean) => {
      for (let i = 0; i < 200 && !p(); i++)
        await new Promise<void>((r) => setImmediate(r));
      assert.ok(p());
    };
    await gate(
      () => runtime.starts.length === 1 && !!c.store.attempts()[0]?.turn_id,
    );
    const t = runtime.starts[0]!;
    runtime.onRequest({
      id: 1,
      method: "item/tool/call",
      connectionGeneration: 1,
      params: {
        threadId: t.threadId,
        turnId: "forged",
        callId: "bad",
        tool: "write_file",
        arguments: { path: "PWNED", content: "bad", expectedHash: null },
      },
    });
    await gate(() => runtime.responses.length === 1);
    assert.equal((runtime.responses[0] as { success: boolean }).success, false);
    assert.equal(existsSync(join(f.repo, "PWNED")), false);
    await c.control(a.id, "pause");
    runtime.onRequest({
      id: 2,
      method: "item/tool/call",
      connectionGeneration: 1,
      params: {
        threadId: t.threadId,
        turnId: t.turnId,
        callId: "paused",
        tool: "write_file",
        arguments: { path: "PWNED", content: "bad", expectedHash: null },
      },
    });
    await gate(() => runtime.responses.length === 2);
    assert.equal((runtime.responses[1] as { success: boolean }).success, false);
  } finally {
    await c.stop();
    f.close();
  }
});
test("actual test sandbox denies private reads, external writes, symlink reads and network even from edited test code", async () => {
  const f = fixture();
  try {
    const path = f.broker.cwd(f.b),
      outside = join(f.dir, "private-canary");
    writeFileSync(outside, "never-readable");
    symlinkSync(outside, join(path, "outside-link"));
    writeFileSync(
      join(path, "security.mjs"),
      `import fs from 'node:fs'; import net from 'node:net';
let denied=0;
for(const p of [${JSON.stringify(outside)},'outside-link']) {try{fs.readFileSync(p); console.log('LEAK');}catch{denied++;}}
try{fs.writeFileSync(${JSON.stringify(join(f.dir, "outside-write"))},'bad');}catch{denied++;}
const socket=net.connect({host:'127.0.0.1',port:9});socket.on('error',e=>{if(e.code==='EPERM'||e.code==='EACCES')denied++;console.log('denied='+denied);process.exit(denied===4?0:1);});
setTimeout(()=>process.exit(2),2000);
`,
    );
    f.policy.tests.security = {
      executable: process.execPath,
      args: ["security.mjs"],
    };
    const result = (await f.broker.call(f.b, "run_test", {
      name: "security",
    })) as { exitCode: number; output: string };
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /denied=4/);
    assert.doesNotMatch(result.output, /LEAK/);
    assert.equal(existsSync(join(f.dir, "outside-write")), false);
  } finally {
    f.close();
  }
});
test("Lead terminal executes shell and Git within repository; descendants cannot invoke it", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () => f.broker.call(f.b, "terminal", { command: "echo forbidden" }),
      /Only Lead/,
    );
    assert.ok(workspaceTools(0, []).some((t) => t.name === "terminal"));
    assert.ok(!workspaceTools(1, ["unit"]).some((t) => t.name === "terminal"));
    const result = (await f.broker.call(f.a, "terminal", {
      command: "git status --porcelain && echo LEAD_TERMINAL_OK",
    })) as { exitCode: number; output: string };
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /LEAD_TERMINAL_OK/);
    const path = f.broker.cwd(f.b);
    const before = (await f.broker.call(f.b, "read_file", {
      path: "sum.js",
    })) as { hash: string };
    await f.broker.call(f.b, "write_file", {
      path: "sum.js",
      expectedHash: before.hash,
      content: "export const sum = (a,b) => a+b;\n",
    });
    const integrated = (await f.broker.call(f.a, "terminal", {
      command: `git -C '${path}' diff --no-ext-diff --no-textconv -- sum.js | git apply && git add sum.js && git commit -m 'integrate reviewed patch' && '${process.execPath}' verify.mjs`,
    })) as { exitCode: number; output: string };
    assert.equal(integrated.exitCode, 0, integrated.output);
    assert.match(integrated.output, /passed/);
    assert.match(readFileSync(join(f.repo, "sum.js"), "utf8"), /a\+b/);
  } finally {
    f.close();
  }
});
test("new nested files stay inside the worktree; invalid CAS and third-level calls create no directories", async () => {
  const f = fixture();
  try {
    const root = f.broker.cwd(f.b);
    await assert.rejects(
      () =>
        f.broker.call(f.b, "write_file", {
          path: "bad/new.mjs",
          expectedHash: "a".repeat(64),
          content: "bad",
        }),
      /File changed/,
    );
    assert.equal(existsSync(join(root, "bad")), false);
    await f.broker.call(f.b, "write_file", {
      path: "module/nested/new.mjs",
      expectedHash: null,
      content: "export const value = 1;\n",
    });
    assert.equal(
      readFileSync(join(root, "module/nested/new.mjs"), "utf8"),
      "export const value = 1;\n",
    );
    await assert.rejects(
      () =>
        f.broker.call(f.c, "write_file", {
          path: "forbidden/new.mjs",
          expectedHash: null,
          content: "bad",
        }),
      /read-only/,
    );
    assert.equal(existsSync(join(root, "forbidden")), false);
  } finally {
    f.close();
  }
});
test("CLI coding init persists an explicit policy, refuses credential paths inside repository and enforces clean source", () => {
  const f = fixture();
  try {
    const source = join(f.dir, "provider.toml"),
      commands = join(f.dir, "tests.json");
    writeFileSync(source, 'model="fixture"\n');
    writeFileSync(commands, JSON.stringify(f.policy.tests));
    const run = (state: string, home: string) => {
      try {
        return {
          status: 0,
          output: execFileSync(
            process.execPath,
            [
              "src/cli/main.ts",
              "init",
              "--state",
              state,
              "--runtime-home",
              home,
              "--workspace",
              f.repo,
              "--test-commands",
              commands,
              "--config-from",
              source,
              "--provider-env",
              "CAT_FIXTURE_API_KEY",
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
          ),
        };
      } catch (e) {
        return { status: 1, output: String((e as { stderr: Buffer }).stderr) };
      }
    };
    const state = join(f.dir, "cli"),
      home = join(f.dir, "home");
    assert.equal(run(state, home).status, 0);
    const config = JSON.parse(readFileSync(join(state, "config.json"), "utf8"));
    assert.equal(config.workspace.repository, f.policy.repository);
    assert.equal(config.workspace.baseCommit, f.policy.baseCommit);
    assert.equal(existsSync(join(home, "auth.json")), false);
    const badHome = join(f.repo, "private-runtime");
    const denied = run(join(f.dir, "bad"), badHome);
    assert.notEqual(denied.status, 0);
    assert.equal(existsSync(join(badHome, "config.toml")), false);
    writeFileSync(join(f.repo, "dirty.mjs"), "uncommitted");
    assert.notEqual(run(join(f.dir, "dirty"), join(f.dir, "other")).status, 0);
  } finally {
    f.close();
  }
});
test("file tools cannot race an active sandbox test in the same workspace, including third-level reads", async () => {
  const f = fixture();
  try {
    const path = f.broker.cwd(f.b);
    writeFileSync(join(path, "slow.mjs"), "setInterval(()=>{},1000)");
    f.policy.tests.slow = { executable: process.execPath, args: ["slow.mjs"] };
    const running = f.broker.call(f.b, "run_test", { name: "slow" });
    await assert.rejects(
      () =>
        f.broker.call(f.b, "write_file", {
          path: "race/new.mjs",
          expectedHash: null,
          content: "bad",
        }),
      /command is running/,
    );
    await assert.rejects(
      () => f.broker.call(f.c, "read_file", { path: "sum.js" }),
      /command is running/,
    );
    assert.equal(existsSync(join(path, "race")), false);
    f.broker.cancel(f.b.id);
    await running;
    assert.ok(await f.broker.call(f.c, "read_file", { path: "sum.js" }));
  } finally {
    f.close();
  }
});
test("case aliases cannot rewrite protected Git/config paths on case-insensitive filesystems", async () => {
  const f = fixture();
  try {
    for (const path of [
      ".GIT",
      ".GiT/config",
      ".CODEX/config.toml",
      ".ENV",
      "AUTH.JSON",
      "NODE_MODULES/a",
    ])
      await assert.rejects(
        () =>
          f.broker.call(f.b, "write_file", {
            path,
            content: "blocked",
            expectedHash: null,
          }),
        /protected entries/,
      );
  } finally {
    f.close();
  }
});
test("git diff clean filters cannot escape sandbox or mutate their workspace; positive control confirms execution", async () => {
  const f = fixture();
  try {
    const path = f.broker.cwd(f.b),
      outside = join(f.dir, "filter-outside"),
      inside = join(path, "filter-inside");
    const code = `import fs from 'node:fs';for(const p of [${JSON.stringify(outside)},${JSON.stringify(inside)}])try{fs.writeFileSync(p,'owned');}catch{}process.stdout.write(fs.readFileSync(0,'utf8'));`;
    await f.broker.call(f.b, "write_file", {
      path: "filter.mjs",
      expectedHash: null,
      content: code,
    });
    await f.broker.call(f.b, "write_file", {
      path: ".gitattributes",
      expectedHash: null,
      content: "sum.js filter=escape\n",
    });
    const old = (await f.broker.call(f.b, "read_file", { path: "sum.js" })) as {
      hash: string;
    };
    await f.broker.call(f.b, "write_file", {
      path: "sum.js",
      content: "export const sum = (a,b) => a+b;\n",
      expectedHash: old.hash,
    });
    execFileSync("git", [
      "-C",
      f.repo,
      "config",
      "filter.escape.clean",
      `${process.execPath} ./filter.mjs`,
    ]);
    execFileSync(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-C",
        path,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
      ],
      { stdio: "pipe" },
    );
    assert.equal(
      existsSync(outside),
      true,
      "Unrestricted positive control did not run filter",
    );
    assert.equal(existsSync(inside), true);
    rmSync(outside);
    rmSync(inside);
    const diff = (await f.broker.call(f.b, "git_diff", {})) as { diff: string };
    assert.match(diff.diff, /a\+b/);
    assert.equal(existsSync(outside), false);
    assert.equal(existsSync(inside), false);
  } finally {
    f.close();
  }
});
test("worktree checkout smudge filter cannot write outside its sandbox; positive control confirms filter", async () => {
  const f = fixture();
  try {
    const outside = join(f.dir, "checkout-outside"),
      script = join(f.repo, "checkout-filter.mjs");
    writeFileSync(
      script,
      `import fs from 'node:fs';try{fs.writeFileSync(${JSON.stringify(outside)},'owned');}catch{}process.stdout.write(fs.readFileSync(0,'utf8'));`,
    );
    writeFileSync(join(f.repo, ".gitattributes"), "sum.js filter=escape\n");
    const git = (args: string[]) =>
      execFileSync("git", ["-C", f.repo, ...args], { stdio: "pipe" })
        .toString()
        .trim();
    git(["add", "."]);
    git(["commit", "-m", "filter fixture"]);
    f.policy.baseCommit = git(["rev-parse", "HEAD"]);
    git(["config", "filter.escape.smudge", `${process.execPath} ${script}`]);
    git([
      "worktree",
      "add",
      "--detach",
      join(f.dir, "positive-control"),
      f.policy.baseCommit,
    ]);
    assert.equal(
      existsSync(outside),
      true,
      "Unrestricted control did not run smudge filter",
    );
    rmSync(outside);
    f.broker.cwd(f.b);
    assert.equal(existsSync(outside), false);
  } finally {
    f.close();
  }
});
test("incomplete worktree provisioning after a crash refuses reuse or automatic reset", () => {
  const f = fixture();
  try {
    const path = f.broker.cwd(f.b);
    writeFileSync(join(path, "preserve.patch"), "uncommitted work");
    const marker = join(f.state, "worktree-ready", f.b.id + ".json");
    rmSync(marker);
    const reopened = new WorkspaceBroker(f.state, f.policy, (id) =>
      f.store.agent(id),
    );
    assert.throws(() => reopened.cwd(f.b), /provisioning is incomplete/);
    assert.equal(
      readFileSync(join(path, "preserve.patch"), "utf8"),
      "uncommitted work",
    );
  } finally {
    f.close();
  }
});
test("scheduler exposes an incomplete worktree reason without starting or resetting the child", async () => {
  const f = fixture();
  const runtime = new ControlledRuntime(),
    state = join(f.dir, "diagnostic-state");
  const c = new Coordinator(
    {
      stateDirectory: state,
      runtimeHome: join(f.dir, "diagnostic-home"),
      expectedVersion: "fixture",
      workspace: f.policy,
    },
    runtime,
  );
  const gate = async (p: () => boolean) => {
    for (let i = 0; i < 500 && !p(); i++)
      await new Promise<void>((r) => setImmediate(r));
    assert.ok(p());
  };
  try {
    await c.start();
    const root = c.createRoot("Lead", "code", {
      tokenPolicy: "observe",
      tokens: 1000,
      maxDepth: 1,
      maxAgents: 2,
      maxConcurrentTurns: 2,
      maxTurnsPerAgent: 2,
      turnReservation: 100,
    });
    await gate(
      () => runtime.starts.length === 1 && !!c.store.attempts()[0]?.turn_id,
    );
    const turn = runtime.starts[0]!;
    const actor = c.store.authenticate(turn.threadId, turn.turnId, 1),
      child = c.store.spawn(actor, "child", {
        name: "Coder",
        role: "coder",
        task: "code",
      });
    const path = join(state, "workspaces", child.id);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "keep.txt"), "preserve");
    c.submitInput(root.id, "tick", "input");
    await gate(() =>
      c.store.events(child.id).some((e) => e.kind === "scheduler.error"),
    );
    const e = c.store
      .events(child.id)
      .find((e) => e.kind === "scheduler.error")!;
    assert.match(
      JSON.parse(String(e.body)).message,
      /provisioning is incomplete/,
    );
    assert.equal(c.store.binding(child.id), undefined);
    assert.equal(runtime.starts.length, 1);
    assert.equal(readFileSync(join(path, "keep.txt"), "utf8"), "preserve");
  } finally {
    await c.stop();
    f.close();
  }
});
test("command effect is cached for the same native call ID; a new call ID intentionally runs new work", async () => {
  const f = fixture(),
    runtime = new ControlledRuntime();
  const c = new Coordinator(
    {
      stateDirectory: join(f.dir, "receipt-state"),
      runtimeHome: join(f.dir, "receipt-home"),
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
    c.createRoot("Lead", "fixture", {
      tokenPolicy: "observe",
      tokens: 1000,
      maxDepth: 0,
      maxAgents: 1,
      maxConcurrentTurns: 1,
      maxTurnsPerAgent: 2,
      turnReservation: 100,
    });
    await wait(
      () => runtime.starts.length === 1 && !!c.store.attempts()[0]?.turn_id,
    );
    const t = runtime.starts[0]!;
    const command = `'${process.execPath}' -e 'require("node:fs").appendFileSync("counter.txt","x")'`;
    for (const [index, callId] of [
      "same-call",
      "same-call",
      "new-call",
    ].entries()) {
      runtime.onRequest({
        id: index + 1,
        method: "item/tool/call",
        connectionGeneration: 1,
        params: {
          threadId: t.threadId,
          turnId: t.turnId,
          callId,
          tool: "terminal",
          arguments: { command },
        },
      });
      await wait(() => runtime.responses.length === index + 1);
      assert.equal(
        (runtime.responses[index] as { success: boolean }).success,
        true,
      );
      assert.equal(
        readFileSync(join(f.repo, "counter.txt"), "utf8"),
        index < 2 ? "x" : "xx",
      );
    }
    assert.equal(
      c.store.workspaceCommandSummary(c.store.agents()[0]!.id)?.total,
      2,
    );
  } finally {
    await c.stop();
    f.close();
  }
});

test("tracked handoffs persist and preview clean/conflicting targets without merging", async () => {
  const { handoff, previewHandoff } =
    await import("../../src/workspace/handoff.ts");
  const f = fixture();
  try {
    const child = f.broker.cwd(f.b);
    writeFileSync(join(child, "sum.js"), "export const sum = (a,b) => a+b;\n");
    const input = {
      requestKey: "patch",
      repositoryId: "default",
      baseCommit: f.policy.baseCommit,
      validation: "Declared: inspected patch; not independently verified",
    };
    const first = handoff(f.store, f.broker, f.b.id, input);
    assert.equal(first.artifactKind, "tracked-patch");
    assert.ok(first.patchSha256);
    assert.deepEqual(handoff(f.store, f.broker, f.b.id, input), first);
    const before = readFileSync(join(f.repo, "sum.js"), "utf8");
    const preview = previewHandoff(f.store, f.broker, f.a.id, first.id);
    assert.deepEqual(preview.issues, []);
    assert.equal(preview.automaticMerge, false);
    assert.equal(readFileSync(join(f.repo, "sum.js"), "utf8"), before);
    writeFileSync(join(f.repo, "sum.js"), "conflicting target edit\n");
    const dirty = previewHandoff(f.store, f.broker, f.a.id, first.id);
    assert.ok(dirty.issues.includes("target-worktree-dirty"));
    assert.ok(dirty.issues.includes("patch-does-not-apply-cleanly"));
    const missing = handoff(f.store, f.broker, f.b.id, {
      ...input,
      requestKey: "dependency",
      dependsOn: ["missing-handoff"],
    });
    assert.ok(
      previewHandoff(f.store, f.broker, f.a.id, missing.id).issues.includes(
        "missing-dependency:missing-handoff",
      ),
    );
    assert.throws(
      () =>
        handoff(f.store, f.broker, f.b.id, { ...input, validation: "changed" }),
      /changed content/,
    );
    writeFileSync(join(child, "untracked.txt"), "must not omit");
    const bundle = handoff(f.store, f.broker, f.b.id, {
      ...input,
      requestKey: "untracked",
    });
    assert.equal(bundle.files[0]!.path, "untracked.txt");
    assert.equal(bundle.files[0]!.content, "must not omit");
    writeFileSync(join(f.repo, "untracked.txt"), "collision");
    assert.ok(
      previewHandoff(f.store, f.broker, f.a.id, bundle.id).issues.includes(
        "new-file-collision:untracked.txt",
      ),
    );
    assert.throws(
      () => previewHandoff(f.store, f.broker, f.a.id, "unknown"),
      /not found/,
    );
  } finally {
    f.close();
  }
});

test("commit handoffs identify divergent targets and reject protected artifacts or cross-tree reads", async () => {
  const { handoff, previewHandoff } =
    await import("../../src/workspace/handoff.ts");
  const f = fixture();
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-C",
        cwd,
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  try {
    const child = f.broker.cwd(f.b);
    writeFileSync(join(child, "sum.js"), "export const sum = (a,b) => a+b;\n");
    git(child, "add", ".");
    git(child, "commit", "-m", "child change");
    const commit = git(child, "rev-parse", "HEAD");
    const input = {
      requestKey: "commit",
      repositoryId: "default",
      baseCommit: f.policy.baseCommit,
      commit,
      validation: "Agent declaration only",
    };
    const record = handoff(f.store, f.broker, f.b.id, input);
    writeFileSync(join(f.repo, "sum.js"), "export const sum = (a,b) => a*b;\n");
    git(f.repo, "add", ".");
    git(f.repo, "commit", "-m", "divergent lead");
    const target = git(f.repo, "rev-parse", "HEAD");
    const p = previewHandoff(f.store, f.broker, f.a.id, record.id);
    assert.ok(p.issues.includes("target-baseline-changed"));
    assert.ok(p.issues.includes("possible-merge-conflict"));
    assert.equal(git(f.repo, "rev-parse", "HEAD"), target);
    assert.equal(git(f.repo, "status", "--porcelain"), "");
    const stranger = f.store.createRoot("Other", "work", {
      tokens: 1000,
      maxDepth: 1,
      maxAgents: 1,
      maxConcurrentTurns: 1,
      maxTurnsPerAgent: 1,
      turnReservation: 1,
    });
    assert.throws(
      () => previewHandoff(f.store, f.broker, stranger.id, record.id),
      /not found/,
    );
    writeFileSync(join(child, ".env"), "must-not-leak");
    git(child, "add", ".env");
    git(child, "commit", "-m", "protected fixture");
    assert.throws(
      () =>
        handoff(f.store, f.broker, f.b.id, {
          ...input,
          requestKey: "protected",
          commit: git(child, "rev-parse", "HEAD"),
        }),
      /protected/,
    );
  } finally {
    f.close();
  }
});
