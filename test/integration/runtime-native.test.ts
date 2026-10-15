import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CodexRuntime,
  runtimeEnvironment,
  record,
} from "../../src/runtime/codex/adapter.ts";
const execute = promisify(execFile);

test(
  "actual official daemon + modified transport: independent Threads and reconnect ownership",
  { skip: process.env.CAT_TEST_NATIVE !== "1", timeout: 120000 },
  async () => {
    const home = mkdtempSync("/tmp/cat-native-adapter-");
    chmodSync(home, 0o700);
    const workspace = join(home, "workspace");
    mkdirSync(workspace);
    const auth = join(home, "auth.json");
    copyFileSync(
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
      auth,
    );
    chmodSync(auth, 0o600);
    writeFileSync(
      join(home, "config.toml"),
      "[features]\nmulti_agent=false\nshell_tool=false\nunified_exec=false\n",
    );
    const runtime = new CodexRuntime({
      home,
      expectedVersion: "codex-cli 0.162.0-alpha.17.2",
    });
    try {
      await runtime.connect();
      const tools = [
        {
          type: "function" as const,
          name: "agent_fixture",
          description: "No-op fixture",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ];
      const first = await runtime.createThread(
        workspace,
        tools,
        "Read-only connection fixture; never start work.",
      );
      const second = await runtime.createThread(
        workspace,
        tools,
        "Independent session fixture; never start work.",
      );
      assert.notEqual(first, second);
      assert.equal(
        record((await runtime.readThread(first, false)).thread).id,
        first,
      );
      runtime.disconnect();
      const status = JSON.parse(
        (
          await execute("codex", ["app-server", "daemon", "version"], {
            env: runtimeEnvironment(home),
            timeout: 20000,
          })
        ).stdout,
      ) as { status: string };
      assert.equal(status.status, "running");
      await runtime.connect();
      // Empty Threads have no persisted rollout; do not claim cold resume from this fixture.
      const fresh = await runtime.createThread(
        workspace,
        tools,
        "Reconnect fixture",
      );
      assert.notEqual(fresh, first);
    } finally {
      runtime.disconnect();
      try {
        await execute("codex", ["app-server", "daemon", "stop"], {
          env: runtimeEnvironment(home),
          timeout: 30000,
        });
      } finally {
        unlinkSync(auth);
      }
    }
  },
);

test(
  "actual daemon restart before first Turn: stable identity and unsent reservation recover, reusing context when supported",
  { skip: process.env.CAT_TEST_NATIVE !== "1", timeout: 120000 },
  async () => {
    const { Store } = await import("../../src/storage/store.ts");
    const { Coordinator } =
      await import("../../src/coordinator/coordinator.ts");
    const home = mkdtempSync("/tmp/cat-empty-native-");
    const workspace = join(home, "workspace");
    mkdirSync(workspace);
    const auth = join(home, "auth.json");
    copyFileSync(
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
      auth,
    );
    chmodSync(auth, 0o600);
    writeFileSync(
      join(home, "config.toml"),
      "[features]\nmulti_agent=false\nshell_tool=false\nunified_exec=false\n",
    );
    const options = {
      stateDirectory: join(home, "team"),
      runtimeHome: home,
      expectedVersion: "codex-cli 0.162.0-alpha.17.2",
    };
    const first = new CodexRuntime({
      home,
      expectedVersion: options.expectedVersion,
    });
    let coordinator: InstanceType<typeof Coordinator> | undefined;
    try {
      await first.connect();
      const thread = await first.createThread(
        workspace,
        [],
        "Never start any Turn in this fixture.",
      );
      const store = new Store(join(options.stateDirectory, "business.sqlite"));
      let rootId: string;
      let attemptId: string;
      try {
        const root = store.createRoot("A", "unsent initial work", {
          tokens: 1000,
          maxDepth: 1,
          maxAgents: 2,
          maxConcurrentTurns: 2,
          maxTurnsPerAgent: 4,
          turnReservation: 100,
        });
        rootId = root.id;
        store.bind(root.id, thread, "default");
        attemptId = store.prepare(root.id, "not issued").id;
        store.control(null, root.id, "pause", "agent");
      } finally {
        store.close();
      }
      first.disconnect();
      await execute("codex", ["app-server", "daemon", "restart"], {
        env: runtimeEnvironment(home),
        timeout: 60000,
      });
      coordinator = new Coordinator(options);
      await coordinator.start();
      assert.equal(coordinator.store.agent(rootId).desired, "paused");
      assert.equal(coordinator.store.attempt(attemptId).state, "prepared");
      assert.equal(coordinator.store.agent(rootId).reserved, 100);
      const recovered = coordinator.store.binding(rootId);
      if (recovered) {
        assert.equal(recovered.thread_id, thread);
        assert.equal(recovered.generation, 1);
        assert.equal(coordinator.store.attempt(attemptId).thread_id, thread);
      } else {
        const replacement = await coordinator.runtime.createThread(
          workspace,
          [],
          "Replacement context only, no Turn.",
        );
        const binding = coordinator.store.bind(rootId, replacement, "default");
        assert.equal(binding.generation, 2);
        assert.notEqual(binding.thread_id, thread);
        assert.equal(
          coordinator.store.attempt(attemptId).thread_id,
          replacement,
        );
        assert.equal(
          coordinator.store.attempt(attemptId).binding_generation,
          2,
        );
      }
    } finally {
      first.disconnect();
      await coordinator?.stop();
      try {
        await execute("codex", ["app-server", "daemon", "stop"], {
          env: runtimeEnvironment(home),
          timeout: 30000,
        });
      } finally {
        unlinkSync(auth);
      }
    }
  },
);
