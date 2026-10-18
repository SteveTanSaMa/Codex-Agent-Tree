import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
const execute = promisify(execFile);
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf("--" + n);
  return i < 0 ? undefined : args[i + 1];
};
const run = resolve(flag("run-dir")),
  base = resolve(flag("base")),
  skill = resolve(flag("skill")),
  executable = resolve(flag("executable"));
const smoke = args.includes("--smoke"),
  duration = Number(flag("duration-seconds")) * 1000;
assert.ok(
  smoke
    ? duration >= 180000 && duration <= 600000
    : duration >= 8 * 3600000 && duration <= 10 * 3600000,
);
assert.ok(
  base.startsWith("/tmp/cat-soak-") && !existsSync(base),
  "fresh short test directory required",
);
mkdirSync(base, { mode: 0o700 });
const wrapper = join(skill, "scripts/cat.mjs");
const { runtimeEnvironment } = await import(
  pathToFileURL(join(skill, "src/runtime/codex/adapter.ts")).href
);
const ms = (n) => (smoke ? n / 30 : n);
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const started = Date.now(),
  deadline = started + duration;
let abort = false,
  failure,
  sequence = 0,
  requests = 0,
  receivedBytes = 0;
const jobs = new Map(),
  holds = new Map(),
  identities = {},
  latencies = [],
  pids = {};
const paths = {
  coding: { state: join(base, "s"), home: join(base, "h") },
  calibration: { state: join(base, "c"), home: join(base, "k") },
};
const key = `CAT_SOAK_${randomUUID().replaceAll("-", "").toUpperCase()}_KEY`;
process.env[key] = "loopback-fixture-only";
const credential = { envKey: key };
const now = () => new Date().toISOString();
const record = (kind, data = {}) =>
  appendFileSync(
    join(run, "events.jsonl"),
    JSON.stringify({
      at: now(),
      elapsedMs: Date.now() - started,
      kind,
      ...data,
    }) + "\n",
  );
