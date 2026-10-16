import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  WorkspaceBroker,
  multiWorkspacePolicy,
  validateWorkspacePolicy,
  workspaceTools,
} from "../../src/workspace/broker.ts";
import type { Agent } from "../../src/storage/store.ts";
import { Store } from "../../src/storage/store.ts";
function fixture() {
  const dir = realpathSync(mkdtempSync("/tmp/cat-resource-")),
    repo = join(dir, "repo"),
    state = join(dir, "state"),
    resource = join(dir, "target");
  for (const path of [repo, state, resource]) mkdirSync(path);
  writeFileSync(join(repo, "value"), "source");
  writeFileSync(join(resource, "evidence.txt"), "evidence");
  writeFileSync(join(resource, "binary"), Buffer.from([0, 1, 255, 4]));
  const git = (args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git(["init"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["add", "."]);
  git(["commit", "-m", "fixture"]);
  const policy = multiWorkspacePolicy({
    defaultRepository: "repo",
    repositories: { repo: { path: repo } },
    readOnlyResources: { target: resource },
  });
  const root = { id: "root", depth: 0, parent_id: null } as Agent;
  const broker = new WorkspaceBroker(
    state,
    policy,
    () => root,
    () => ({
      repositoryId: "repo",
      repositoryIds: ["repo"],
      worktree: "original",
    }),
  );
  return {
    dir,
    repo,
    state,
    resource,
    policy,
    root,
    broker,
    close() {
      broker.cancel();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("registered resources provide bounded binary/text reads and directory browsing to read-only reviewers", async () => {
  const f = fixture();
  try {
    const reviewer = { ...f.root, depth: 2 };
    assert.ok(
      workspaceTools(2, [], true).some((t) => t.name === "read_resource"),
    );
    assert.ok(
      !workspaceTools(2, [], true).some((t) => t.name === "write_file"),
    );
    const listing = (await f.broker.call(reviewer, "list_resource", {
      resourceId: "target",
    })) as { entries: { name: string }[] };
    assert.equal(listing.entries.length, 2);
    const part = (await f.broker.call(reviewer, "read_resource", {
      resourceId: "target",
      path: "binary",
      offset: 1,
      length: 2,
      encoding: "base64",
    })) as { content: string; nextOffset: number; totalBytes: number };
    assert.equal(part.content, Buffer.from([1, 255]).toString("base64"));
    assert.equal(part.nextOffset, 3);
    assert.equal(part.totalBytes, 4);
    assert.equal(
      (
        (await f.broker.call(reviewer, "read_resource", {
          resourceId: "target",
          path: "evidence.txt",
        })) as { content: string }
      ).content,
      "evidence",
    );
    for (const path of ["../repo/value", "/etc/passwd", ".git/config"])
      await assert.rejects(() =>
        f.broker.call(reviewer, "read_resource", {
          resourceId: "target",
          path,
        }),
      );
    await assert.rejects(
      () =>
        f.broker.call(reviewer, "read_resource", {
          resourceId: "target",
          path: "binary",
        }),
      /base64/,
    );
    await assert.rejects(
      () =>
        f.broker.call(reviewer, "read_resource", {
          resourceId: "target",
          path: "binary",
          length: 65537,
        }),
      /bounded/,
    );
    await assert.rejects(
      () =>
        f.broker.call(reviewer, "read_resource", {
          resourceId: "unknown",
          path: ".",
        }),
      /not registered/,
    );
    symlinkSync(f.repo, join(f.resource, "link"));
    await assert.rejects(
      () =>
        f.broker.call(reviewer, "read_resource", {
          resourceId: "target",
          path: "link/value",
        }),
      /symlink/,
    );
  } finally {
    f.close();
  }
});
test("actual Lead terminal reads registered resources but cannot change them or access an unregistered peer", async () => {
  const f = fixture();
  try {
    const peer = join(f.dir, "private.txt");
    writeFileSync(peer, "private");
    const code = `const fs=require("node:fs");console.log(fs.readFileSync(${JSON.stringify(join(f.resource, "evidence.txt"))},"utf8"));for(const p of [${JSON.stringify(join(f.resource, "evidence.txt"))},${JSON.stringify(peer)}]){try{fs.writeFileSync(p,"bad");process.exit(41)}catch{}}try{fs.readFileSync(${JSON.stringify(peer)});process.exit(42)}catch{}fs.writeFileSync("result","ok")`;
    const result = (await f.broker.call(f.root, "terminal", {
      command: `'${process.execPath}' -e '${code}'`,
    })) as { exitCode: number; output: string };
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /evidence/);
    assert.equal(
      readFileSync(join(f.resource, "evidence.txt"), "utf8"),
      "evidence",
    );
    assert.equal(readFileSync(join(f.repo, "result"), "utf8"), "ok");
  } finally {
    f.close();
  }
});
test("resource registry is immutable and rejects write-root overlap and changed resource symlinks", async () => {
  const f = fixture();
  const store = new Store(join(f.state, "business.sqlite"));
  try {
    store.configureWorkspace(f.policy);
    assert.throws(
      () => store.configureWorkspace({ ...f.policy, readOnlyResources: {} }),
      /immutable/,
    );
    assert.throws(
      () =>
        validateWorkspacePolicy({
          ...f.policy,
          readOnlyResources: { bad: f.repo },
        }),
      /outside/,
    );
    rmSync(f.resource, { recursive: true });
    symlinkSync(f.repo, f.resource);
    await assert.rejects(
      () =>
        f.broker.call(f.root, "read_resource", {
          resourceId: "target",
          path: "value",
        }),
      /identity/,
    );
    assert.throws(
      () => f.broker.validateCommand(f.root, "terminal", { command: "true" }),
      /canonical/,
    );
  } finally {
    store.close();
    f.close();
  }
});
