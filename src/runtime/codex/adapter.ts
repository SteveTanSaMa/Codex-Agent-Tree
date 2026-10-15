import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import WebSocket from "ws";
import { CodexJsonRpcClient, type RequestId } from "./vendor/jsonrpc-client.ts";
import { requireCondition } from "../../core/errors.ts";

const execute = promisify(execFile);
export type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "CONFLICT",
    "Unexpected App Server object",
  );
  return value as RecordValue;
}
export function protocolString(value: unknown): string {
  requireCondition(
    typeof value === "string" && value.length > 0,
    "CONFLICT",
    "Unexpected App Server string",
  );
  return value;
}
export function runtimeEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: homedir(),
    CODEX_HOME: resolve(home),
  };
  for (const [key, value] of Object.entries(process.env))
    if (
      /^(https?_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE)$/i.test(
        key,
      )
    )
      environment[key] = value;
  return environment;
}
export interface RuntimeOptions {
  home: string;
  executable?: string;
  expectedVersion: string;
}
export interface DynamicTool {
  type: "function";
  name: string;
  description: string;
  inputSchema: object;
}
export interface RuntimeEvent {
  method: string;
  params: unknown;
  connectionGeneration: number;
}
export interface RuntimeRequest extends RuntimeEvent {
  id: RequestId;
}

