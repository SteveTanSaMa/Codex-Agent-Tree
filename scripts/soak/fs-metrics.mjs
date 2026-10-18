import { readdirSync, lstatSync } from "node:fs";
// Runtime-owned temp trees may disappear during a sample. Ignore only ENOENT;
// permission, I/O and other failures still stop the test. Never follow symlinks.
export function treeBytes(
  dir,
  io = { readdir: readdirSync, lstat: lstatSync },
) {
  let entries;
  try {
    entries = io.readdir(dir);
  } catch (e) {
    if (e.code === "ENOENT") return 0;
    throw e;
  }
  let bytes = 0;
  for (const entry of entries) {
    const path = dir + "/" + entry;
    let stat;
    try {
      stat = io.lstat(path);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    if (stat.isDirectory()) bytes += treeBytes(path, io);
    else if (stat.isFile()) bytes += stat.size;
  }
  return bytes;
}
