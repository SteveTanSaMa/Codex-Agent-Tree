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
    const policy = {
      repository: repo,
      baseCommit: "a".repeat(40),
      tests: { linger: { executable: process.execPath, args: ["linger.mjs"] } },
    };
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
