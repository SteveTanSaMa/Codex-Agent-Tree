import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  CodexJsonRpcClient,
  RpcFailure,
} from "../../src/runtime/codex/vendor/jsonrpc-client.ts";
function fixture(max?: number) {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new CodexJsonRpcClient(input, output, max);
  return { input, output, client };
}

test("multiplexes requests, notifications and string server request IDs", async () => {
  const { client, input, output } = fixture();
  const writes: string[] = [];
  input.on("data", (b) => writes.push(String(b)));
  let notification: unknown;
  client.onNotification((m, p) => {
    notification = { m, p };
  });
  client.onServerRequest((id, method) =>
    client.respond(id, { accepted: method === "tool" }),
  );
  const one = client.request("one");
  const two = client.request("two");
  output.write(
    '{"id":2,"result":"second"}\n{"id":"server-id","method":"tool"}\n{"method":"event","params":42}\n{"id":1,"result":"first"}\n',
  );
  assert.deepEqual(await Promise.all([one, two]), ["first", "second"]);
  assert.deepEqual(notification, { m: "event", p: 42 });
  assert.deepEqual(JSON.parse(writes[2]!), {
    id: "server-id",
    result: { accepted: true },
  });
  client.close();
});
test("UTF-8 split at arbitrary bytes preserves tool content", () => {
  const { client, output } = fixture();
  let actual: unknown;
  client.onNotification((_m, p) => {
    actual = p;
  });
  const data = Buffer.from('{"method":"message","params":"你好"}\n');
  for (const b of data) output.write(Buffer.from([b]));
  assert.equal(actual, "你好");
  client.close();
});
test("deadline and cancellation report uncertain delivery without silently retrying", async () => {
  const { client } = fixture();
  await assert.rejects(
    client.request("turn/start", {}, { timeoutMs: 5 }),
    (e: unknown) => e instanceof RpcFailure && e.delivery === "unknown",
  );
  const controller = new AbortController();
  const pending = client.request(
    "thread/start",
    {},
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(
    pending,
    (e: unknown) => e instanceof RpcFailure && e.delivery === "unknown",
  );
  await assert.rejects(
    client.request("never-sent", {}, { signal: controller.signal }),
    (e: unknown) => e instanceof RpcFailure && e.delivery === "not-sent",
  );
  client.close();
});
test("malformed or oversized frames reject outstanding calls and surface failure", async () => {
  for (const line of ["not-json\n", "x".repeat(81)]) {
    const { client, output } = fixture(80);
    let failure: Error | undefined;
    client.onFailure((e) => {
      failure = e;
    });
    const pending = client.request("test");
    output.write(line);
    await assert.rejects(pending);
    assert.ok(failure);
    client.close();
  }
});
test("transport EOF and handler exceptions cannot leave requests pending", async () => {
  const first = fixture();
  const request = first.client.request("pending");
  first.output.end();
  await assert.rejects(request, /transport ended/);
  const second = fixture();
  second.client.onNotification(() => {
    throw new Error("handler failed");
  });
  const pending = second.client.request("pending");
  second.output.write('{"method":"event"}\n');
  await assert.rejects(pending, /handler failed/);
  second.client.close();
});
