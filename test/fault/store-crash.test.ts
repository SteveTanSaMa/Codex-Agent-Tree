import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../../src/storage/store.ts";

test(
  "SIGKILL of a confirmed live writer preserves binding and uncertain execution without replay",
  { timeout: 15000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "cat-crash-test-"));
    const path = join(dir, "state.sqlite");
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../fixtures/store-owner.ts", import.meta.url)),
        path,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let store: Store | undefined;
    try {
      const lines = createInterface({ input: child.stdout });
      const [line] = await once(lines, "line", {
        signal: AbortSignal.timeout(8000),
      });
      lines.close();
      const state = JSON.parse(String(line)) as {
        pid: number;
        root: string;
        attempt: string;
        binding: { generation: number };
      };
      assert.equal(child.pid, state.pid);
      assert.equal(child.exitCode, null);
      process.kill(state.pid, 0);
      assert.throws(() => new Store(path), /owns this database/);
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      const [code, signal] = await exit;
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
      store = new Store(path);
      assert.equal(store.agent(state.root).id, state.root);
      assert.equal(
        store.binding(state.root)?.thread_id,
        "persisted-native-thread",
      );
      assert.equal(store.attempt(state.attempt).state, "starting");
      assert.equal(store.agent(state.root).reserved, 100);
      assert.equal(store.attempts(state.root).length, 1);
      store.uncertain(
        state.attempt,
        "Coordinator died after dispatch intent; query native history before continuation",
      );
      assert.throws(() => store!.prepare(state.root, "blind replay"));
      assert.equal(store.attempt(state.attempt).state, "unknown");
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
