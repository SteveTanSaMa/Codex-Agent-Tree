import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  unlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const { treeBytes } = await import(
  new URL("../../scripts/soak/fs-metrics.mjs", import.meta.url).href
);
test("soak size sampling tolerates disappearing temporary entries and does not follow links", () => {
  const root = mkdtempSync(join(tmpdir(), "cat-soak-metric-"));
  try {
    writeFileSync(join(root, "keep"), "abc");
    mkdirSync(join(root, "temp"));
    writeFileSync(join(root, "temp", "gone"), "12345");
    let deleted = false;
    const value = treeBytes(root, {
      lstat: lstatSync,
      readdir: (p: string) => {
        const entries = readdirSync(p);
        if (p === join(root, "temp") && !deleted) {
          unlinkSync(join(root, "temp", "gone"));
          deleted = true;
        }
        return entries;
      },
    });
    assert.equal(value, 3);
    assert.equal(deleted, true);
    assert.equal(treeBytes(join(root, "missing")), 0);
    if (process.platform !== "win32") {
      symlinkSync(root, join(root, "loop"));
      assert.equal(treeBytes(root), 3);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("soak metrics do not suppress permission or I/O failures", () => {
  assert.throws(
    () =>
      treeBytes("/fixture", {
        readdir: () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
        lstat: lstatSync,
      }),
    /denied/,
  );
  assert.throws(
    () =>
      treeBytes("/fixture", {
        readdir: () => ["entry"],
        lstat: () => {
          throw Object.assign(new Error("I/O"), { code: "EIO" });
        },
      }),
    /I\/O/,
  );
});