/** Official daemon owns execution. Disconnecting this adapter never stops the daemon. */
export class CodexRuntime {
  private socket: WebSocket | undefined;
  private rpc: CodexJsonRpcClient | undefined;
  private connectionGeneration = 0;
  private nativePid: number | null = null;
  private incoming: PassThrough | undefined;
  private outgoing: PassThrough | undefined;
  onEvent: (event: RuntimeEvent) => void = () => {};
  onRequest: (request: RuntimeRequest) => void = () => {};
  onDisconnect: (error: Error) => void = () => {};
  readonly options: RuntimeOptions;
  constructor(options: RuntimeOptions) {
    this.options = options;
  }
  private async command(args: string[]): Promise<string> {
    const { stdout } = await execute(this.options.executable ?? "codex", args, {
      env: runtimeEnvironment(this.options.home),
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  }
  async connect(): Promise<void> {
    requireCondition(!this.rpc, "CONFLICT", "Runtime is already connected");
    const version = (await this.command(["--version"])).trim();
    requireCondition(
      version === this.options.expectedVersion,
      "CONFLICT",
      `Codex protocol version mismatch: ${version}`,
    );
    mkdirSync(this.options.home, { recursive: true, mode: 0o700 });
    // Settings apply only to the caller-selected, dedicated runtime home.
    const settingsDir = join(this.options.home, "app-server-daemon");
    mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
    const settings = join(settingsDir, "settings.json");
    if (!existsSync(settings))
      writeFileSync(
        settings,
        JSON.stringify({
          remoteControlEnabled: false,
          shutdownGraceSeconds: 5,
          updater: { autoUpdateEnabled: false },
        }),
        { mode: 0o600, flag: "wx" },
      );
    const lifecycle = record(
      JSON.parse(await this.command(["app-server", "daemon", "start"])),
    );
    requireCondition(
      `codex-cli ${protocolString(lifecycle.managedCodexVersion)}` ===
        this.options.expectedVersion &&
        lifecycle.appServerVersion === lifecycle.managedCodexVersion,
      "CONFLICT",
      "Managed daemon version differs from the locked protocol",
    );
    requireCondition(
      lifecycle.pid === undefined ||
        (typeof lifecycle.pid === "number" &&
          Number.isSafeInteger(lifecycle.pid) &&
          lifecycle.pid > 0),
      "CONFLICT",
      "Invalid daemon PID",
    );
    this.nativePid = typeof lifecycle.pid === "number" ? lifecycle.pid : null;
    const socketPath = protocolString(lifecycle.socketPath);
    requireCondition(
      Buffer.byteLength(socketPath) <
        (process.platform === "darwin" ? 104 : 108),
      "INVALID_INPUT",
      "Daemon socket path is too long; choose a shorter dedicated runtime home",
    );
    const socket = new WebSocket(`ws+unix://${socketPath}:/`, {
      maxPayload: 16 * 1024 * 1024,
      handshakeTimeout: 20000,
    });
    this.socket = socket;
    try {
      await new Promise<void>((yes, no) => {
        const open = () => {
          socket.off("error", error);
          yes();
        };
        const error = (e: Error) => {
          socket.off("open", open);
          no(e);
        };
        socket.once("open", open);
        socket.once("error", error);
      });
      const generation = ++this.connectionGeneration;
      const incoming = new PassThrough();
      const outgoing = new PassThrough();
      this.incoming = incoming;
      this.outgoing = outgoing;
      const rpc = new CodexJsonRpcClient(outgoing, incoming);
      this.rpc = rpc;
      outgoing.on("data", (bytes: Buffer) => {
        if (socket.readyState === WebSocket.OPEN)
          socket.send(bytes.toString(), (error) => {
            if (error) incoming.destroy(error);
          });
        else incoming.destroy(new Error("Runtime socket closed"));
      });
      socket.on("message", (bytes) => incoming.write(bytes.toString() + "\n"));
      socket.on("close", () => incoming.end());
      socket.on("error", (error) => incoming.destroy(error));
      rpc.onFailure((error) => {
        if (this.rpc === rpc) {
          this.disconnect();
          this.onDisconnect(error);
        }
      });
      rpc.onNotification((method, params) =>
        this.onEvent({ method, params, connectionGeneration: generation }),
      );
      rpc.onServerRequest((id, method, params) =>
        this.onRequest({
          id,
          method,
          params,
          connectionGeneration: generation,
        }),
      );
      await rpc.request("initialize", {
        clientInfo: { name: "codex_agent_tree", version: "0.0.1" },
        capabilities: { experimentalApi: true },
      });
      rpc.notify("initialized");
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }
  connectionInfo() {
    requireCondition(this.rpc, "STATE_BLOCKED", "No connected runtime");
    return {
      nativePid: this.nativePid,
      protocolVersion: this.options.expectedVersion,
    };
  }
  isCurrent(generation: number): boolean {
    return !!this.rpc && generation === this.connectionGeneration;
  }
  async request(
    method: string,
    params: object,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    requireCondition(this.rpc, "STATE_BLOCKED", "Runtime is disconnected");
    return this.rpc.request(method, params, options);
  }
  respond(request: RuntimeRequest, result: unknown) {
    requireCondition(
      this.isCurrent(request.connectionGeneration),
      "STALE_BINDING",
      "Server request belongs to an old connection",
    );
    this.rpc!.respond(request.id, result);
  }
  respondError(request: RuntimeRequest, code: number, message: string) {
    requireCondition(
      this.isCurrent(request.connectionGeneration),
      "STALE_BINDING",
      "Old server request",
    );
    this.rpc!.respondError(request.id, code, message);
  }
  async createThread(
    cwd: string,
    tools: DynamicTool[],
    instructions: string,
  ): Promise<string> {
    const result = record(
      await this.request("thread/start", {
        cwd: resolve(cwd),
        sandbox: "read-only",
        approvalPolicy: "untrusted",
        ephemeral: false,
        historyMode: "legacy",
        dynamicTools: tools,
        developerInstructions: instructions,
        config: {
          "features.multi_agent": false,
          "features.shell_tool": false,
          "features.unified_exec": false,
        },
      }),
    );
    return protocolString(record(result.thread).id);
  }
  async resumeThread(threadId: string, cwd: string) {
    return this.request("thread/resume", { threadId, cwd: resolve(cwd) });
  }
  async readThread(threadId: string, includeTurns = true) {
    return record(
      await this.request("thread/read", { threadId, includeTurns }),
    );
  }
  async startTurn(
    threadId: string,
    input: string,
    attemptId: string,
  ): Promise<string> {
    const result = record(
      await this.request("turn/start", {
        threadId,
        input: [
          { type: "text", text: `[AgentTree attempt ${attemptId}]\n${input}` },
        ],
      }),
    );
    return protocolString(record(result.turn).id);
  }
  async interrupt(threadId: string, turnId: string) {
    await this.request("turn/interrupt", { threadId, turnId });
  }
  disconnect() {
    const rpc = this.rpc;
    this.rpc = undefined;
    rpc?.close();
    this.socket?.terminate();
    this.socket = undefined;
    this.outgoing?.destroy();
    this.incoming?.destroy();
    this.outgoing = undefined;
    this.incoming = undefined;
  }
}
