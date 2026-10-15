import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function writeEvidence(name: string, value: unknown): void {
  const directory = resolve(".artifacts/evidence");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, name),
    JSON.stringify(value, null, 2) + "\n",
  );
}
