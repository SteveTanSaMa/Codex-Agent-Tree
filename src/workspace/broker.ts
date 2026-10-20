import { sha256File } from "../core/file-hash.ts";
import {
  validateResources,
  resourceCall,
  type ReadOnlyResources,
} from "./resources.ts";
import { sandboxCommand } from "./sandbox.ts";
import { fileURLToPath } from "node:url";
import {
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  existsSync,
  openSync,
  fsyncSync,
  closeSync,
  statSync,
} from "node:fs";
import {
  join,
  resolve,
  relative,
  isAbsolute,
  dirname,
  basename,
} from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { requireCondition, text } from "../core/errors.ts";
import type { Agent } from "../storage/store.ts";
import type { DynamicTool } from "../runtime/codex/adapter.ts";

export interface TestCommand {
  executable: string;
  args: string[];
  networkEndpoints?: { address: string; port: number }[];
}
export interface RepositoryPolicy {
  repository: string;
  baseCommit: string;
  tests: Record<string, TestCommand>;
  directory?: string;
}
export interface WorkspaceAssignment {
  repositoryId: string;
  repositoryIds: string[];
  worktree: "isolated" | "inherit" | "original";
}
export interface WorkspaceSelection {
  repositoryId?: string;
  repositoryIds?: string[];
  worktree?: "isolated" | "inherit";
}
export interface WorkspacePolicy {
  readOnlyResources?: ReadOnlyResources;
  defaultRepository?: string;
  repositories?: Record<string, RepositoryPolicy>;
  repository: string;
  baseCommit: string;
  tests: Record<string, TestCommand>;
}
const limit = 64 * 1024;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const blocked = (name: string) => {
  const part = name.toLowerCase();
  return (
    [".git", ".codex", ".agents", "node_modules"].includes(part) ||
    part.startsWith(".env") ||
    ["auth.json", "operator-token"].includes(part)
  );
};
function git(cwd: string, args: string[]) {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-C",
      cwd,
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: "/nonexistent",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  ).trim();
}
export function assertWorkspaceSeparation(
  repository: string,
  ...paths: string[]
) {
  function canonical(path: string): string {
    const absolute = resolve(path);
    return existsSync(absolute)
      ? realpathSync(absolute)
      : join(
          canonical(dirname(absolute)),
          relative(dirname(absolute), absolute),
        );
  }
  const repo = realpathSync(repository);
  for (const path of paths) {
    const actual = canonical(path);
    requireCondition(
      !inside(repo, actual) && !inside(actual, repo),
      "FORBIDDEN",
      "State and runtime home must be outside the coding repository",
    );
  }
}
export function workspacePolicy(
  repository: string,
  tests: Record<string, TestCommand> = {},
): WorkspacePolicy {
  const root = realpathSync(resolve(repository));
  requireCondition(
    git(root, ["rev-parse", "--show-toplevel"]) === root,
    "INVALID_INPUT",
    "Workspace must be a Git repository root",
  );
  requireCondition(
    !git(root, ["status", "--porcelain"]),
    "CONFLICT",
    "Initialize coding teams from a clean committed repository",
  );
  const baseCommit = git(root, ["rev-parse", "HEAD"]);
  const policy = { repository: root, baseCommit, tests };
  validatePolicy(policy);
  return policy;
}
export function repositories(
  policy: WorkspacePolicy,
): Record<string, RepositoryPolicy> {
  return policy.repositories ?? { default: policy };
}
export function defaultRepository(policy: WorkspacePolicy): string {
  return policy.defaultRepository ?? "default";
}
/** Operator input only. Capture each repository's HEAD once, before creating a team. */
export function multiWorkspacePolicy(value: unknown): WorkspacePolicy {
  requireCondition(
    value && typeof value === "object" && !Array.isArray(value),
    "INVALID_INPUT",
    "Expected workspace manifest",
  );
  const manifest = value as Record<string, unknown>;
  requireCondition(
    Object.keys(manifest).every((k) =>
      ["defaultRepository", "repositories", "readOnlyResources"].includes(k),
    ) &&
      typeof manifest.defaultRepository === "string" &&
      manifest.repositories &&
      typeof manifest.repositories === "object" &&
      !Array.isArray(manifest.repositories),
    "INVALID_INPUT",
    "Invalid workspace manifest",
  );
  requireCondition(
    Object.keys(manifest.repositories).length > 0 &&
      Object.keys(manifest.repositories).length <= 16,
    "INVALID_INPUT",
    "Register between 1 and 16 repositories",
  );
  const registry: Record<string, RepositoryPolicy> = Object.create(null);
  for (const [id, input] of Object.entries(manifest.repositories)) {
    requireCondition(
      input && typeof input === "object" && !Array.isArray(input),
      "INVALID_INPUT",
      "Invalid repository entry",
    );
    const entry = input as Record<string, unknown>;
    requireCondition(
      Object.keys(entry).every((k) =>
        ["path", "directory", "tests"].includes(k),
      ) &&
        typeof entry.path === "string" &&
        (entry.directory === undefined || typeof entry.directory === "string"),
      "INVALID_INPUT",
      "Invalid repository entry",
    );
    registry[id] = {
      ...workspacePolicy(
        entry.path,
        (entry.tests ?? {}) as Record<string, TestCommand>,
      ),
      directory: (entry.directory as string) ?? basename(resolve(entry.path)),
    };
  }
  requireCondition(
    Object.hasOwn(registry, manifest.defaultRepository),
    "INVALID_INPUT",
    "Unknown default repository",
  );
  const policy: WorkspacePolicy = {
    ...registry[manifest.defaultRepository]!,
    defaultRepository: manifest.defaultRepository,
    repositories: registry,
    ...(manifest.readOnlyResources === undefined
      ? {}
      : { readOnlyResources: manifest.readOnlyResources as ReadOnlyResources }),
  };
  validateWorkspacePolicy(policy);
  return policy;
}
export function validateWorkspacePolicy(policy: WorkspacePolicy) {
  validatePolicy(policy);
  validateResources(policy.readOnlyResources ?? {});
  for (const resource of Object.values(policy.readOnlyResources ?? {}))
    for (const repo of Object.values(repositories(policy)))
      assertWorkspaceSeparation(repo.repository, resource);
  const registry = repositories(policy);
  const ids = Object.keys(registry);
  requireCondition(
    ids.length > 0 &&
      ids.length <= 16 &&
      Object.hasOwn(registry, defaultRepository(policy)),
    "INVALID_INPUT",
    "Invalid repository registry",
  );
  const paths: string[] = [],
    commons = new Set<string>(),
    directories = new Set<string>();
  for (const [id, repo] of Object.entries(registry)) {
    validatePolicy(repo);
    requireCondition(
      /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id) &&
        !["__proto__", "constructor", "prototype"].includes(id),
      "INVALID_INPUT",
      "Invalid repository ID",
    );
    const root = realpathSync(repo.repository);
    requireCondition(
      root === repo.repository &&
        git(root, ["rev-parse", "--show-toplevel"]) === root,
      "FORBIDDEN",
      "Repository root changed",
    );
    requireCondition(
      git(root, ["rev-parse", repo.baseCommit + "^{commit}"]) ===
        repo.baseCommit,
      "CONFLICT",
      "Repository base commit unavailable",
    );
    const common = realpathSync(
      resolve(root, git(root, ["rev-parse", "--git-common-dir"])),
    );
    requireCondition(
      !commons.has(common) &&
        paths.every((p) => !inside(p, root) && !inside(root, p)),
      "INVALID_INPUT",
      "Repository roots must be independent and non-nested",
    );
    commons.add(common);
    paths.push(root);
    if (policy.repositories) {
      const directory = repo.directory;
      requireCondition(
        typeof directory === "string" &&
          directory.length > 0 &&
          directory.length <= 128 &&
          !/[\\/\0]/.test(directory) &&
          directory !== "." &&
          directory !== ".." &&
          !blocked(directory),
        "INVALID_INPUT",
        "Invalid repository directory",
      );
      const key = directory.normalize("NFC").toLowerCase();
      requireCondition(
        !directories.has(key),
        "INVALID_INPUT",
        "Repository directories must be unique",
      );
      directories.add(key);
    }
  }
  const primary = registry[defaultRepository(policy)]!;
  requireCondition(
    policy.repository === primary.repository &&
      policy.baseCommit === primary.baseCommit &&
      JSON.stringify(policy.tests) === JSON.stringify(primary.tests),
    "INVALID_INPUT",
    "Default repository policy disagrees with registry",
  );
}
export function validatePolicy(policy: RepositoryPolicy) {
  requireCondition(
    isAbsolute(policy.repository) &&
      /^[0-9a-f]{40,64}$/.test(policy.baseCommit),
    "INVALID_INPUT",
    "Invalid workspace policy",
  );
  requireCondition(
    policy.tests &&
      typeof policy.tests === "object" &&
      !Array.isArray(policy.tests) &&
      Object.keys(policy.tests).length <= 16,
    "INVALID_INPUT",
    "Invalid test allowlist",
  );
  for (const [name, command] of Object.entries(policy.tests)) {
    requireCondition(
      /^[a-zA-Z0-9_-]{1,64}$/.test(name) &&
        command &&
        isAbsolute(command.executable) &&
        Array.isArray(command.args) &&
        command.args.length <= 32 &&
        command.args.every(
          (a) => typeof a === "string" && a.length <= 1024 && !a.includes("\0"),
        ),
      "INVALID_INPUT",
      "Test commands need a name, absolute executable and fixed argument list",
    );
    if (command.networkEndpoints !== undefined) {
      requireCondition(
        Array.isArray(command.networkEndpoints) &&
          command.networkEndpoints.length <= 8,
        "INVALID_INPUT",
        "At most eight fixed TCP endpoints per test",
      );
      for (const endpoint of command.networkEndpoints)
        requireCondition(
          endpoint &&
            endpoint.address === "127.0.0.1" &&
            Number.isInteger(endpoint.port) &&
            endpoint.port >= 1 &&
            endpoint.port <= 65535,
          "INVALID_INPUT",
          "Test network endpoint requires loopback address 127.0.0.1 and TCP port",
        );
    }
  }
}
const string = { type: "string" };
function tool(
  name: string,
  description: string,
  properties: object,
  required: string[],
): DynamicTool {
  return {
    type: "function",
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { ...properties, repositoryId: string },
      required,
      additionalProperties: false,
    },
  };
}
export function workspaceTools(
  depth: number,
  tests: string[],
  resources = false,
): DynamicTool[] {
  return [
    ...(resources
      ? [
          tool(
            "list_resource",
            "List a registered external read-only resource directory. No execution. workspace_list lists resource IDs. Symlinks are listed but cannot be traversed. At most 1000 entries per page.",
            {
              resourceId: string,
              path: string,
              offset: { type: "integer", minimum: 0 },
            },
            ["resourceId"],
          ),
          tool(
            "read_resource",
            "Read up to 65536 bytes from a registered external read-only resource. Binary files require encoding base64. Offset/length support bounded chunks; chunkSha256 hashes only returned bytes. Never write or execute a resource.",
            {
              resourceId: string,
              path: string,
              offset: { type: "integer", minimum: 0 },
              length: { type: "integer", minimum: 1, maximum: 65536 },
              encoding: { type: "string", enum: ["utf8", "base64"] },
            },
            ["resourceId"],
          ),
        ]
      : []),
    tool(
      "workspace_list",
      "List your authorized repositories, primary repository, worktree owners, paths and approved tests. Other tools accept optional repositoryId; omission selects your primary repository.",
      {},
      [],
    ),
    tool(
      "read_file",
      "Read a workspace-relative UTF-8 file (64 KiB maximum) and its SHA-256 hash. Protected paths and symlinks are refused.",
      { path: string },
      ["path"],
    ),
    tool(
      "search_code",
      "Search workspace files for a literal string, optionally under a relative directory. Returns bounded path/line matches; no regular expression or command execution.",
      { query: string, directory: string },
      ["query"],
    ),
    tool(
      "git_diff",
      "Read a bounded tracked-file diff against the selected repository's initialization commit. No external diff drivers. Untracked files are listed separately; read_file reads their contents.",
      {},
      [],
    ),
    ...(depth === 0
      ? [
          tool(
            "terminal",
            "Lead only: execute a shell command in your repository with bounded output and a 30 second timeout. Environment is filtered, network is disabled, writes stay inside the repository and private temporary directory. Use for commands, tests, Git review and integration. Descendants must use restricted tools.",
            { command: string },
            ["command"],
          ),
        ]
      : []),
    ...(depth <= 1
      ? [
          tool(
            "write_file",
            "Atomically write a workspace-relative UTF-8 file, up to 64 KiB. Supply expectedHash from read_file; null requires a new file. An identical-content retry is safe. Missing parent directories are created inside your workspace. Second-level worktrees are isolated; report the repository ID, workspace path and changed files to Lead for review.",
            {
              path: string,
              content: string,
              expectedHash: { type: ["string", "null"] },
            },
            ["path", "content", "expectedHash"],
          ),
        ]
      : []),
    ...(depth <= 1 && tests.length
      ? [
          tool(
            "run_test",
            "Run one operator-approved fixed test command in your workspace. No shell or extra arguments. Timeout 30 seconds; bounded output. Tests execute trusted repository code. Use only when needed and report the exit code.",
            { name: { type: "string", enum: tests } },
            ["name"],
          ),
        ]
      : []),
  ];
}
/** A host capability broker, not an OS boundary against hostile local processes. */
export class WorkspaceBroker {
  private paths = new Map<string, string>();
  private running = new Map<
    string,
    { controller: AbortController; workspace: string; reads: string[] }
  >();
  readonly state: string;
  readonly policy: WorkspacePolicy;
  readonly agent: (id: string) => Agent;
  readonly assignment: (id: string) => WorkspaceAssignment;
  constructor(
    state: string,
    policy: WorkspacePolicy,
    agent: (id: string) => Agent,
    assignment?: (id: string) => WorkspaceAssignment,
  ) {
    this.state = realpathSync(state);
    this.policy = policy;
    this.agent = agent;
    validateWorkspacePolicy(policy);
    requireCondition(
      !policy.repositories || assignment,
      "FORBIDDEN",
      "Multi-repository broker requires persisted Agent workspace grants",
    );
    this.assignment =
      assignment ??
      ((id) => ({
        repositoryId: defaultRepository(policy),
        repositoryIds: Object.keys(repositories(policy)),
        worktree:
          this.agent(id).depth === 0
            ? "original"
            : this.agent(id).depth === 1
              ? "isolated"
              : "inherit",
      }));
    for (const repo of Object.values(repositories(policy)))
      assertWorkspaceSeparation(repo.repository, this.state);
    for (const resource of Object.values(policy.readOnlyResources ?? {}))
      assertWorkspaceSeparation(resource, this.state);
  }
  selection(agent: Agent, repositoryId?: unknown) {
    const assignment = this.assignment(agent.id);
    const id =
      repositoryId === undefined ? assignment.repositoryId : repositoryId;
    requireCondition(
      typeof id === "string" &&
        assignment.repositoryIds.includes(id) &&
        Object.hasOwn(repositories(this.policy), id),
      "FORBIDDEN",
      "Repository is not granted to this Agent",
    );
    return { id, repo: repositories(this.policy)[id]! };
  }
  tests(agent: Agent): string[] {
    return [
      ...new Set(
        this.assignment(agent.id).repositoryIds.flatMap((id) =>
          Object.keys(repositories(this.policy)[id]!.tests),
        ),
      ),
    ];
  }
  owner(agent: Agent): Agent {
    return this.assignment(agent.id).worktree === "inherit"
      ? this.owner(this.agent(agent.parent_id!))
      : agent;
  }
  describe(agent: Agent) {
    const assignment = this.assignment(agent.id);
    return {
      ...assignment,
      readOnlyResources: this.policy.readOnlyResources ?? {},
      repositories: assignment.repositoryIds.map((id) => ({
        repositoryId: id,
        workspace: this.workspacePath(agent, id),
        ownerAgentId: this.owner(agent).id,
        baseCommit: repositories(this.policy)[id]!.baseCommit,
        tests: Object.keys(repositories(this.policy)[id]!.tests),
      })),
    };
  }
  private workspacePath(agent: Agent, repositoryId: string): string {
    const owner = this.owner(agent),
      repo = repositories(this.policy)[repositoryId]!;
    return owner.depth === 0
      ? repo.repository
      : this.policy.repositories
        ? join(this.state, "workspaces", owner.id, repo.directory!)
        : join(this.state, "workspaces", owner.id);
  }
  cwd(agent: Agent, repositoryId?: unknown, provision = true): string {
    const { id, repo } = this.selection(agent, repositoryId);
    const owner = this.owner(agent);
    if (owner.depth === 0) return repo.repository;
    const cacheKey = owner.id + ":" + id;
    const prior = this.paths.get(cacheKey);
    if (prior) return prior;
    const path = this.workspacePath(agent, id);
    if (provision) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    requireCondition(
      realpathSync(dirname(path)) === dirname(path),
      "FORBIDDEN",
      "Worktree parent directory changed",
    );
    const readyDirectory = this.policy.repositories
      ? join(this.state, "worktree-ready", owner.id)
      : join(this.state, "worktree-ready");
    if (provision) mkdirSync(readyDirectory, { recursive: true, mode: 0o700 });
    const marker = join(
      readyDirectory,
      (this.policy.repositories ? id : owner.id) + ".json",
    );
    const identity = JSON.stringify({
      path,
      baseCommit: repo.baseCommit,
      ...(this.policy.repositories
        ? {
            repositoryId: id,
            repository: repo.repository,
            ownerAgentId: owner.id,
          }
        : {}),
    });
    const fresh = !existsSync(path);
    requireCondition(
      provision || !fresh,
      "STATE_BLOCKED",
      "Inspection requires an existing verified worktree; provision it through normal scheduling first",
    );
    requireCondition(
      fresh
        ? !existsSync(marker)
        : existsSync(marker) && readFileSync(marker, "utf8") === identity,
      "CONFLICT",
      "Worktree provisioning is incomplete or changed; inspect files before recovery, no automatic reset",
    );
    if (fresh)
      this.sandboxGit(
        repo.repository,
        ["worktree", "add", "--detach", "--", path, repo.baseCommit],
        owner.id,
        repo,
        path,
      );
    requireCondition(
      !lstatSync(path).isSymbolicLink() &&
        realpathSync(path) === resolve(path) &&
        git(path, ["rev-parse", "--show-toplevel"]) === path &&
        realpathSync(
          resolve(path, git(path, ["rev-parse", "--git-common-dir"])),
        ) ===
          realpathSync(
            resolve(
              repo.repository,
              git(repo.repository, ["rev-parse", "--git-common-dir"]),
            ),
          ),
      "FORBIDDEN",
      "Unexpected worktree identity; inspect workspace before continuing",
    );
    if (fresh) {
      writeFileSync(marker, identity, { flag: "wx", mode: 0o600 });
      const fd = openSync(marker, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const directory = openSync(readyDirectory, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
    this.paths.set(cacheKey, path);
    return path;
  }
  assertHandoffPaths(
    agent: Agent,
    repositoryId: string,
    base: string,
    commit?: string,
  ) {
    const names = this.inspectGit(agent, repositoryId, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      base,
      ...(commit ? [commit] : []),
      "--",
    ])
      .split("\0")
      .filter(Boolean);
    requireCondition(
      names.every((p) => p.split("/").every((part) => !blocked(part))),
      "FORBIDDEN",
      "Handoff contains protected paths; preserve them for human review",
    );
  }
  handoffFiles(agent: Agent, repositoryId: string) {
    this.requireWorkspaceIdle(agent, repositoryId);
    const names = this.inspectGit(agent, repositoryId, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ])
      .split("\0")
      .filter(Boolean);
    requireCondition(
      names.length <= 16,
      "INVALID_INPUT",
      "At most 16 untracked handoff files",
    );
    return names.map((path) => {
      const full = this.path(agent, path, false, false, repositoryId);
      requireCondition(
        lstatSync(full).size <= 65536,
        "INVALID_INPUT",
        "Handoff file exceeds 64 KiB",
      );
      const content = readFileSync(full, "utf8");
      requireCondition(
        content.isWellFormed() &&
          !content.includes("\0") &&
          !content.includes("\ufffd"),
        "INVALID_INPUT",
        "Untracked handoff files must be UTF-8 text",
      );
      return { path, content, sha256: hash(content) };
    });
  }
  inspectGit(
    agent: Agent,
    repositoryId: string,
    args: string[],
    input?: string,
  ) {
    requireCondition(
      [
        "cat-file",
        "rev-parse",
        "merge-base",
        "diff",
        "status",
        "merge-tree",
        "ls-files",
        "apply",
      ].includes(args[0] ?? ""),
      "FORBIDDEN",
      "Read-only Git inspection only",
    );
    requireCondition(
      args[0] !== "apply" || (args[1] === "--check" && input !== undefined),
      "FORBIDDEN",
      "Patch preview only",
    );
    this.requireWorkspaceIdle(agent, repositoryId, false, false);
    const selection = this.selection(agent, repositoryId);
    return this.sandboxGit(
      this.cwd(agent, repositoryId, false),
      args,
      agent.id,
      selection.repo,
      undefined,
      input,
    );
  }
  /** Immutable full reachable commit bundle; never changes a user ref or imports objects. */
  retainHandoff(
    agent: Agent,
    repositoryId: string,
    id: string,
    expectedCommit: string,
  ) {
    requireCondition(
      /^[a-f0-9-]{36}$/.test(id),
      "INVALID_INPUT",
      "Invalid artifact ID",
    );
    this.requireWorkspaceIdle(agent, repositoryId, false, false);
    const { repo } = this.selection(agent, repositoryId);
    const home = join(this.state, "git-homes", agent.id);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const temporary = join(home, id + ".bundle");
    const directory = join(this.state, "handoff-artifacts");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    requireCondition(
      realpathSync(directory) === directory,
      "FORBIDDEN",
      "Artifact directory must not be a symlink",
    );
    const path = join(directory, id + ".bundle");
    try {
      this.sandboxGit(
        this.cwd(agent, repositoryId, false),
        ["bundle", "create", temporary, "HEAD"],
        agent.id,
        repo,
      );
      const heads = this.sandboxGit(
        this.cwd(agent, repositoryId, false),
        ["bundle", "list-heads", temporary],
        agent.id,
        repo,
      );
      requireCondition(
        heads === expectedCommit + " HEAD",
        "CONFLICT",
        "Source HEAD changed while retaining the handoff",
      );
      const bytes = statSync(temporary).size;
      requireCondition(
        bytes <= 128 * 1024 * 1024,
        "STATE_BLOCKED",
        "Handoff bundle exceeds 128 MiB; preserve it using an operator-managed artifact workflow",
      );
      const sha256 = sha256File(temporary);
      const fd = openSync(temporary, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, path);
      const dir = openSync(directory, "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
      return {
        kind: "git-bundle",
        commit: expectedCommit,
        path,
        sha256,
        bytes,
        retention: "indefinite-no-automatic-cleanup",
      };
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  private sandboxGit(
    cwd: string,
    args: string[],
    agentId: string,
    repo: RepositoryPolicy,
    createPath?: string,
    input?: string,
  ): string {
    const create = createPath !== undefined;
    const home = join(this.state, "git-homes", agentId);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const executable = execFileSync("/usr/bin/which", ["git"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    }).trim();
    const common = realpathSync(
      resolve(
        repo.repository,
        git(repo.repository, ["rev-parse", "--git-common-dir"]),
      ),
    );
    const command = sandboxCommand(
      {
        executable,
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-C",
          cwd,
          ...args,
        ],
      },
      cwd,
      realpathSync(home),
      create ? join(this.state, "workspaces") : undefined,
      [common],
      create ? [createPath!, common] : [],
      true,
    );
    const output = execFileSync(command.executable, command.args, {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      input: input ?? "",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: home,
        OPENSSL_CONF: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return args[0] === "diff" && args.includes("--binary")
      ? output
      : output.trim();
  }
  private path(
    agent: Agent,
    input: unknown,
    directory = false,
    createParents = false,
    repositoryId?: unknown,
  ): string {
    const path = text(input, "workspace path", 1024);
    const parts = path.split("/");
    requireCondition(
      !isAbsolute(path) &&
        !path.includes("\\") &&
        parts.every((p) => p && p !== "." && p !== ".." && !blocked(p)),
      "FORBIDDEN",
      "Path must stay in the workspace and avoid protected entries",
    );
    const root = this.cwd(agent, repositoryId);
    let current = root;
    for (const [i, part] of parts.entries()) {
      current = join(current, part);
      const entry = lstatSync(current, { throwIfNoEntry: false });
      const last = i === parts.length - 1;
      requireCondition(
        entry
          ? !entry.isSymbolicLink() &&
              (last && !directory
                ? entry.isFile() && entry.nlink === 1
                : entry.isDirectory())
          : !directory && (last || createParents),
        "FORBIDDEN",
        "Symlink, hardlink, special file or missing directory refused",
      );
    }
    return current;
  }
  cancel(agentId?: string) {
    for (const [id, running] of this.running)
      if (!agentId || id === agentId) running.controller.abort();
  }
  commandRunning(agentId: string) {
    return this.running.has(agentId);
  }
  validateCommand(agent: Agent, name: string, value: unknown): TestCommand {
    validateResources(this.policy.readOnlyResources ?? {});
    requireCondition(
      value !== null && typeof value === "object" && !Array.isArray(value),
      "INVALID_INPUT",
      "Expected command arguments",
    );
    const args = value as Record<string, unknown>;
    requireCondition(
      (name === "terminal" || name === "run_test") &&
        Object.keys(args).every(
          (k) =>
            k === "repositoryId" ||
            k === (name === "terminal" ? "command" : "name"),
        ),
      "INVALID_INPUT",
      "Unknown command argument",
    );
    requireCondition(
      agent.depth <= 1,
      "FORBIDDEN",
      "Third-level Agents cannot execute tests",
    );
    requireCondition(
      name !== "terminal" || agent.depth === 0,
      "FORBIDDEN",
      "Only Lead can use terminal",
    );
    const { repo } = this.selection(agent, args.repositoryId);
    const command =
      name === "terminal"
        ? {
            executable: "/bin/zsh",
            args: ["-f", "-c", text(args.command, "Lead command", 8192)],
          }
        : typeof args.name === "string" && Object.hasOwn(repo.tests, args.name)
          ? repo.tests[args.name]
          : undefined;
    requireCondition(
      command,
      "FORBIDDEN",
      "Test name is not operator-approved",
    );
    this.requireWorkspaceIdle(agent, args.repositoryId, true);
    return command;
  }
  private requireWorkspaceIdle(
    agent: Agent,
    repositoryId?: unknown,
    command = false,
    provision = true,
  ) {
    const path = this.cwd(agent, repositoryId, provision);
    const dependencies = command
      ? this.assignment(agent.id).repositoryIds.map((id) =>
          this.workspacePath(agent, id),
        )
      : [];
    requireCondition(
      ![...this.running.values()].some(
        (r) =>
          r.workspace === path ||
          (command &&
            (r.reads.includes(path) || dependencies.includes(r.workspace))),
      ),
      "STATE_BLOCKED",
      "A command is running in this workspace; wait for its result before file operations",
    );
  }
  async call(agent: Agent, name: string, value: unknown) {
    requireCondition(
      value !== null && typeof value === "object" && !Array.isArray(value),
      "INVALID_INPUT",
      "Expected tool arguments",
    );
    const args = value as Record<string, unknown>;
    const allowed: Record<string, string[]> = {
      workspace_list: [],
      list_resource: ["resourceId", "path", "offset"],
      read_resource: ["resourceId", "path", "offset", "length", "encoding"],
      read_file: ["path"],
      write_file: ["path", "content", "expectedHash"],
      search_code: ["query", "directory"],
      git_diff: [],
      run_test: ["name"],
      terminal: ["command"],
    };
    requireCondition(
      allowed[name] &&
        Object.keys(args).every(
          (k) => k === "repositoryId" || allowed[name]!.includes(k),
        ),
      "INVALID_INPUT",
      "Unknown workspace tool or argument",
    );
    requireCondition(
      name !== "write_file" || agent.depth <= 1,
      "FORBIDDEN",
      "Third-level Agents have read-only access",
    );
    const { repo } = this.selection(agent, args.repositoryId);
    if (name === "workspace_list") return this.describe(agent);
    if (["read_resource", "list_resource"].includes(name))
      return resourceCall(this.policy.readOnlyResources ?? {}, name, args);
    if (!["run_test", "terminal"].includes(name))
      this.requireWorkspaceIdle(
        agent,
        args.repositoryId,
        name === "write_file",
      );
    if (name === "read_file" || name === "write_file") {
      const path = this.path(
        agent,
        args.path,
        false,
        name === "write_file",
        args.repositoryId,
      );
      const entry = lstatSync(path, { throwIfNoEntry: false });
      requireCondition(
        !entry || entry.size <= limit,
        "INVALID_INPUT",
        "File exceeds 64 KiB",
      );
      const current = entry ? readFileSync(path, "utf8") : null;
      requireCondition(
        current === null ||
          (!current.includes("\0") &&
            current.isWellFormed() &&
            !current.includes("\ufffd")),
        "INVALID_INPUT",
        "File must contain UTF-8 text",
      );
      if (name === "read_file") {
        requireCondition(current !== null, "NOT_FOUND", "File does not exist");
        return { path: args.path, content: current, hash: hash(current) };
      }
      requireCondition(
        typeof args.content === "string" &&
          args.content.isWellFormed() &&
          !args.content.includes("\0") &&
          Buffer.byteLength(args.content) <= limit,
        "INVALID_INPUT",
        "Content must be UTF-8 text up to 64 KiB",
      );
      requireCondition(
        args.expectedHash === null ||
          (typeof args.expectedHash === "string" &&
            /^[a-f0-9]{64}$/.test(args.expectedHash)),
        "INVALID_INPUT",
        "Supply expectedHash or null for creation",
      );
      const nextHash = hash(args.content);
      if (current === args.content)
        return { path: args.path, hash: nextHash, unchanged: true };
      requireCondition(
        current === null
          ? args.expectedHash === null
          : hash(current) === args.expectedHash,
        "STALE_REVISION",
        "File changed; read it again before writing",
      );
      mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
      const temporary = join(dirname(path), `.cat-write-${randomUUID()}`);
      try {
        writeFileSync(temporary, args.content, {
          flag: "wx",
          mode: entry ? entry.mode & 0o777 : 0o644,
        });
        const fd = openSync(temporary, "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temporary, path);
        const directory = openSync(dirname(path), "r");
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
      return { path: args.path, hash: nextHash, unchanged: false };
    }
    if (name === "search_code") {
      const query = text(args.query, "literal query", 256);
      const root = this.cwd(agent, args.repositoryId);
      const start =
        args.directory === undefined
          ? root
          : this.path(agent, args.directory, true, false, args.repositoryId);
      const matches: { path: string; line: number; text: string }[] = [];
      let files = 0,
        entries = 0,
        bytes = 0,
        truncated = false;
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          entries++;
          if (
            entries > 5000 ||
            relative(start, dir).split("/").length > 20 ||
            matches.length >= 100 ||
            files >= 2000 ||
            bytes >= 8 * 1024 * 1024
          ) {
            truncated = true;
            return;
          }
          if (
            blocked(e.name) ||
            e.isSymbolicLink() ||
            e.name.startsWith(".cat-write-")
          )
            continue;
          const path = join(dir, e.name);
          if (e.isDirectory()) walk(path);
          else if (e.isFile()) {
            files++;
            const stat = lstatSync(path);
            if (stat.size > limit || stat.nlink !== 1) continue;
            const value = readFileSync(path, "utf8");
            bytes += stat.size;
            if (value.includes("\0")) continue;
            for (const [line, content] of value.split("\n").entries()) {
              if (content.includes(query))
                matches.push({
                  path: relative(root, path),
                  line: line + 1,
                  text: content.slice(0, 300),
                });
              if (matches.length >= 100) {
                truncated = true;
                return;
              }
            }
          }
        }
      };
      walk(start);
      return { matches, truncated, filesScanned: files };
    }
    if (name === "git_diff") {
      const cwd = this.cwd(agent, args.repositoryId);
      // Use a protected path exclusion even for tracked secrets; never run configured external drivers.
      const exclusions = [
        ":(exclude,icase)**/.env*",
        ":(exclude,icase).env*",
        ":(exclude,icase)**/auth.json",
        ":(exclude,icase)**/operator-token",
        ":(exclude,icase)**/.codex/**",
        ":(exclude,icase).codex/**",
        ":(exclude,icase)**/.agents/**",
        ":(exclude,icase).agents/**",
        ":(exclude,icase)**/node_modules/**",
        ":(exclude,icase)node_modules/**",
        ":(exclude,icase)auth.json",
        ":(exclude,icase)operator-token",
      ];
      const diff = this.sandboxGit(
        cwd,
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          repo.baseCommit,
          "--",
          ".",
          ...exclusions,
        ],
        agent.id,
        repo,
      );
      const untracked = this.sandboxGit(
        cwd,
        [
          "ls-files",
          "--others",
          "--exclude-standard",
          "--",
          ".",
          ...exclusions,
        ],
        agent.id,
        repo,
      );
      return {
        workspace: cwd,
        baseCommit: repo.baseCommit,
        diff: diff.slice(0, limit),
        untracked: untracked.slice(0, 8192),
        truncated: diff.length > limit || untracked.length > 8192,
      };
    }
    const command = this.validateCommand(agent, name, args);
    requireCondition(
      !this.running.has(agent.id),
      "STATE_BLOCKED",
      "A test is already running for this Agent",
    );
    const cwd = this.cwd(agent, args.repositoryId);
    const reads = this.assignment(agent.id).repositoryIds.map((id) =>
      this.cwd(agent, id),
    );
    const home = join(this.state, "test-homes", agent.id);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const controller = new AbortController();
    this.running.set(agent.id, { controller, workspace: cwd, reads });
    try {
      return await new Promise<object>((yes, no) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("./test-runner.ts", import.meta.url)),
            JSON.stringify(
              sandboxCommand(
                command,
                cwd,
                realpathSync(home),
                name === "terminal"
                  ? join(this.state, "workspaces")
                  : undefined,
                [
                  ...reads,
                  ...Object.values(this.policy.readOnlyResources ?? {}),
                ],
                [],
                false,
                Object.values(this.policy.readOnlyResources ?? {}),
              ),
            ),
          ],
          {
            cwd,
            shell: false,
            detached: false,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
              PATH: process.env.PATH,
              HOME: home,
              TMPDIR: home,
              CI: "1",
              OPENSSL_CONF: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_TERMINAL_PROMPT: "0",
            },
          },
        );
        let output = Buffer.alloc(0),
          truncated = false,
          stopped: string | null = null;
        const stop = (reason: string) => {
          stopped = reason;
          if (child.pid) {
            try {
              child.stdin.end();
            } catch {}
          }
        };
        const abort = () => stop("cancelled");
        controller.signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => stop("timeout"), 30000);
        for (const pipe of [child.stdout, child.stderr])
          pipe.on("data", (data: Buffer) => {
            const left = limit - output.length;
            if (data.length > left) truncated = true;
            if (left > 0)
              output = Buffer.concat([output, data.subarray(0, left)]);
          });
        child.once("error", no);
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", abort);
          yes({
            name: args.name ?? "terminal",
            exitCode: code,
            signal,
            stopped,
            output: output.toString("utf8"),
            truncated,
          });
        });
      });
    } finally {
      this.running.delete(agent.id);
    }
  }
}
function inside(root: string, path: string) {
  const p = relative(root, path);
  return p === "" || (p !== ".." && !p.startsWith("../") && !isAbsolute(p));
}
