/** Exercise the actual operator-selected legacy reader against disposable new state. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { Store } from "../../src/storage/store.ts";
import { rootSettings } from "../../src/storage/interaction.ts";

const legacy = process.argv[2];
if (!legacy)
  throw new Error(
    "Usage: node scripts/diagnostics/rollback-guard.ts /path/to/installed/beta2/skill",
  );
const root = resolve(legacy),
  source = join(root, "src/storage/store.ts");
assert.equal(
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
  "0.1.0-beta.2",
);
const old = (await import(pathToFileURL(source).href)) as {
  Store: typeof Store;
};
const dir = mkdtempSync("/tmp/cat-rollback-"),
  path = join(dir, "business.sqlite");
let store = new Store(path);
try {
  const agent = store.createRoot("Lead", "fixture", rootSettings({}).limits);
  store.operatorSend(agent.id, "pending", "retain pending input");
  const before = {
    agent: store.agent(agent.id),
    messages: store.messages(agent.id),
    cursor: store.eventCursor(),
  };
  store.close();
  assert.throws(
    () => new old.Store(path),
    /Unsupported business schema version/,
  );
  store = new Store(path);
  assert.deepEqual(
    {
      agent: store.agent(agent.id),
      messages: store.messages(agent.id),
      cursor: store.eventCursor(),
    },
    before,
  );
  assert.equal(
    store.db.prepare("SELECT version FROM schema_version").get()!.version,
    13,
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        legacyVersion: "0.1.0-beta.2",
        legacyStoreSha256: createHash("sha256")
          .update(readFileSync(source))
          .digest("hex"),
        schema: 13,
        outcome:
          "legacy reader refused; logical state retained; no native work",
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
