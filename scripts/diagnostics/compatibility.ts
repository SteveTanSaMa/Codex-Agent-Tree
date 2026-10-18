/** No model calls, login reads or changes to existing runtime homes. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { runtimeEnvironment } from "../../src/runtime/codex/adapter.ts";

const executable = process.argv[2];
if (!executable)
  throw new Error(
    "Usage: node scripts/diagnostics/compatibility.ts /absolute/path/to/codex",
  );
if (!executable.startsWith("/"))
  throw new Error("Select an absolute executable path");
const base = mkdtempSync(join(tmpdir(), "cat-compat-")),
  home = join(base, "h");
mkdirSync(home);
const db = new DatabaseSync(":memory:");
const run = (file: string, args: string[]) =>
  execFileSync(file, args, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    env: runtimeEnvironment(home),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const files = (path: string): string[] =>
  readdirSync(path, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)],
  );
try {
  const version = run(executable, ["--version"]);
  const schema = join(base, "schema");
  run(executable, [
    "app-server",
    "generate-json-schema",
    "--experimental",
    "--out",
    schema,
  ]);
  const entries = files(schema)
    .sort()
    .map((path) => ({
      path: relative(schema, path),
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    }));
  const joined = entries.map((e) => `${e.path}:${e.sha256}`).join("\n");
  const all = entries
    .map((e) => readFileSync(join(schema, e.path), "utf8"))
    .join("\n");
  const methods = [
    "thread/start",
    "thread/resume",
    "thread/read",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
    "item/tool/call",
  ];
  console.log(
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        projectVersion: JSON.parse(
          readFileSync(resolve("package.json"), "utf8"),
        ).version,
        platform: process.platform,
        arch: process.arch,
        osBuild:
          process.platform === "darwin" ? run("/usr/bin/sw_vers", []) : null,
        node: process.version,
        sqlite: db.prepare("SELECT sqlite_version() AS version").get()!.version,
        git: run("git", ["--version"]),
        executable,
        cliVersion: version,
        sandbox:
          process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")
            ? "seatbelt-present-not-qualified-by-this-probe"
            : "unsupported",
        schemaFingerprint: createHash("sha256").update(joined).digest("hex"),
        schemaFiles: entries,
        advertisedMethods: Object.fromEntries(
          methods.map((m) => [m, all.includes(JSON.stringify(m))]),
        ),
        qualification:
          "schema-and-environment-only; not behavior, provider, sandbox or platform qualification",
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
  rmSync(base, { recursive: true, force: true });
}
