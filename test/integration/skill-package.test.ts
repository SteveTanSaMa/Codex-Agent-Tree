import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

test("packaged Skill runs outside the checkout and passes task text literally with a stable key", async () => {
  const directory = mkdtempSync("/tmp/cat-skill-");
  const state = join(directory, "state");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(state);
  writeFileSync(join(state, "operator-token"), "fixture-secret", {
    mode: 0o600,
  });
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    .version as string;
  const archive = join(root, "dist", `codex-agent-tree-${version}.zip`);
  let received: unknown;
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      if (!buffer.includes("\n")) return;
      received = JSON.parse(buffer.trim());
      socket.end(JSON.stringify({ result: { id: "packaged-root" } }) + "\n");
    });
  });
  try {
    await execute("python3", [join(root, "scripts/package-skill.py")]);
    await execute("python3", ["-m", "zipfile", "-e", archive, directory]);
    const installed = join(directory, "codex-agent-tree");
    // This regression is offline: supply the installed production dependency.
    cpSync(join(root, "node_modules/ws"), join(installed, "node_modules/ws"), {
      recursive: true,
    });
    const instructions = readFileSync(join(installed, "SKILL.md"), "utf8");
    for (const match of instructions.matchAll(/\]\(([^)]+)\)/g)) {
      const path = match[1]!.split("#")[0]!;
      if (path && !path.includes(":"))
        assert.doesNotThrow(
          () => readFileSync(join(installed, path)),
          `Missing packaged Skill reference: ${path}`,
        );
    }
    const task =
      'Review quoted "input"\n$(touch should-never-exist) `literal` $HOME';
    const taskFile = join(directory, "task with spaces.txt");
    writeFileSync(taskFile, task);
    await new Promise<void>((r) =>
      server.listen(join(state, "control.sock"), r),
    );
    const result = await execute(
      process.execPath,
      [
        join(installed, "scripts/cat.mjs"),
        "root",
        "--state",
        state,
        "--task-file",
        taskFile,
        "--key",
        "stable-package-key",
      ],
      { cwd: directory },
    );
    assert.equal(JSON.parse(result.stdout).id, "packaged-root");
    const request = received as {
      token: string;
      method: string;
      params: { task: string; requestKey: string };
    };
    assert.equal(request.token, "fixture-secret");
    assert.equal(request.method, "root");
    assert.equal(request.params.task, task);
    assert.equal(request.params.requestKey, "stable-package-key");
    const { stdout } = await execute("python3", [
      "-m",
      "zipfile",
      "-l",
      archive,
    ]);
    assert.doesNotMatch(
      stdout,
      /node_modules|auth\.json|operator-token|\.sqlite|evidence|test\//,
    );
    const doctor = await execute(
      process.execPath,
      [join(installed, "scripts/cat.mjs"), "doctor"],
      { cwd: directory },
    ).catch((e: { stdout: string }) => e);
    const report = JSON.parse(doctor.stdout) as {
      skillDirectory: string;
      checks: { dependencies: { ok: boolean } };
    };
    assert.equal(report.skillDirectory, realpathSync(installed));
    assert.equal(report.checks.dependencies.ok, true);
  } finally {
    if (server.listening)
      await new Promise<void>((r) => server.close(() => r()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Skill wrapper rejects conflicting task sources and unknown commands", async () => {
  const wrapper = join(root, "scripts/cat.mjs");
  await assert.rejects(
    execute(process.execPath, [
      wrapper,
      "root",
      "--task",
      "one",
      "--task-file",
      "/missing",
    ]),
    /without --task/,
  );
  await assert.rejects(
    execute(process.execPath, [wrapper, "typo"]),
    /Unknown command/,
  );
});