const json = (name, v) => {
  const p = join(run, name);
  writeFileSync(p + ".tmp", JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
  renameSync(p + ".tmp", p);
};
function fail(e) {
  if (!failure) {
    failure = String(e?.stack ?? e);
    record("failure", { error: failure });
  }
  abort = true;
}
const active = () => !abort && Date.now() < deadline;
async function until(check, label, timeout = 30000) {
  const end = Math.min(Date.now() + timeout, deadline + 10000);
  while (!(await check())) {
    if (abort) throw new Error("Aborted: " + label);
    assert.ok(Date.now() < end, label);
    await sleep(100);
  }
}
async function waitTo(time) {
  while (active() && Date.now() < time)
    await sleep(Math.min(1000, time - Date.now()));
}
function dbRead(lane, fn) {
  const db = new DatabaseSync(join(paths[lane].state, "business.sqlite"), {
    readOnly: true,
  });
  try {
    db.exec("PRAGMA busy_timeout=2000");
    return fn(db);
  } finally {
    db.close();
  }
}
const rows = (lane, sql, ...params) =>
  dbRead(lane, (db) => db.prepare(sql).all(...params));
const agents = (lane) =>
  rows(lane, "SELECT * FROM agents ORDER BY depth,created_at");
const attempts = (lane) =>
  rows(
    lane,
    "SELECT id,agent_id,thread_id,turn_id,state FROM turn_attempts ORDER BY created_at,rowid",
  );
const binding = (lane) =>
  rows(
    lane,
    "SELECT agent_id,thread_id,generation,status FROM agent_session_bindings ORDER BY agent_id,generation",
  );
const warnings = () =>
  rows(
    "calibration",
    "SELECT sequence,created_at,body FROM events WHERE kind='interaction.warning' ORDER BY sequence",
  ).map((r) => ({ ...r, ...JSON.parse(r.body) }));
async function call(lane, ...args) {
  const { stdout } = await execute(
    process.execPath,
    [wrapper, ...args, "--state", paths[lane].state],
    { timeout: 45000, maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}
async function idle(lane, timeout = 30000) {
  await until(
    () =>
      !rows(
        lane,
        "SELECT id FROM turn_attempts WHERE state IN ('prepared','starting','running','unknown')",
      ).length &&
      !rows(
        lane,
        "SELECT id FROM messages WHERE status='queued' UNION ALL SELECT id FROM operator_messages WHERE status='queued'",
      ).length,
    "lane did not become idle: " + lane,
    timeout,
  );
}
function emit(res, type, value) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
}
function reply(res, item, id) {
  if (res.destroyed || res.writableEnded) return;
  if (!res.headersSent) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    emit(res, "response.created", {
      response: { id, status: "in_progress", output: [] },
    });
  }
  emit(res, "response.output_item.added", { output_index: 0, item });
  emit(res, "response.output_item.done", { output_index: 0, item });
  emit(res, "response.completed", {
    response: {
      id,
      status: "completed",
      output: [item],
      usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
    },
  });
  res.end();
}
const finalItem = (text) => ({
  type: "message",
  id: "msg_" + randomUUID().replaceAll("-", ""),
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
});
function latestUser(body) {
  const users = (Array.isArray(body.input) ? body.input : []).filter(
    (x) => x.role === "user",
  );
  assert.ok(users.length, "provider request missing user input");
  return users
    .map((x) =>
      Array.isArray(x.content)
        ? x.content.map((c) => c.text ?? "").join("\n")
        : String(x.content),
    )
    .at(-1);
}
function inputIds(text) {
  const ids = [];
  const m = text.match(/Incoming messages: (\[.*?\])\. Handle/s);
  if (m) ids.push(...JSON.parse(m[1]).map((x) => x.id));
  for (const m of text.matchAll(
    /Acknowledge this guidance using agent_ack with ID ([a-f0-9-]+)/g,
  ))
    ids.push(m[1]);
  return [...new Set(ids)];
}
const quote = (x) => "'" + x.replaceAll("'", "'\\''") + "'";
const hash = (x) => createHash("sha256").update(x).digest("hex");
const expected = { coderA: "0\n", coderB: "0\n" };
function plan(role, n, mode, user, jobKey) {
  const steps = [],
    ids = inputIds(user),
    ack = () => {
      if (ids.length) steps.push(["agent_ack", { messageIds: ids }]);
    };
  if (mode === "bootstrap") {
    if (role === "lead")
      for (const child of ["coderA", "coderB"])
        steps.push([
          "agent_spawn",
          {
            requestKey: "bootstrap-" + child,
            name: child,
            role: "coder",
            task: `CATSOAK_${child}_0_bootstrap`,
          },
        ]);
    if (role === "coderA")
      steps.push([
        "agent_spawn",
        {
          requestKey: "bootstrap-reviewer",
          name: "reviewer",
          role: "review",
          task: "CATSOAK_reviewer_0_bootstrap",
        },
      ]);
  } else if (role === "calibrator") {
    ack();
    if (mode === "progress")
      for (let i = 0; i < 16; i++)
        steps.push([
          "agent_task_create",
          {
            requestKey: jobKey + "-" + i,
            subject: jobKey + "-" + i,
            description: "Synthetic observable progress",
          },
          ms(60000),
        ]);
    else if (mode === "quiet" || mode === "recovery" || mode === "pause")
      steps.push([
        "HOLD",
        { duration: mode === "quiet" ? ms(16 * 60000) : ms(5 * 60000) },
      ]);
  } else if (role === "lead") {
    ack();
    const updates = [];
    for (const report of user.matchAll(/source=(coderA|coderB) value=(\d+)/g))
      updates.push([
        report[1] === "coderA" ? "a.txt" : "b.txt",
        String(Number(report[2])) + "\n",
      ]);
    const code = `const fs=require('node:fs');for(const [p,v] of ${JSON.stringify(updates)})fs.writeFileSync(p,v);require('./verify.cjs');`;
    steps.push([
      "terminal",
      { command: quote(process.execPath) + " -e " + quote(code) },
    ]);
    steps.push([
      "agent_task_create",
      {
        requestKey: jobKey + "-task",
        subject: jobKey,
        description: "Integrate synthetic reports and verify",
      },
    ]);
    for (const action of ["claim", "complete"])
      steps.push([
        "agent_task_update",
        () => {
          const task = rows(
            "coding",
            "SELECT id,revision FROM tasks WHERE subject=?",
            jobKey,
          )[0];
          assert.ok(task, "task creation did not commit");
          return {
            requestKey: jobKey + "-" + action,
            taskId: task.id,
            expectedRevision: task.revision,
            action,
            ...(action === "complete"
              ? { result: "Fixture terminal verified" }
              : {}),
          };
        },
      ]);
  } else {
    ack();
    const file = role === "coderB" ? "b.txt" : "a.txt";
    steps.push(["read_file", { path: file }]);
    if (role !== "reviewer") {
      const content = n + "\n";
      steps.push([
        "write_file",
        { path: file, expectedHash: hash(expected[role]), content },
      ]);
      expected[role] = content;
      steps.push(["run_test", { name: "unit" }]);
    }
    const reportNumber = n * 10 + { coderA: 1, coderB: 2, reviewer: 3 }[role];
    steps.push([
      "agent_send",
      {
        requestKey: jobKey + "-report",
        target: identities.lead,
        message: `CATSOAK_lead_${reportNumber}_normal source=${role} value=${n}`,
      },
    ]);
  }
  return steps;
}
const server = createServer((req, res) => {
  let body = "",
    bytes = 0;
  req.on("data", (b) => {
    bytes += b.length;
    if (bytes > 16 * 1024 * 1024) {
      res.destroy();
      fail(new Error("Provider body exceeded 16 MiB"));
    } else body += b;
  });
  req.on("end", () => {
    try {
      assert.equal(
        req.url,
        "/v1/responses",
        "unexpected provider endpoint; compaction is outside this soak",
      );
      requests++;
      receivedBytes += bytes;
      assert.ok(requests <= 60000, "request ceiling exceeded");
      const value = JSON.parse(body),
        user = latestUser(value);
      const markers = [
        ...user.matchAll(
          /CATSOAK_(lead|coderA|coderB|reviewer|calibrator)_(\d+)_(bootstrap|normal|quiet|progress|guidance|recovery|pause|replacement)/g,
        ),
      ];
      assert.ok(markers.length, "no fixture job marker in latest user message");
      const [, role, num, mode] = markers.at(-1),
        jobKey = role + "-" + num + "-" + mode;
      let job = jobs.get(jobKey);
      if (!job) {
        job = { steps: plan(role, Number(num), mode, user, jobKey), index: 0 };
        jobs.set(jobKey, job);
      }
      const step = job.steps[job.index++],
        id = "resp_" + randomUUID().replaceAll("-", "");
      if (!step) {
        reply(res, finalItem("SOAK_DONE " + jobKey), id);
        return;
      }
      const [tool, raw, delay] = step;
      if (tool === "HOLD") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        emit(res, "response.created", {
          response: { id, status: "in_progress", output: [] },
        });
        const release = () =>
          reply(res, finalItem("SOAK_HELD_DONE " + jobKey), id);
        const heart = setInterval(() => {
          if (!res.destroyed)
            emit(res, "response.in_progress", {
              response: { id, status: "in_progress", output: [] },
            });
        }, 5000);
        const timer = setTimeout(release, raw.duration);
        holds.set(jobKey, { release, role });
        res.on("close", () => {
          clearInterval(heart);
          clearTimeout(timer);
          holds.delete(jobKey);
        });
        record("hold.started", { jobKey, durationMs: raw.duration });
        return;
      }
      const names = (value.tools ?? []).flatMap((t) =>
        t.type === "function" ? [t.name] : (t.tools?.map((x) => x.name) ?? []),
      );
      const name =
        names.find(
          (x) =>
            x === tool || x.endsWith("__" + tool) || x.endsWith("." + tool),
        ) ?? tool;
      assert.ok(
        names.includes(name),
        "tool absent from authorized catalog: " + tool,
      );
      if (role === "reviewer")
        assert.ok(
          !names.some(
            (x) => x === "write_file" || x === "terminal" || x === "run_test",
          ),
          "read-only catalog widened",
        );
      const finish = () => {
        try {
          reply(
            res,
            {
              type: "function_call",
              id: "fc_" + randomUUID().replaceAll("-", ""),
              call_id: "soak_" + jobKey + "_" + job.index,
              name,
              arguments: JSON.stringify(
                typeof raw === "function" ? raw() : raw,
              ),
            },
            id,
          );
        } catch (e) {
          fail(e);
          res.destroy();
        }
      };
      if (delay) {
        const timer = setTimeout(finish, delay);
        res.on("close", () => clearTimeout(timer));
      } else setTimeout(finish, smoke ? 10 : 100);
    } catch (e) {
      fail(e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
async function initialize(lane, workspace) {
  const p = paths[lane];
  mkdirSync(p.home, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(p.home, "config.toml"),
    `model="fixture"\nmodel_provider="local"\nmodel_context_window=100000000\nmodel_auto_compact_token_limit=90000000\n[model_providers.local]\nname="local"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nenv_key="${key}"\nsupports_websockets=false\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n[features]\nmulti_agent=false\nshell_tool=false\nunified_exec=false\n`,
  );
  const testsFile = join(base, "test-commands.json");
  if (workspace)
    writeFileSync(
      testsFile,
      JSON.stringify({
        unit: { executable: process.execPath, args: ["verify.cjs"] },
      }),
    );
  await call(
    lane,
    "init",
    "--runtime-home",
    p.home,
    "--executable",
    executable,
    "--config-from",
    join(p.home, "config.toml"),
    "--provider-env",
    key,
    ...(workspace
      ? ["--workspace", workspace, "--test-commands", testsFile]
      : []),
  );
  pids[lane] = (await call(lane, "start")).pid;
  const role = workspace ? "lead" : "calibrator";
  const root = await call(
    lane,
    "root",
    "--key",
    "root",
    "--task",
    `CATSOAK_${role}_0_bootstrap`,
    "--name",
    role,
    "--max-turns",
    "unlimited",
    "--max-total-turns",
    "unlimited",
  );
  identities[role] = root.id;
  if (smoke) {
    const policy = {
      mode: "interactive",
      autonomyWarnMs: ms(900000),
      stallWarnMs: ms(600000),
    };
    const f = join(base, lane + "-policy.json");
    writeFileSync(f, JSON.stringify(policy));
    await call(lane, "interaction", "--target", root.id, "--input-file", f);
  }
  record("lane.started", { lane, pid: pids[lane], root: root.id });
}
function assertState(lane, final = false) {
  const a = attempts(lane),
    ids = a.filter((x) => x.turn_id).map((x) => x.thread_id + ":" + x.turn_id);
  assert.equal(
    new Set(ids).size,
    ids.length,
    "one Native Turn claimed by multiple Attempts",
  );
  assert.equal(
    a.filter((x) => x.state === "unknown").length,
    0,
    "unknown execution requires investigation",
  );
  const rejected = rows(
    lane,
    "SELECT sequence FROM events WHERE kind='tool.rejected'",
  );
  assert.equal(rejected.length, 0, "unexpected tool rejection");
  for (const command of rows(
    lane,
    "SELECT state,result_json FROM workspace_commands",
  )) {
    assert.notEqual(command.state, "accepted", "unsettled workspace command");
    const result = command.result_json ? JSON.parse(command.result_json) : null;
    if (result?.exitCode !== undefined)
      assert.equal(result.exitCode, 0, "workspace command failed");
  }
  const pending = rows(
    lane,
    "SELECT agent_id,COUNT(*) AS n FROM turn_attempts WHERE state IN ('prepared','starting','running','unknown') GROUP BY agent_id HAVING n>1",
  );
  assert.equal(pending.length, 0, "overlapping local Attempts");
  assert.equal(
    rows(lane, "SELECT * FROM runtime_blocks").length,
    0,
    "unowned native execution",
  );
  assert.equal(
    rows(lane, "SELECT * FROM operator_guidance WHERE state='unknown'").length,
    0,
    "unknown guidance",
  );
  assert.equal(
    rows(lane, "SELECT * FROM pragma_foreign_key_check").length,
    0,
    "foreign key inconsistency",
  );
  if (final)
    assert.equal(
      a.filter((x) =>
        ["prepared", "starting", "running", "unknown"].includes(x.state),
      ).length,
      0,
      "live work at shutdown",
    );
}
function treeSize(dir) {
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) bytes += treeSize(p);
    else if (entry.isFile()) bytes += lstatSync(p).size;
  }
  return bytes;
}
let lastSizeAt = 0,
  diskBytes = 0;
async function sample() {
  const processes = [];
  const table = (
    await execute("/bin/ps", ["-axo", "pid=,ppid="], { timeout: 3000 })
  ).stdout
    .trim()
    .split("\n")
    .map((x) => x.trim().split(/\s+/).map(Number));
  const owned = new Set([process.pid, ...Object.values(pids).filter(Boolean)]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, ppid] of table)
      if (owned.has(ppid) && !owned.has(pid)) {
        owned.add(pid);
        changed = true;
      }
  }

  for (const lane of Object.keys(paths)) {
    if (!existsSync(join(paths[lane].state, "business.sqlite"))) continue;
    const native = rows(
      lane,
      "SELECT native_pid FROM runtime_connections ORDER BY generation DESC LIMIT 1",
    )[0]?.native_pid;
    if (native) owned.add(native);
    for (const [kind, pid] of [
      ["coordinator", pids[lane]],
      ["native", native],
    ])
      if (pid) {
        try {
          const s = (
            await execute(
              "/bin/ps",
              ["-o", "pid=,ppid=,rss=", "-p", String(pid)],
              { timeout: 3000 },
            )
          ).stdout
            .trim()
            .split(/\s+/)
            .map(Number);
          if (!s.length || !s[0]) continue;
          const f = (
            await execute("/usr/sbin/lsof", ["-a", "-p", String(pid), "-Ff"], {
              timeout: 5000,
              maxBuffer: 2 * 1024 * 1024,
            }).catch(() => ({ stdout: "" }))
          ).stdout;
          const rss = s[2] * 1024;
          assert.ok(
            rss < 2 * 1024 ** 3,
            "process RSS resource ceiling exceeded",
          );
          processes.push({
            lane,
            kind,
            pid,
            rss,
            fdCount: f.split("\n").filter((x) => /^f\d/.test(x)).length,
          });
        } catch (e) {
          if (!abort) throw e;
        }
      }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, ppid] of table)
      if (owned.has(ppid) && !owned.has(pid)) {
        owned.add(pid);
        changed = true;
      }
  }
  const queues = Object.fromEntries(
    Object.keys(paths).map((lane) => {
      const attemptStates = rows(
        lane,
        "SELECT state,COUNT(*) AS n FROM turn_attempts GROUP BY state",
      );
      const inFlight = attemptStates
        .filter((r) =>
          ["prepared", "starting", "running", "unknown"].includes(r.state),
        )
        .reduce((n, r) => n + Number(r.n), 0);
      assert.ok(
        inFlight <= (lane === "coding" ? 3 : 1),
        "native admission concurrency exceeded",
      );
      if (lane !== "calibration" || pids.calibration)
        assert.equal(
          attemptStates.find((r) => r.state === "unknown")?.n ?? 0,
          0,
          "unknown execution during sample",
        );
      const messages = rows(
        lane,
        "SELECT status,COUNT(*) AS n FROM (SELECT status FROM messages UNION ALL SELECT status FROM operator_messages) GROUP BY status",
      );
      return [lane, { attemptStates, messages, inFlight }];
    }),
  );
  if (Date.now() - lastSizeAt > 120000) {
    diskBytes = treeSize(base);
    lastSizeAt = Date.now();
    assert.ok(diskBytes < 4 * 1024 ** 3, "test directory exceeded 4 GiB");
  }
  appendFileSync(
    join(run, "metrics.jsonl"),
    JSON.stringify({
      at: now(),
      elapsedMs: Date.now() - started,
      requests,
      receivedBytes,
      diskBytes,
      harnessRss: process.memoryUsage().rss,
      ownedProcessCount: owned.size,
      queues,
      processes,
    }) + "\n",
  );
  json("status.json", {
    phase: abort ? "stopping" : "running",
    startedAt: new Date(started).toISOString(),
    deadline: new Date(deadline).toISOString(),
    sampledAt: now(),
    smoke,
    pids,
    paths,
    identities,
    requests,
    round: sequence,
    failure,
  });
}
async function codingLoop() {
  while (active()) {
    const begin = Date.now(),
      n = ++sequence;
    for (const role of ["coderA", "coderB", "reviewer"])
      await call(
        "coding",
        "send",
        "--target",
        identities[role],
        "--key",
        "round-" + n + "-" + role,
        "--delivery",
        "queue",
        "--message",
        `CATSOAK_${role}_${n}_normal`,
      );
    await idle("coding", 60000);
    assertState("coding");
    assert.equal(
      readFileSync(join(base, "repo/a.txt"), "utf8"),
      n + "\n",
      "Lead failed to integrate coderA",
    );
    assert.equal(
      readFileSync(join(base, "repo/b.txt"), "utf8"),
      n + "\n",
      "Lead failed to integrate coderB",
    );
    assert.equal(
      rows("coding", "SELECT id FROM tasks WHERE status!='completed'").length,
      0,
      "unfinished synthetic tasks",
    );
    if (n % 5 === 0) {
      const begin = performance.now();
      const view = await call("coding", "view", "--target", identities.lead);
      assert.equal(view.agents.length, 4);
      latencies.push(performance.now() - begin);
      record("operator.view", { elapsedMs: latencies.at(-1), round: n });
    }
    if (n % 10 === 0)
      record("coding.round", {
        round: n,
        attemptCount: attempts("coding").length,
      });
    await waitTo(begin + (smoke ? 5000 : 60000));
  }
}
async function calibrateHold(mode, n) {
  const key = "calibrator-" + n + "-" + mode;
  await call("calibration", "check-in", "--target", identities.calibrator);
  await call(
    "calibration",
    "send",
    "--target",
    identities.calibrator,
    "--key",
    key,
    "--delivery",
    "queue",
    "--message",
    `CATSOAK_calibrator_${n}_${mode}`,
  );
  await until(
    () => holds.has(key) && attempts("calibration").at(-1)?.state === "running",
    "native hold not established",
  );
  return key;
}
async function calibrationLoop() {
  let before = warnings().length;
  await calibrateHold("quiet", 1);
  await idle("calibration", ms(17 * 60000) + 30000);
  let got = warnings().slice(before);
  assert.equal(
    got.filter((x) => x.reason === "no-observable-progress").length,
    1,
  );
  assert.equal(got.filter((x) => x.reason === "autonomy-duration").length, 1);
  assert.equal(
    agents("calibration")[0].desired,
    "active",
    "default warnings must not pause",
  );
  const clocks = rows(
    "calibration",
    "SELECT body FROM events WHERE kind='interaction.epoch_started' ORDER BY sequence DESC LIMIT 1",
  )[0];
  const epoch = JSON.parse(clocks.body).epochMs;
  for (const [reason, threshold] of [
    ["no-observable-progress", ms(600000)],
    ["autonomy-duration", ms(900000)],
  ]) {
    const w = got.find((x) => x.reason === reason);
    const actual =
      Date.parse(w.created_at) -
      (reason === "no-observable-progress" ? w.sinceMs : epoch);
    assert.ok(
      actual >= threshold - 1000 && actual <= threshold + 5000,
      "warning timing outside guard tolerance",
    );
  }
  record("calibration.quiet.pass", { warnings: got });
  before = warnings().length;
  await call("calibration", "check-in", "--target", identities.calibrator);
  await call(
    "calibration",
    "send",
    "--target",
    identities.calibrator,
    "--key",
    "progress",
    "--delivery",
    "queue",
    "--message",
    "CATSOAK_calibrator_2_progress",
  );
  await idle("calibration", ms(18 * 60000) + 30000);
  got = warnings().slice(before);
  assert.equal(
    got.filter((x) => x.reason === "no-observable-progress").length,
    0,
    "observable task progress falsely flagged",
  );
  assert.equal(got.filter((x) => x.reason === "autonomy-duration").length, 1);
  record("calibration.progress.pass", { warnings: got });
  let hold = await calibrateHold("quiet", 3);
  const original = attempts("calibration").at(-1);
  await sleep(ms(90000));
  const guide = await call(
    "calibration",
    "steer",
    "--target",
    identities.calibrator,
    "--key",
    "live-guide",
    "--message",
    "CATSOAK_calibrator_4_guidance",
  );
  assert.equal(guide.guidance.state, "delivered");
  const replayed = await call(
    "calibration",
    "steer",
    "--target",
    identities.calibrator,
    "--key",
    "live-guide",
    "--message",
    "CATSOAK_calibrator_4_guidance",
  );
  assert.equal(replayed.guidance.message_id, guide.guidance.message_id);
  assert.equal(replayed.guidance.turn_id, guide.guidance.turn_id);
  assert.equal(replayed.guidance.state, "delivered");
  // Native steering may already have cancelled the old HTTP stream and consumed
  // the input. Delivery progress may advance while the stable receipt is reused.
  holds.get(hold)?.release();
  await idle("calibration", 30000);
  assert.equal(attempts("calibration").at(-1).id, original.id);
  record("calibration.guidance.pass", { attempt: original.id });
  hold = await calibrateHold("pause", 5);
  const count = attempts("calibration").length;
  const t = Date.now();
  await call(
    "calibration",
    "control",
    "--target",
    identities.calibrator,
    "--action",
    "pause",
    "--immediate",
  );
  await idle("calibration");
  assert.equal(attempts("calibration").at(-1).state, "interrupted");
  await call(
    "calibration",
    "control",
    "--target",
    identities.calibrator,
    "--action",
    "resume",
  );
  assert.equal(attempts("calibration").length, count);
  record("calibration.pause.pass", { elapsedMs: Date.now() - t });
  for (const [i, hour] of [2, 5, 8].entries()) {
    await waitTo(
      started + (smoke ? [130000, 190000, 250000][i] : hour * 3600000),
    );
    if (!active()) return;
    const hold = await calibrateHold("recovery", 10 + i),
      prior = attempts("calibration").at(-1),
      bindings = binding("calibration");
    const oldPid = pids.calibration;
    pids.calibration = null;
    process.kill(oldPid, "SIGKILL");
    record("fault.coordinator.sigkill", { pid: oldPid, attempt: prior.id });
    await sleep(1000);
    pids.calibration = (await call("calibration", "start")).pid;
    assert.deepEqual(binding("calibration"), bindings);
    assert.equal(attempts("calibration").at(-1).id, prior.id);
    assert.equal(attempts("calibration").at(-1).turn_id, prior.turn_id);
    assert.ok(holds.has(hold), "native Turn was lost on Coordinator restart");
    holds.get(hold).release();
    await idle("calibration");
    assertState("calibration");
    record("calibration.recovery.pass", {
      iteration: i + 1,
      attempt: prior.id,
    });
  }
  record("calibration.complete");
  while (active()) await sleep(1000);
}
const onSignal = (s) => {
  record("signal", { signal: s });
  abort = true;
};
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));
let metricTimer,
  sampling = false;
