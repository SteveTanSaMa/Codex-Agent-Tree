import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const execute = promisify(execFile);
test(
  "soak watchdog cleans its owned homes when the runner dies before its first status or final report",
  { skip: process.platform !== "darwin", timeout: 15000 },
  async () => {
    const root = mkdtempSync("/tmp/cat-soak-watchdog-"),
      base = join(root, "base"),
      run = join(root, "evidence"),
      skill = join(root, "skill");
    mkdirSync(run);
    mkdirSync(join(skill, "scripts"), { recursive: true });
    const exe = join(root, "fixture-codex.mjs");
    writeFileSync(
      exe,
      `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(process.env.CODEX_HOME+'/daemon-stopped','yes');\n`,
    );
    chmodSync(exe, 0o700);
    writeFileSync(
      join(skill, "scripts/cat.mjs"),
      `import fs from 'node:fs';const state=process.argv[process.argv.indexOf('--state')+1];if(process.argv.includes('stop'))fs.writeFileSync(state+'/coordinator-stopped','yes');`,
    );
    copyFileSync(
      fileURLToPath(new URL("../../scripts/soak/watchdog.py", import.meta.url)),
      join(root, "watchdog.py"),
    );
    writeFileSync(
      join(root, "runner.mjs"),
      `import fs from 'node:fs';const a=process.argv;const get=n=>a[a.indexOf('--'+n)+1];const base=get('base'),run=get('run-dir');const paths={coding:{state:base+'/s',home:base+'/h'},calibration:{state:base+'/c',home:base+'/k'}};for(const p of Object.values(paths)){fs.mkdirSync(p.state,{recursive:true});fs.mkdirSync(p.home,{recursive:true});fs.writeFileSync(p.state+'/control.sock','fixture');}fs.writeFileSync(run+'/ownership.json',JSON.stringify({runnerPid:process.pid,base,paths}));process.kill(process.pid,'SIGKILL');`,
    );
    // The harness insists that its base is under /tmp/cat-soak-. Use a fresh
    // sibling so this test also exercises the same ownership path check.
    const owned = "/tmp/cat-soak-" + root.split("-").at(-1) + "-dead";
    try {
      await execute("python3", [
        join(root, "watchdog.py"),
        "--run-dir",
        run,
        "--base",
        owned,
        "--skill",
        skill,
        "--executable",
        exe,
        "--node",
        process.execPath,
        "--duration-seconds",
        "180",
        "--smoke",
      ]);
      const result = JSON.parse(readFileSync(join(run, "result.json"), "utf8"));
      assert.equal(result.phase, "failed");
      assert.match(result.failure, /without final report/);
      const watchdog = JSON.parse(
        readFileSync(join(run, "watchdog-result.json"), "utf8"),
      );
      assert.equal(watchdog.runnerExitCode, -9);
      assert.equal(watchdog.forcedDeadline, false);
      for (const lane of ["s", "c"])
        assert.equal(
          readFileSync(join(owned, lane, "coordinator-stopped"), "utf8"),
          "yes",
        );
      for (const lane of ["h", "k"])
        assert.equal(
          readFileSync(join(owned, lane, "daemon-stopped"), "utf8"),
          "yes",
        );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(owned, { recursive: true, force: true });
    }
  },
);
