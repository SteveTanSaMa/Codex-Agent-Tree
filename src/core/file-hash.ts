import { createHash } from "node:crypto";
import { openSync, readSync, closeSync } from "node:fs";
/** Bounded-memory hash for retained artifacts and complete-backup inventories. */
export function sha256File(path: string) {
  const fd = openSync(path, "r"),
    hash = createHash("sha256"),
    buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytes));
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
