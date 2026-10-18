import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function emit(res: ServerResponse, type: string, value: object) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
}
export function response(
  res: ServerResponse,
  item: Record<string, unknown>,
  id: string,
) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  emit(res, "response.created", {
    response: { id, status: "in_progress", output: [] },
  });
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
/** Synthetic Responses endpoint; credentials never leave loopback. */
export async function scriptedProvider(
  home: string,
  handle: (body: any, res: ServerResponse, count: number) => void,
) {
  mkdirSync(home, { recursive: true });
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (b) => {
      body += String(b);
    });
    req.on("end", () => {
      try {
        const value = JSON.parse(body);
        bodies.push(value);
        handle(value, res, bodies.length);
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const envKey = `CAT_FIXTURE_${randomUUID().replaceAll("-", "").toUpperCase()}_KEY`;
  process.env[envKey] = "fixture-only";
  writeFileSync(
    join(home, "config.toml"),
    `model="fixture"\nmodel_provider="local"\n[model_providers.local]\nname="local"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nenv_key="${envKey}"\nsupports_websockets=false\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n[features]\nmulti_agent=false\nshell_tool=false\nunified_exec=false\n`,
  );
  return {
    bodies,
    credential: { envKey },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      delete process.env[envKey];
    },
  };
}
