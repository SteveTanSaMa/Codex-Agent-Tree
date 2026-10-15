#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const expected = "codex-cli 0.162.0-alpha.17.2";
const args = process.argv.slice(2);
const command = args.shift() ?? "help";

function doctor() {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  const nodeOK =
    major > 26 || (major === 26 && (minor > 3 || (minor === 3 && patch >= 1)));
  const codex = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    timeout: 10000,
  });
  const version = codex.stdout?.trim() ?? "";
  const checks = {
    node: { ok: nodeOK, actual: process.version, required: ">=26.3.1" },
    platform: {
      ok: process.platform === "darwin" && process.arch === "arm64",
      actual: `${process.platform}/${process.arch}`,
      tested: "darwin/arm64",
    },
    codex: {
      ok: !codex.error && codex.status === 0 && version === expected,
      actual: version || "unavailable",
      required: expected,
    },
    dependencies: {
      ok: existsSync(join(root, "node_modules/ws/package.json")),
    },
  };
  const ok = Object.values(checks).every((check) => check.ok);
  console.log(JSON.stringify({ ok, skillDirectory: root, checks }, null, 2));
  return ok ? 0 : 1;
}

try {
  if (command === "doctor") process.exitCode = doctor();
  else if (command === "setup") {
    const result = spawnSync(
      "npm",
      ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: root, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    if (process.exitCode === 0) process.exitCode = doctor();
  } else {
    const commands = new Set([
      "help",
      "init",
      "start",
      "serve",
      "root",
      "tree",
      "list",
      "status",
      "view",
      "wait",
      "task-create",
      "task-list",
      "task-get",
      "task-update",
      "events",
      "send",
      "control",
      "native-history",
      "release-quarantine",
      "settle-usage",
      "stop",
    ]);
    if (!commands.has(command)) throw new Error(`Unknown command: ${command}`);
    const taskFile = args.indexOf("--task-file");
    if (taskFile >= 0) {
      if (command !== "root" || !args[taskFile + 1] || args.includes("--task"))
        throw new Error("Use root --task-file PATH, without --task");
      const task = readFileSync(args[taskFile + 1], "utf8");
      args.splice(taskFile, 2, "--task", task);
    }
    const result = spawnSync(
      process.execPath,
      [join(root, "src/cli/main.ts"), command, ...args],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Skill command failed",
  );
  process.exitCode = 1;
}
