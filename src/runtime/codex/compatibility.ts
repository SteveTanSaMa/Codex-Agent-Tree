import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requireCondition } from "../../core/errors.ts";

type Schema = { [key: string]: any };
export interface Qualification {
  policy: "capabilities-v1";
  cliVersion: string;
  contractHash: string;
  checkedCapabilities: string[];
}
const inputs: Record<string, string[]> = {
  "v1/InitializeParams": ["clientInfo", "capabilities"],
  "v2/ThreadStartParams": [
    "cwd",
    "sandbox",
    "approvalPolicy",
    "ephemeral",
    "historyMode",
    "dynamicTools",
    "developerInstructions",
    "config",
  ],
  "v2/ThreadResumeParams": ["threadId", "cwd"],
  "v2/ThreadReadParams": ["threadId", "includeTurns"],
  "v2/TurnStartParams": ["threadId", "input"],
  "v2/TurnSteerParams": [
    "threadId",
    "expectedTurnId",
    "input",
    "clientUserMessageId",
  ],
  "v2/TurnInterruptParams": ["threadId", "turnId"],
  DynamicToolCallResponse: ["success", "contentItems"],
};
const textInput = [{ type: "text", text: "fixture" }];
const samples: Record<string, Record<string, unknown>> = {
  "v1/InitializeParams": {
    clientInfo: { name: "codex_agent_tree", version: "0.0.1" },
    capabilities: { experimentalApi: true },
  },
  "v2/ThreadStartParams": {
    cwd: "/tmp",
    sandbox: "read-only",
    approvalPolicy: "untrusted",
    ephemeral: false,
    historyMode: "legacy",
    dynamicTools: [
      {
        type: "function",
        name: "fixture",
        description: "fixture",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    developerInstructions: "fixture",
    config: {
      "features.multi_agent": false,
      "features.shell_tool": false,
      "features.unified_exec": false,
    },
  },
  "v2/ThreadResumeParams": { threadId: "fixture", cwd: "/tmp" },
  "v2/ThreadReadParams": { threadId: "fixture", includeTurns: true },
  "v2/TurnStartParams": { threadId: "fixture", input: textInput },
  "v2/TurnSteerParams": {
    threadId: "fixture",
    expectedTurnId: "fixture",
    input: textInput,
    clientUserMessageId: "fixture",
  },
  "v2/TurnInterruptParams": { threadId: "fixture", turnId: "fixture" },
  DynamicToolCallResponse: {
    success: true,
    contentItems: [{ type: "inputText", text: "fixture" }],
  },
};
const outputs: Record<string, string[]> = {
  "v2/ThreadStartResponse": ["thread"],
  "v2/ThreadReadResponse": ["thread"],
  "v2/TurnStartResponse": ["turn"],
  "v2/TurnSteerResponse": ["turnId"],
  DynamicToolCallParams: ["threadId", "turnId", "callId", "tool", "arguments"],
  "v2/ThreadTokenUsageUpdatedNotification": [
    "threadId",
    "turnId",
    "tokenUsage",
  ],
};
export const schemaFiles = [
  ...new Set([
    "ClientRequest",
    "ServerRequest",
    "ServerNotification",
    ...Object.keys(inputs),
    ...Object.keys(outputs),
  ]),
];

/** Validate the contracts used by this adapter, not an allowlist of release numbers. */
export function inspectSchemas(schemas: Record<string, Schema>): string[] {
  const checked: string[] = [];
  const need = (ok: unknown, detail: string) => {
    requireCondition(
      ok,
      "STATE_BLOCKED",
      `Missing/incompatible Codex capability: ${detail}`,
    );
    checked.push(detail);
  };
  const root = (name: string) => {
    need(schemas[name], name);
    return schemas[name]!;
  };
  const resolve = (node: Schema, doc: Schema): Schema => {
    if (node.allOf?.length === 1) return resolve(node.allOf[0], doc);
    if (typeof node.$ref !== "string") return node;
    requireCondition(
      node.$ref.startsWith("#/definitions/"),
      "STATE_BLOCKED",
      "Unsupported capability schema reference",
    );
    const value = doc.definitions?.[node.$ref.slice(14)];
    requireCondition(
      value,
      "STATE_BLOCKED",
      "Missing capability schema definition",
    );
    return value;
  };
  const property = (doc: Schema, obj: Schema, name: string, type?: string) => {
    const p = obj.properties?.[name];
    need(p !== undefined, `field:${name}`);
    if (type) need(resolve(p, doc).type === type, `type:${name}:${type}`);
    return p;
  };
  // Narrow structural checks for the payloads this adapter actually sends.
  // Runtime response validation and behavior tests remain independent evidence.
  const fits = (value: any, raw: any, doc: Schema, depth = 0): boolean => {
    if (raw === true) return true;
    if (!raw || depth > 32) return false;
    const node = resolve(raw, doc);
    for (const union of [node.oneOf, node.anyOf])
      if (union && !union.some((s: Schema) => fits(value, s, doc, depth + 1)))
        return false;
    if (
      node.enum &&
      !node.enum.some(
        (x: unknown) => JSON.stringify(x) === JSON.stringify(value),
      )
    )
      return false;
    const type =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (
      node.type &&
      !(Array.isArray(node.type) ? node.type : [node.type]).some(
        (t: string) =>
          t === type || (t === "integer" && Number.isInteger(value)),
      )
    )
      return false;
    if (type === "object") {
      if ((node.required ?? []).some((key: string) => !(key in value)))
        return false;
      for (const [key, item] of Object.entries(value)) {
        const prop = node.properties?.[key];
        if (prop === undefined && node.additionalProperties === false)
          return false;
        if (prop !== undefined && !fits(item, prop, doc, depth + 1))
          return false;
      }
    }
    if (
      type === "array" &&
      node.items &&
      !value.every((v: unknown) => fits(v, node.items, doc, depth + 1))
    )
      return false;
    return true;
  };
  for (const [name, sent] of Object.entries(inputs)) {
    const doc = root(name);
    for (const field of sent) property(doc, doc, field);
    need(
      (doc.required ?? []).every((field: string) => sent.includes(field)),
      `no-unsupplied-required-input:${name}`,
    );
    need(fits(samples[name], doc, doc), `adapter-payload:${name}`);
  }
  for (const [name, fields] of Object.entries(outputs)) {
    const doc = root(name);
    for (const field of fields) {
      property(doc, doc, field);
      need(doc.required?.includes(field), `required:${name}.${field}`);
    }
  }
  for (const field of ["threadId", "turnId", "callId", "tool"])
    property(
      root("DynamicToolCallParams"),
      root("DynamicToolCallParams"),
      field,
      "string",
    );
  property(
    root("DynamicToolCallResponse"),
    root("DynamicToolCallResponse"),
    "success",
    "boolean",
  );
  property(
    root("DynamicToolCallResponse"),
    root("DynamicToolCallResponse"),
    "contentItems",
    "array",
  );
  const methods = (doc: Schema) =>
    (doc.oneOf ?? []).flatMap(
      (branch: Schema) => branch.properties?.method?.enum ?? [],
    );
  for (const name of [
    "initialize",
    "thread/start",
    "thread/resume",
    "thread/read",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
  ])
    need(methods(root("ClientRequest")).includes(name), `rpc:${name}`);
  need(
    methods(root("ServerRequest")).includes("item/tool/call"),
    "callback:item/tool/call",
  );
  for (const name of [
    "turn/started",
    "turn/completed",
    "thread/tokenUsage/updated",
  ])
    need(
      methods(root("ServerNotification")).includes(name),
      `notification:${name}`,
    );
  const doc = root("v2/ThreadReadResponse");
  const thread = resolve(property(doc, doc, "thread"), doc);
  for (const [field, type] of [
    ["id", "string"],
    ["turns", "array"],
  ])
    property(doc, thread, field!, type);
  const turn = resolve(resolve(thread.properties.turns, doc).items, doc);
  property(doc, turn, "id", "string");
  property(doc, turn, "items", "array");
  const statuses = resolve(property(doc, turn, "status"), doc).enum ?? [];
  for (const status of ["inProgress", "completed", "failed", "interrupted"])
    need(statuses.includes(status), `turn-status:${status}`);
  const threadStates =
    resolve(property(doc, thread, "status"), doc).oneOf ?? [];
  for (const status of ["idle", "active"])
    need(
      threadStates.some((s: Schema) =>
        s.properties?.type?.enum?.includes(status),
      ),
      `thread-status:${status}`,
    );
  return checked;
}

/** Isolated, credential-free structural preflight. Never starts a daemon or model. */
export function qualifyCodex(executable = "codex"): Qualification {
  const base = mkdtempSync(join(tmpdir(), "cat-capability-")),
    home = join(base, "h"),
    out = join(base, "schema");
  mkdirSync(home);
  const env: NodeJS.ProcessEnv = { CODEX_HOME: home };
  for (const key of ["PATH", "HOME", "TMPDIR", "SystemRoot", "WINDIR"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  const command = (args: string[]) =>
    execFileSync(executable, args, {
      env,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    const cliVersion = command(["--version"]).trim();
    requireCondition(
      cliVersion.length > 0 && cliVersion.length < 256,
      "STATE_BLOCKED",
      "Codex version is unavailable",
    );
    command([
      "app-server",
      "generate-json-schema",
      "--experimental",
      "--out",
      out,
    ]);
    const schemas = Object.fromEntries(
      schemaFiles.map((name) => {
        const file = join(out, name + ".json");
        requireCondition(
          existsSync(file),
          "STATE_BLOCKED",
          `Missing/incompatible Codex capability: schema:${name}`,
        );
        return [name, JSON.parse(readFileSync(file, "utf8"))];
      }),
    );
    const checkedCapabilities = inspectSchemas(schemas);
    return {
      policy: "capabilities-v1",
      cliVersion,
      contractHash: createHash("sha256")
        .update(JSON.stringify(schemas))
        .digest("hex"),
      checkedCapabilities,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Missing/incompatible Codex capability:")
    )
      throw error;
    throw new Error(
      "Codex capability qualification failed; experimental schema export or required contract is unavailable",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
