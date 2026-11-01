import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  workspacePolicy,
  WorkspaceBroker,
} from "../../src/workspace/broker.ts";
import { Store } from "../../src/storage/store.ts";
test(
  "SIGKILL of test host closes supervisor pipe and stops its sandboxed process group",
  { timeout: 10000 },
  async () => {
    const dir = realpathSync(mkdtempSync("/tmp/cat-parent-death-"));
    const repo = join(dir, "repo"),
      state = join(dir, "state");
    mkdirSync(repo);
    mkdirSync(state);
    writeFileSync(
      join(repo, "linger.mjs"),
      "import fs from 'node:fs';fs.writeFileSync('owned-pid',String(process.pid));setInterval(()=>{},1000);",
    );
    const git = (args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git(["init"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["add", "."]);
    git(["commit", "-m", "fixture"]);
    const policy = workspacePolicy(repo, {
      linger: { executable: process.execPath, args: ["linger.mjs"] },
    });
    const host = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("../fixtures/workspace-command-child.ts", import.meta.url),
        ),
        JSON.stringify(policy),
        state,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let pid: number | undefined;
    const dead = once(host, "exit");
    try {
      const deadline = Date.now() + 4000;
      while (!existsSync(join(repo, "owned-pid")) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 20));
      assert.ok(
        existsSync(join(repo, "owned-pid")),
        "Sandbox test failed to start",
      );
      pid = Number(readFileSync(join(repo, "owned-pid"), "utf8"));
      assert.match(
        execFileSync("ps", ["-p", String(pid), "-o", "args="], {
          encoding: "utf8",
        }),
        /linger.mjs/,
      );
      host.kill("SIGKILL");
      await dead;
      const alive = () => {
        try {
          const state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
          return !!state && !state.startsWith("Z");
        } catch {
          return false;
        }
      };
      const end = Date.now() + 3000;
      while (alive() && Date.now() < end)
        await new Promise((r) => setTimeout(r, 25));
      assert.equal(alive(), false, "Supervised test survived host death");
    } finally {
      if (host.exitCode === null && host.signalCode === null)
        host.kill("SIGKILL");
      if (pid)
        try {
          if (
            execFileSync("ps", ["-p", String(pid), "-o", "args="], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            }).includes("linger.mjs")
          )
            process.kill(pid, "SIGKILL");
        } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "SIGKILL during accepted background command kills its process group and preserves unknown receipt",
  { timeout: 10000 },
  async () => {
    const dir = realpathSync(mkdtempSync("/tmp/cat-async-death-"));
    const repo = join(dir, "repo"),
      state = join(dir, "state"),
      runtime = join(dir, "runtime");
    mkdirSync(repo);
    const git = (args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git(["init"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(repo, "file.txt"), "fixture");
    git(["add", "."]);
    git(["commit", "-m", "fixture"]);
    const policy = workspacePolicy(repo, {});
    const host = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("../fixtures/async-command-host.ts", import.meta.url),
        ),
        state,
        runtime,
        JSON.stringify(policy),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let errorOutput = "";
    host.stderr.on(
      "data",
      (chunk: Buffer) => (errorOutput += chunk.toString()),
    );
    let pid: number | undefined;
    try {
      const deadline = Date.now() + 5000;
      while (
        !existsSync(join(repo, "async-pid")) &&
        host.exitCode === null &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 20));
      assert.ok(
        existsSync(join(repo, "async-pid")),
        `background command did not start: ${errorOutput}`,
      );
      pid = Number(readFileSync(join(repo, "async-pid"), "utf8"));
      const exited = once(host, "exit");
      host.kill("SIGKILL");
      await exited;
      const alive = () => {
        try {
          const state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
          return !!state && !state.startsWith("Z");
        } catch {
          return false;
        }
      };
      const end = Date.now() + 3000;
      while (alive() && Date.now() < end)
        await new Promise((r) => setTimeout(r, 25));
      assert.equal(
        alive(),
        false,
        "supervised command survived coordinator crash",
      );
      const store = new Store(join(state, "business.sqlite"));
      try {
        const agent = store.agents()[0]!;
        assert.equal(
          store.workspaceCommand(agent.id, "crash-command").state,
          "accepted",
        );
        const broker = new WorkspaceBroker(state, policy, (id) =>
          store.agent(id),
        );
        assert.equal(
          broker.backgroundCommandRunning(agent.id, "crash-command"),
          false,
        );
      } finally {
        store.close();
      }
    } finally {
      if (host.exitCode === null && host.signalCode === null)
        host.kill("SIGKILL");
      if (pid)
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
