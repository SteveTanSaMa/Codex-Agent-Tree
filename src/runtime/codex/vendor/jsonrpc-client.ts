/**
 * Modified from Stoneforge Codex JSON-RPC Client (Apache-2.0).
 * See README.md, LICENSE and NOTICE in this directory for provenance and changes.
 * Codex uses JSONL without requiring the jsonrpc version member.
 */
import type { Writable, Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export type RequestId = string | number;
export type NotificationHandler = (method: string, params: unknown) => void;
export type ServerRequestHandler = (
  id: RequestId,
  method: string,
  params: unknown,
) => void;
export class RpcFailure extends Error {
  readonly delivery: "not-sent" | "unknown";
  readonly rpcCode: number | undefined;
  constructor(
    message: string,
    delivery: "not-sent" | "unknown",
    rpcCode?: number,
  ) {
    super(message);
    this.name = "RpcFailure";
    this.delivery = delivery;
    this.rpcCode = rpcCode;
  }
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}
interface Frame {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number };
}
export class CodexJsonRpcClient {
  private nextId = 1;
  private pending = new Map<RequestId, Pending>();
  private notificationHandler: NotificationHandler | null = null;
  private serverRequestHandler: ServerRequestHandler | null = null;
  private failureHandler: ((error: Error) => void) | null = null;
  private decoder = new StringDecoder("utf8");
  private lineBuffer = "";
  private closed = false;
  constructor(
    privateInput: Writable,
    privateOutput: Readable,
    maxFrameBytes = 16 * 1024 * 1024,
  ) {
    this.stdin = privateInput;
    this.stdout = privateOutput;
    this.maxFrameBytes = maxFrameBytes;
    privateOutput.on("data", this.data);
    privateOutput.on("end", this.end);
    privateOutput.on("error", this.streamError);
    privateInput.on("error", this.streamError);
  }
  private readonly stdin: Writable;
  private readonly stdout: Readable;
  private readonly maxFrameBytes: number;
  private data = (chunk: Buffer | string) => {
    try {
      this.lineBuffer +=
        typeof chunk === "string" ? chunk : this.decoder.write(chunk);
      let index: number;
      while ((index = this.lineBuffer.indexOf("\n")) >= 0) {
        const line = this.lineBuffer.slice(0, index);
        this.lineBuffer = this.lineBuffer.slice(index + 1);
        if (Buffer.byteLength(line) > this.maxFrameBytes)
          throw new Error("RPC frame exceeds limit");
        if (line.trim()) this.dispatch(this.parse(line));
      }
      if (Buffer.byteLength(this.lineBuffer) > this.maxFrameBytes)
        throw new Error("RPC frame exceeds limit");
    } catch (error) {
      this.fail(
        error instanceof Error ? error : new Error("RPC decoding failed"),
      );
    }
  };
  private end = () =>
    this.fail(new RpcFailure("RPC transport ended", "unknown"));
  private streamError = (error: Error) =>
    this.fail(new RpcFailure(`RPC transport failed: ${error.name}`, "unknown"));
  private parse(line: string): Frame {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("Malformed RPC JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Malformed RPC frame");
    const f = value as Frame;
    if (
      f.id !== undefined &&
      typeof f.id !== "string" &&
      !(typeof f.id === "number" && Number.isSafeInteger(f.id))
    )
      throw new Error("Malformed RPC request ID");
    if (f.method !== undefined && (typeof f.method !== "string" || !f.method))
      throw new Error("Malformed RPC method");
    if (
      f.method === undefined &&
      (f.id === undefined ||
        (!Object.hasOwn(f, "result") && !Object.hasOwn(f, "error")))
    )
      throw new Error("Malformed RPC response");
    if (
      f.error !== undefined &&
      (!f.error ||
        typeof f.error !== "object" ||
        (f.error.message !== undefined && typeof f.error.message !== "string"))
    )
      throw new Error("Malformed RPC error");
    return f;
  }
  private dispatch(f: Frame) {
    if (f.method !== undefined && f.id !== undefined) {
      if (!this.serverRequestHandler)
        throw new Error("Unhandled RPC server request");
      this.serverRequestHandler(f.id, f.method, f.params);
    } else if (f.method !== undefined)
      this.notificationHandler?.(f.method, f.params);
    else if (f.id !== undefined) {
      const p = this.pending.get(f.id);
      if (!p) return;
      this.pending.delete(f.id);
      p.cleanup();
      f.error
        ? p.reject(
            new RpcFailure(
              `RPC error ${f.error.code ?? "unknown"}: ${f.error.message ?? "request failed"}`,
              "unknown",
              f.error.code,
            ),
          )
        : p.resolve(f.result);
    }
  }
  request(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (this.closed || options.signal?.aborted)
      return Promise.reject(new RpcFailure("RPC request not sent", "not-sent"));
    const timeoutMs = options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      return Promise.reject(new RpcFailure("Invalid RPC deadline", "not-sent"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abandon = (reason: string) => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        p.cleanup();
        reject(new RpcFailure(reason, "unknown"));
      };
      const timer = setTimeout(
        () => abandon(`RPC deadline: ${method}`),
        timeoutMs,
      );
      const abort = () => abandon(`RPC cancelled: ${method}`);
      options.signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
        },
      });
      try {
        this.writeLine({
          id,
          method,
          ...(params === undefined ? {} : { params }),
        });
      } catch (error) {
        this.fail(
          error instanceof Error ? error : new Error("RPC write failed"),
        );
      }
    });
  }
  notify(method: string, params?: unknown) {
    this.writeLine({ method, ...(params === undefined ? {} : { params }) });
  }
  respond(id: RequestId, result: unknown) {
    this.writeLine({ id, result });
  }
  respondError(id: RequestId, code: number, message: string) {
    this.writeLine({ id, error: { code, message } });
  }
  onNotification(handler: NotificationHandler) {
    this.notificationHandler = handler;
  }
  onServerRequest(handler: ServerRequestHandler) {
    this.serverRequestHandler = handler;
  }
  onFailure(handler: (error: Error) => void) {
    this.failureHandler = handler;
  }
  close() {
    this.fail(new RpcFailure("RPC client closed", "unknown"), false);
  }
  private fail(error: Error, report = true) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.off("data", this.data);
    this.stdout.off("end", this.end);
    this.stdout.off("error", this.streamError);
    this.stdin.off("error", this.streamError);
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(error);
    }
    this.pending.clear();
    this.notificationHandler = null;
    this.serverRequestHandler = null;
    if (report) this.failureHandler?.(error);
  }
  private writeLine(value: object) {
    if (this.closed) throw new RpcFailure("RPC client is closed", "not-sent");
    const line = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(line) > this.maxFrameBytes)
      throw new RpcFailure("RPC outbound frame exceeds limit", "not-sent");
    this.stdin.write(line, (error?: Error | null) => {
      if (error) this.fail(new RpcFailure("RPC write failed", "unknown"));
    });
  }
}
