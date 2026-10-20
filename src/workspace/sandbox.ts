import { realpathSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { requireCondition } from "../core/errors.ts";
import type { TestCommand } from "./broker.ts";
/** Narrow macOS Seatbelt profile; intentionally no unrestricted fallback. */
export function sandboxCommand(
  command: TestCommand,
  cwd: string,
  home: string,
  leadWorkspaces?: string,
  readOnlyRoots: string[] = [],
  writeRoots: string[] = [],
  readOnlyWorkspace = false,
  protectedReadOnlyRoots: string[] = [],
): TestCommand {
  requireCondition(
    process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"),
    "STATE_BLOCKED",
    "Restricted test execution currently requires macOS Seatbelt",
  );
  for (const e of command.networkEndpoints ?? [])
    requireCondition(
      e.address === "127.0.0.1" &&
        Number.isInteger(e.port) &&
        e.port >= 1 &&
        e.port <= 65535,
      "INVALID_INPUT",
      "Fixed loopback IPv4 TCP endpoint required",
    );
  const roots = [
    cwd,
    home,
    dirname(realpathSync(command.executable)),
    "/System",
    "/usr/lib",
    "/usr/share",
    "/usr/local/lib",
    "/opt/homebrew/lib",
    "/opt/homebrew/Cellar",
    "/Library/Apple",
    ...readOnlyRoots,
    ...writeRoots,
    ...(leadWorkspaces
      ? [leadWorkspaces, "/bin", "/usr/bin", "/sbin", "/usr/sbin"]
      : []),
  ];
  const quoted = (s: string) => JSON.stringify(s);
  const profile = `(version 1)
(deny default)
${(command.networkEndpoints ?? []).map((e) => `(allow network-outbound (remote tcp "localhost:${e.port}"))`).join("\n")}
(allow process-exec process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (literal "/"))
(allow file-read* ${roots
    .filter(existsSync)
    .map((s) => `(subpath ${quoted(realpathSync(s))})`)
    .join(" ")})
(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/private/etc/localtime"))
(allow file-write* ${readOnlyWorkspace ? "" : `(subpath ${quoted(cwd)})`} (subpath ${quoted(home)}) ${writeRoots.map((p) => `(subpath ${quoted(existsSync(p) ? realpathSync(p) : resolve(p))})`).join(" ")} (literal "/dev/null"))
${protectedReadOnlyRoots.map((p) => `(deny file-write* (subpath ${quoted(realpathSync(p))}))`).join("\n")}
${leadWorkspaces ? "" : `(deny file-write* (subpath ${quoted(join(cwd, ".git"))}))`}
`;
  const path = join(home, "test.sb");
  writeFileSync(path, profile, { mode: 0o600 });
  return {
    executable: "/usr/bin/sandbox-exec",
    args: ["-f", path, "--", command.executable, ...command.args],
  };
}
