import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  runtimeEnvironment,
  validateCredential,
} from "../../src/runtime/codex/adapter.ts";
test("explicit provider credential is forwarded alone; invalid and absent credentials fail closed", () => {
  const previous = process.env.CAT_TEST_API_KEY,
    other = process.env.CAT_OTHER_SECRET;
  process.env.CAT_TEST_API_KEY = "fixture-key";
  process.env.CAT_OTHER_SECRET = "unrelated";
  try {
    assert.equal(runtimeEnvironment("/tmp/test").CAT_TEST_API_KEY, undefined);
    const env = runtimeEnvironment("/tmp/test", { envKey: "CAT_TEST_API_KEY" });
    assert.equal(env.CAT_TEST_API_KEY, "fixture-key");
    assert.equal(env.CAT_OTHER_SECRET, undefined);
    assert.equal(env.CODEX_HOME, "/tmp/test");
    for (const key of [
      "HOME",
      "PATH",
      "CODEX_HOME",
      "DYLD_INSERT_LIBRARIES",
      "invalid-key",
    ])
      assert.throws(() => validateCredential({ envKey: key }));
    delete process.env.CAT_TEST_API_KEY;
    assert.throws(
      () => runtimeEnvironment("/tmp/test", { envKey: "CAT_TEST_API_KEY" }),
      /Missing provider credential variable/,
    );
  } finally {
    if (previous === undefined) delete process.env.CAT_TEST_API_KEY;
    else process.env.CAT_TEST_API_KEY = previous;
    if (other === undefined) delete process.env.CAT_OTHER_SECRET;
    else process.env.CAT_OTHER_SECRET = other;
  }
});
test("provider init copies selected config without App auth or secret persistence; conflicting config is preserved", () => {
  const dir = mkdtempSync("/tmp/cat-provider-init-");
  try {
    const source = join(dir, "provider.toml"),
      home = join(dir, "runtime"),
      state = join(dir, "state");
    const content =
      'model="fixture"\nmodel_provider="custom"\n[model_providers.custom]\nname="custom"\nbase_url="https://example.invalid/v1"\nwire_api="responses"\nenv_key="CAT_TEST_API_KEY"\n';
    writeFileSync(source, content);
    const result = spawnSync(
      process.execPath,
      [
        "src/cli/main.ts",
        "init",
        "--state",
        state,
        "--runtime-home",
        home,
        "--config-from",
        source,
        "--provider-env",
        "CAT_TEST_API_KEY",
        "--executable",
        "/fixture/codex",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CAT_TEST_API_KEY: "do-not-persist" },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(home, "config.toml"), "utf8"), content);
    assert.equal(existsSync(join(home, "auth.json")), false);
    const saved = readFileSync(join(state, "config.json"), "utf8");
    assert.ok(!saved.includes("do-not-persist"));
    assert.deepEqual(JSON.parse(saved).credential, {
      envKey: "CAT_TEST_API_KEY",
    });
    assert.equal(JSON.parse(saved).executable, "/fixture/codex");
    assert.equal(statSync(join(home, "config.toml")).mode & 0o777, 0o600);
    writeFileSync(source, content + "# changed\n");
    const conflict = spawnSync(
      process.execPath,
      [
        "src/cli/main.ts",
        "init",
        "--state",
        join(dir, "other"),
        "--runtime-home",
        home,
        "--config-from",
        source,
        "--provider-env",
        "CAT_TEST_API_KEY",
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /different contents/);
    assert.equal(readFileSync(join(home, "config.toml"), "utf8"), content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