try {
  const repo = join(base, "repo");
  mkdirSync(repo);
  for (const file of ["a.txt", "b.txt"]) writeFileSync(join(repo, file), "0\n");
  writeFileSync(
    join(repo, "verify.cjs"),
    "const fs=require('node:fs');for(const p of ['a.txt','b.txt']){if(!/^\\d+\\n$/.test(fs.readFileSync(p,'utf8')))throw Error(p)}console.log('SOAK_VERIFY_PASS');\n",
  );
  for (const argv of [
    ["init"],
    ["config", "user.name", "Soak fixture"],
    ["config", "user.email", "fixture@example.invalid"],
    ["add", "."],
    ["commit", "-m", "fixture"],
  ])
    await execute("git", ["-C", repo, ...argv]);
  json("ownership.json", {
    runnerPid: process.pid,
    base,
    paths,
    executable,
    skill,
    startedAt: now(),
    deadline: new Date(deadline).toISOString(),
  });
  await initialize("coding", repo);
  await initialize("calibration");
  await idle("coding");
  await idle("calibration");
  for (const a of agents("coding")) {
    if (a.parent_id) identities[a.name] = a.id;
  }
  assert.equal(agents("coding").length, 4);
  assert.equal(agents("calibration").length, 1);
  const initialBindings = {
    coding: binding("coding"),
    calibration: binding("calibration"),
  };
  json("initial-bindings.json", initialBindings);
  await call(
    "calibration",
    "token-reminder",
    "--target",
    identities.calibrator,
    "--scope",
    "tree",
    "--threshold",
    "20",
    "--every",
    "20",
  );
  await sample();
  metricTimer = setInterval(
    () => {
      if (!sampling) {
        sampling = true;
        sample()
          .catch(fail)
          .finally(() => (sampling = false));
      }
    },
    smoke ? 5000 : 30000,
  );
  await Promise.all([codingLoop().catch(fail), calibrationLoop().catch(fail)]);
  if (failure) throw new Error(failure);
  assert.ok(Date.now() >= deadline, "test ended early");
  for (const lane of Object.keys(paths)) {
    await idle(lane);
    assertState(lane, true);
    assert.deepEqual(binding(lane), initialBindings[lane]);
  }
  for (const lane of Object.keys(paths)) {
    for (const agent of agents(lane)) {
      const native = await call(lane, "native-history", "--target", agent.id);
      const actual = native.thread.turns
        .map((t) => ({ id: t.id, state: t.status }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const expected = attempts(lane)
        .filter((t) => t.agent_id === agent.id && t.turn_id)
        .map((t) => ({ id: t.turn_id, state: t.state }))
        .sort((a, b) => a.id.localeCompare(b.id));
      assert.deepEqual(actual, expected, "native/business history mismatch");
    }
  }
  record("native.history.pass");
  record("duration.complete", { rounds: sequence, requests });
} catch (e) {
  fail(e);
} finally {
  abort = true;
  clearInterval(metricTimer);
  for (const lane of Object.keys(paths)) {
    if (existsSync(join(paths[lane].state, "control.sock"))) {
      try {
        await call(
          lane,
          "control",
          "--target",
          lane === "coding" ? identities.lead : identities.calibrator,
          "--action",
          "pause",
          "--immediate",
        );
        await call(lane, "stop");
      } catch (e) {
        record("cleanup.error", { lane, error: String(e) });
        if (!failure) failure = String(e);
      }
    }
    try {
      if (!existsSync(paths[lane].home)) continue;
      await execute(executable, ["app-server", "daemon", "stop"], {
        env: runtimeEnvironment(paths[lane].home),
        timeout: 20000,
      });
    } catch (e) {
      record("cleanup.daemon", { lane, error: String(e.message) });
      if (!failure) failure = String(e);
    }
  }
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  delete process.env[key];
  while (sampling) await sleep(50);
  const result = {
    phase: failure ? "failed" : "completed",
    smoke,
    startedAt: new Date(started).toISOString(),
    finishedAt: now(),
    elapsedMs: Date.now() - started,
    durationMs: duration,
    rounds: sequence,
    requests,
    receivedBytes,
    failure,
    pids,
    paths,
    identities,
    viewLatencyMs: latencies,
    checkpoints: readFileSync(join(run, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.kind.endsWith(".pass")),
  };
  json("result.json", result);
  json("status.json", result);
  record("finished", { phase: result.phase });
  process.exitCode = failure ? 1 : 0;
}
