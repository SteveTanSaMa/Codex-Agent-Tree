import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
const execute = promisify(execFile);
export const enabled = process.env.CAT_TEST_GAP_REAL === "1";
export const delay = (ms = 250) => new Promise<void>((r) => setTimeout(r, ms));
export async function eventually(
  check: () => boolean | Promise<boolean>,
  ms: number,
  label: string,
) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, label);
    await delay();
  }
}
export async function git(repo: string, ...args: string[]) {
  return (
    await execute("git", ["-C", repo, ...args], { timeout: 10000 })
  ).stdout.trim();
}
export async function makeRepo(path: string, files: Record<string, string>) {
  mkdirSync(path, { recursive: true });
  await git(path, "init");
  await git(path, "config", "user.name", "Qualification fixture");
  await git(path, "config", "user.email", "fixture@example.invalid");
  for (const [name, text] of Object.entries(files)) {
    const target = join(path, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, text);
  }
  await git(path, "add", ".");
  await git(path, "commit", "-m", "fixture");
}
export async function team(
  name: string,
  manifest: object,
  base: string,
  maximumTurns: number,
) {
  const skill = process.env.CAT_GAP_SKILL;
  const binary = process.env.CAT_GAP_EXECUTABLE;
  const config = process.env.CAT_GAP_PROVIDER_CONFIG;
  const envKey = process.env.CAT_GAP_PROVIDER_ENV;
  const service = process.env.CAT_GAP_KEYCHAIN_SERVICE;
  assert.ok(
    skill && binary && config && envKey,
    "Explicit installed Skill, binary and provider config/credential metadata are required",
  );
  assert.equal(
    JSON.parse(readFileSync(join(skill, "package.json"), "utf8")).version,
    "0.1.0-beta.2",
  );
  const hash = (path: string) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  const original = hash(config);
  const state = join(base, "s"),
    home = join(base, "h");
  const evidence = resolve(
    process.env.CAT_GAP_EVIDENCE ?? ".artifacts/beta2-gap-20261018/real",
    name,
  );
  reserveScenario(evidence, maximumTurns);
  const save = (file: string, value: unknown) =>
    writeFileSync(join(evidence, file), JSON.stringify(value, null, 2));
  const cli = async (command: string, ...args: string[]) => {
    const child = execute(
      process.execPath,
      [join(skill, "scripts/cat.mjs"), command, "--state", state, ...args],
      { timeout: 45000, maxBuffer: 8 * 1024 * 1024 },
    );
    child.child.stdin?.end();
    return JSON.parse((await child).stdout);
  };
  const manifestPath = join(base, "workspace.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await cli(
    "init",
    "--runtime-home",
    home,
    "--config-from",
    config,
    "--provider-env",
    envKey,
    "--executable",
    binary,
    "--workspace-config",
    manifestPath,
    ...(service ? ["--keychain-service", service] : []),
  );
  assert.ok((await cli("doctor")).ok);
  await cli("start");
  let root: any;
  let passed = false;
  return {
    base,
    state,
    home,
    cli,
    save,
    get root() {
      return root;
    },
    async start(task: string, depth: number, members: number, ms: number) {
      const taskFile = join(base, "task.txt");
      writeFileSync(taskFile, task);
      root = await cli(
        "root",
        "--task-file",
        taskFile,
        "--key",
        name,
        "--max-depth",
        String(depth),
        "--max-agents",
        String(members),
        "--concurrent",
        "3",
        "--max-turns",
        String(maximumTurns),
        "--max-total-turns",
        String(maximumTurns),
        "--task-time-budget-ms",
        String(ms),
      );
      save("identity.json", {
        base,
        state,
        home,
        root: root.id,
        maximumTurns,
        sourceConfigSha256: original,
        installedSkill: skill,
        binary,
      });
      return root;
    },
    async tree() {
      return (await cli("tree")) as any[];
    },
    async snapshots(label: string) {
      const tree = (await cli("tree")) as any[];
      save(label + "-tree.json", tree);
      if (root)
        save(
          label + "-events.json",
          await cli("events", "--target", root.id, "--after", "0"),
        );
      return tree;
    },
    markPassed() {
      passed = true;
    },
    async close() {
      const cleanup: Record<string, unknown> = { passed };
      try {
        if (root) {
          try {
            await cli(
              "control",
              "--target",
              root.id,
              "--action",
              "pause",
              "--immediate",
            );
          } catch (e) {
            cleanup.pauseError = String(e);
          }
        }
        const tree = (await cli("tree")) as any[];
        save("final-tree.json", tree);
        const histories = [];
        for (const a of tree)
          if (a.binding) {
            try {
              histories.push({
                agentId: a.id,
                history: await cli("native-history", "--target", a.id),
              });
            } catch (e) {
              histories.push({ agentId: a.id, error: String(e) });
            }
          }
        save("native-history.json", histories);
        if (root)
          save(
            "final-events.json",
            await cli("events", "--target", root.id, "--after", "0"),
          );
      } finally {
        try {
          await cli("stop");
          cleanup.coordinatorStopped = true;
        } catch (e) {
          cleanup.coordinatorStopError = String(e);
        }
        try {
          await execute(binary, ["app-server", "daemon", "stop"], {
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              CODEX_HOME: home,
            },
            timeout: 30000,
          });
          cleanup.daemonStopped = true;
        } catch (e) {
          cleanup.daemonStopError = String(e);
        }
        cleanup.sourceConfigUnchanged = hash(config) === original;
        save("cleanup.json", cleanup);
        assert.equal(cleanup.sourceConfigUnchanged, true);
        assert.equal(cleanup.daemonStopped, true);
      }
    },
  };
}
/** Persist before any process/RPC can consume a paid scenario slot. */
export function reserveScenario(evidence: string, maximumTurns: number) {
  mkdirSync(evidence, { recursive: true });
  assert.equal(
    existsSync(join(evidence, "identity.json")),
    false,
    "Scenario already ran; paid work is not automatically retried",
  );
  writeFileSync(
    join(evidence, "admission.json"),
    JSON.stringify({ maximumTurns, state: "reserved-before-launch" }),
    { flag: "wx", mode: 0o600 },
  );
}
export const newBase = () => mkdtempSync("/tmp/cat-gap-real-");
export const allConsumed = (tree: any[]) =>
  tree.every(
    (a) =>
      a.execution === "idle" &&
      a.messages.every((m: any) =>
        ["processed", "cancelled", "rejected"].includes(m.status),
      ),
  );
