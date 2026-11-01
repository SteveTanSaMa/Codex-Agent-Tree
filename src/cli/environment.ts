import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type ToolRequest = { name: string; path: string };

/** A metadata-only check: it never runs tools, opens network sockets, or reads credentials. */
export function environment(state: string, requested: unknown = []) {
  if (
    !Array.isArray(requested) ||
    requested.length > 32 ||
    requested.some(
      (item: unknown) =>
        !item ||
        typeof item !== "object" ||
        typeof (item as ToolRequest).name !== "string" ||
        !(item as ToolRequest).name ||
        (item as ToolRequest).name.length > 128 ||
        typeof (item as ToolRequest).path !== "string" ||
        !isAbsolute((item as ToolRequest).path),
    )
  )
    throw new Error(
      "tools must be an array of up to 32 {name, path} objects with absolute paths",
    );
  const check = (path: string) => {
    try {
      const stat = statSync(path);
      const hasAccess = (mode: number) => {
        try {
          accessSync(path, mode);
          return true;
        } catch {
          return false;
        }
      };
      return {
        path,
        exists: true,
        kind: stat.isDirectory()
          ? "directory"
          : stat.isFile()
            ? "file"
            : "other",
        hostReadable: hasAccess(constants.R_OK),
        hostExecutable: hasAccess(constants.X_OK),
      };
    } catch (error) {
      return {
        path,
        exists: false,
        error: (error as NodeJS.ErrnoException).code ?? "UNAVAILABLE",
      };
    }
  };
  const configPath = join(state, "config.json");
  let config: Record<string, any> = {},
    configError: string | null = null;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    configError = (error as NodeJS.ErrnoException).code ?? "INVALID_CONFIG";
  }
  let policy: any = config.workspace,
    policySource = policy ? "configuration" : "none",
    databaseError: string | null = null;
  const database = join(state, "business.sqlite");
  if (existsSync(database)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(database, { readOnly: true });
      if (
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_registry'",
          )
          .get()
      ) {
        const row = db
          .prepare("SELECT policy FROM workspace_registry WHERE singleton=1")
          .get();
        if (row) {
          policy = JSON.parse(String(row.policy));
          policySource = "persisted-registry";
        }
      }
    } catch {
      databaseError = "workspace-registry-unavailable";
      policy = undefined;
      policySource = "unavailable";
    } finally {
      db?.close();
    }
  }
  const repositories = Object.entries(
    policy?.repositories ?? (policy?.repository ? { default: policy } : {}),
  ).map(([id, entry]) => {
    const repo = entry as {
      repository?: string;
      tests?: Record<
        string,
        { executable?: string; networkEndpoints?: unknown }
      >;
    };
    return {
      id,
      directory:
        typeof repo.repository === "string" ? check(repo.repository) : null,
      tests: Object.entries(repo.tests ?? {}).map(([name, command]) => ({
        name,
        executable:
          typeof command.executable === "string"
            ? check(command.executable)
            : null,
        networkEndpoints: command.networkEndpoints ?? [],
      })),
    };
  });
  return {
    readOnly: true,
    evidence: {
      config: configPath,
      database: existsSync(database) ? database : null,
      policySource,
    },
    issues: [configError && `config:${configError}`, databaseError].filter(
      Boolean,
    ),
    platform: {
      os: process.platform,
      architecture: process.arch,
      node: process.version,
      codingSandboxAvailable:
        process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"),
    },
    workspace: {
      configured: !!policy,
      repositories,
      readOnlyResources: Object.entries(policy?.readOnlyResources ?? {}).map(
        ([id, path]) => ({
          id,
          ...(typeof path === "string"
            ? check(path)
            : { exists: false, error: "INVALID_PATH" }),
        }),
      ),
    },
    commandPolicy: {
      terminalNetwork: "denied",
      testNetwork: "only configured loopback TCP endpoints",
      synchronousTimeoutMs: 30000,
      leadBackgroundTerminalTimeoutMs: 600000,
      outputBytes: 65536,
      sandboxQualification: "macOS arm64 trusted local workspace",
    },
    tools: (requested as ToolRequest[]).map(({ name, path }) => ({
      name,
      ...check(path),
    })),
    limitations: [
      "Host permissions and path existence do not prove sandbox access, dependency availability, actual command execution, or network connectivity.",
      "Model provider configuration and credentials were not inspected; no model call was made.",
    ],
  };
}
