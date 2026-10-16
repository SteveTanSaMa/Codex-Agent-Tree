import {
  lstatSync,
  realpathSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
  constants,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { requireCondition, integer, text } from "../core/errors.ts";

export type ReadOnlyResources = Record<string, string>;
export function validateResources(resources: ReadOnlyResources) {
  requireCondition(
    resources &&
      typeof resources === "object" &&
      !Array.isArray(resources) &&
      Object.keys(resources).length <= 16,
    "INVALID_INPUT",
    "At most 16 named read-only resources are allowed",
  );
  for (const [id, path] of Object.entries(resources)) {
    requireCondition(
      /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id) &&
        typeof path === "string" &&
        isAbsolute(path) &&
        realpathSync(path) === path &&
        !["/", "/Users", "/private", "/Applications"].includes(path),
      "INVALID_INPUT",
      "Read-only resources require an ID and a canonical, specific file or directory",
    );
    const stat = lstatSync(path);
    requireCondition(
      !stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()),
      "FORBIDDEN",
      "Resource must be a regular file or directory",
    );
  }
}
export function resourceCall(
  resources: ReadOnlyResources,
  name: string,
  args: Record<string, unknown>,
) {
  const id = text(args.resourceId, "resourceId", 64);
  requireCondition(
    Object.hasOwn(resources, id),
    "FORBIDDEN",
    "Resource is not registered",
  );
  const root = resources[id]!;
  requireCondition(
    realpathSync(root) === root && !lstatSync(root).isSymbolicLink(),
    "FORBIDDEN",
    "Resource identity changed",
  );
  const input =
    args.path === undefined ? "." : text(args.path, "resource path", 1024);
  const parts = input === "." ? [] : input.split("/");
  requireCondition(
    !isAbsolute(input) &&
      !input.includes("\\") &&
      parts.every(
        (p) =>
          p &&
          p !== "." &&
          p !== ".." &&
          ![
            ".git",
            ".codex",
            ".agents",
            "auth.json",
            "operator-token",
          ].includes(p.toLowerCase()) &&
          !p.toLowerCase().startsWith(".env"),
      ),
    "FORBIDDEN",
    "Resource path must remain inside its registered root",
  );
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    requireCondition(
      !lstatSync(path).isSymbolicLink(),
      "FORBIDDEN",
      "Resource symlink traversal refused",
    );
  }
  const stat = lstatSync(path);
  if (name === "list_resource") {
    requireCondition(
      stat.isDirectory(),
      "INVALID_INPUT",
      "Resource path is not a directory",
    );
    const offset = integer((args.offset ?? 0) as number, "offset", 0);
    const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    return {
      resourceId: id,
      path: input,
      entries: entries.slice(offset, offset + 1000).map((e) => ({
        name: e.name,
        type: e.isSymbolicLink()
          ? "symlink"
          : e.isDirectory()
            ? "directory"
            : e.isFile()
              ? "file"
              : "other",
      })),
      nextOffset: offset + 1000 < entries.length ? offset + 1000 : null,
      total: entries.length,
    };
  }
  requireCondition(
    name === "read_resource" && stat.isFile() && stat.nlink === 1,
    "FORBIDDEN",
    "Read requires a regular, unlinked resource file",
  );
  const offset = integer((args.offset ?? 0) as number, "offset", 0),
    length = integer((args.length ?? 65536) as number, "length", 1);
  requireCondition(
    length <= 65536 && offset <= stat.size,
    "INVALID_INPUT",
    "Resource reads are bounded to 65536 bytes per call",
  );
  const encoding = args.encoding ?? "utf8";
  requireCondition(
    encoding === "utf8" || encoding === "base64",
    "INVALID_INPUT",
    "Invalid resource encoding",
  );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let data: Buffer;
  try {
    const buffer = Buffer.alloc(Math.min(length, stat.size - offset));
    const bytes = readSync(fd, buffer, 0, buffer.length, offset);
    data = buffer.subarray(0, bytes);
  } finally {
    closeSync(fd);
  }
  const content = data.toString(encoding);
  requireCondition(
    encoding !== "utf8" ||
      (!content.includes("\0") && !content.includes("\ufffd")),
    "INVALID_INPUT",
    "Resource is not UTF-8 text; use base64 for binary chunks",
  );
  return {
    resourceId: id,
    path: input,
    encoding,
    offset,
    bytes: data.length,
    totalBytes: stat.size,
    nextOffset: offset + data.length < stat.size ? offset + data.length : null,
    chunkSha256: createHash("sha256").update(data).digest("hex"),
    content,
  };
}
