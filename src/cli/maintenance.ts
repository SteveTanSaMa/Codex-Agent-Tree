import { sha256File } from "../core/file-hash.ts";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { requireCondition } from "../core/errors.ts";
import { BUSINESS_SCHEMA_VERSION } from "../storage/store.ts";
const open = (state: string) =>
  new DatabaseSync(join(state, "business.sqlite"), { readOnly: true });
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
export function capacity(
  state: string,
  policy: { warnBytes?: number; warnRows?: number } = {},
) {
  requireCondition(
    policy &&
      typeof policy === "object" &&
      !Array.isArray(policy) &&
      Object.keys(policy).every((k) => ["warnBytes", "warnRows"].includes(k)),
    "INVALID_INPUT",
    "Invalid capacity policy",
  );
  const warnBytes = policy.warnBytes ?? 1024 ** 3,
    warnRows = policy.warnRows ?? 1000000;
  requireCondition(
    [warnBytes, warnRows].every((n) => Number.isSafeInteger(n) && n > 0),
    "INVALID_INPUT",
    "Capacity thresholds must be positive safe integers",
  );
  const db = open(state);
  try {
    const tables = [
      "tasks",
      "task_archives",
      "messages",
      "operator_messages",
      "turn_attempts",
      "events",
      "handoffs",
      "integration_results",
      "workspace_commands",
    ];
    const known = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name),
    );
    const rows = Object.fromEntries(
      tables
        .filter((t) => known.has(t))
        .map((t) => [
          t,
          Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()!.n),
        ]),
    );
    let bytes = 0,
      files = 0;
    const unreadable: string[] = [],
      externalLinks: string[] = [];
    function walk(path: string) {
      try {
        const st = lstatSync(path);
        if (st.isSymbolicLink()) {
          externalLinks.push(path);
          return;
        }
        if (st.isDirectory())
          for (const e of readdirSync(path)) walk(join(path, e));
        else if (st.isFile()) {
          bytes += st.size;
          files++;
        }
      } catch {
        unreadable.push(path);
      }
    }
    walk(state);
    const totalRows = Object.values(rows).reduce((a, b) => a + b, 0);
    const warnings: string[] = [];
    if (bytes >= warnBytes) warnings.push("state-bytes-threshold");
    if (totalRows >= warnRows) warnings.push("history-rows-threshold");
    if (unreadable.length) warnings.push("capacity-scan-incomplete");
    const artifactDirectory = join(realpathSync(state), "handoff-artifacts");
    const artifactFiles = existsSync(artifactDirectory)
      ? readdirSync(artifactDirectory)
      : [];
    const lookup = known.has("handoffs")
      ? db.prepare(
          "SELECT json_extract(body,'$.artifact.path') AS path FROM handoffs WHERE id=?",
        )
      : null;
    const orphanArtifacts = artifactFiles
      .map((f) => join(artifactDirectory, f))
      .filter((path) => {
        const name = path
          .slice(artifactDirectory.length + 1)
          .replace(/\.bundle$/, "");
        return lookup?.get(name)?.path !== path;
      });
    if (orphanArtifacts.length)
      warnings.push("unreferenced-artifacts-preserved");
    return {
      readOnly: true,
      artifacts: {
        directory: artifactDirectory,
        files: artifactFiles.length,
        unreferenced: orphanArtifacts,
        cleanup: "No automatic cleanup; preserve for explicit audit review",
      },
      bytes,
      files,
      rows,
      totalRows,
      thresholds: { warnBytes, warnRows },
      warnings,
      externalLinks,
      unreadable,
      scope:
        "State files only; external repositories/runtime homes are excluded. Symlinks are not followed. Counts are observations, not an atomic snapshot under a live writer.",
      automaticCleanup: false,
    };
  } finally {
    db.close();
  }
}
export function historyExport(
  state: string,
  target: string,
  kind: string,
  after = 0,
  limit = 50,
) {
  requireCondition(
    Number.isSafeInteger(after) &&
      after >= 0 &&
      Number.isSafeInteger(limit) &&
      limit >= 1 &&
      limit <= 100,
    "INVALID_INPUT",
    "Invalid history page",
  );
  const db = open(state);
  try {
    const agent = db
      .prepare("SELECT tree_id FROM agents WHERE id=?")
      .get(target);
    requireCondition(agent, "NOT_FOUND", "Agent not found");
    let rows;
    if (kind === "messages")
      rows = db
        .prepare(
          `SELECT o.sequence AS cursor,m.*,'agent' AS origin FROM message_order o JOIN messages m ON m.id=o.message_id JOIN agents a ON a.id=m.recipient_id WHERE a.tree_id=? AND o.sequence>? UNION ALL SELECT o.sequence AS cursor,m.id,NULL AS sender_id,m.recipient_id,m.body,m.status,m.attempt_id,m.created_at,m.processed_at,'human' AS origin FROM message_order o JOIN operator_messages m ON m.id=o.message_id JOIN agents a ON a.id=m.recipient_id WHERE a.tree_id=? AND o.sequence>? ORDER BY cursor LIMIT ?`,
        )
        .all(
          String(agent.tree_id),
          after,
          String(agent.tree_id),
          after,
          limit + 1,
        );
    else {
      const table = (
        {
          events: "events",
          attempts: "turn_attempts",
          handoffs: "handoffs",
          integrations: "integration_results",
        } as Record<string, string>
      )[kind];
      requireCondition(
        table,
        "INVALID_INPUT",
        "History kind must be events, attempts, messages, handoffs or integrations",
      );
      if (table === "turn_attempts")
        rows = db
          .prepare(
            "SELECT t.rowid AS cursor,t.* FROM turn_attempts t JOIN agents a ON a.id=t.agent_id WHERE a.tree_id=? AND t.rowid>? ORDER BY t.rowid LIMIT ?",
          )
          .all(String(agent.tree_id), after, limit + 1);
      else
        rows = db
          .prepare(
            `SELECT rowid AS cursor,* FROM ${table} WHERE tree_id=? AND rowid>? ORDER BY rowid LIMIT ?`,
          )
          .all(String(agent.tree_id), after, limit + 1);
    }
    return {
      readOnly: true,
      kind,
      items: rows.slice(0, limit),
      nextCursor: rows.length > limit ? rows[limit - 1]!.cursor : null,
    };
  } finally {
    db.close();
  }
}
function live(pid: unknown) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export function preflight(state: string) {
  const db = open(state);
  try {
    const schema = Number(
      db.prepare("SELECT version FROM schema_version").get()!.version,
    );
    const owner = db.prepare("SELECT * FROM owner WHERE singleton=1").get();
    const ownerActive = !!owner?.id && live(owner.pid);
    const configPath = join(state, "config.json");
    const config = existsSync(configPath) ? json(configPath) : {};
    const roots = [resolve(state)];
    if (config.runtimeHome) roots.push(resolve(config.runtimeHome));
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE name='workspace_registry'")
      .get();
    const registry = table
      ? db
          .prepare("SELECT policy FROM workspace_registry WHERE singleton=1")
          .get()
      : null;
    const policy = registry
      ? JSON.parse(String(registry.policy))
      : config.workspace;
    const stable = (v: any): any =>
      Array.isArray(v)
        ? v.map(stable)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((k) => [k, stable(v[k])]),
            )
          : v;
    const configurationMismatch =
      !!registry &&
      !!config.workspace &&
      JSON.stringify(stable(policy)) !==
        JSON.stringify(stable(config.workspace));
    const repositoryErrors: string[] = [];
    for (const repo of Object.values(
      policy?.repositories ?? (policy ? { default: policy } : {}),
    ) as { repository: string }[]) {
      roots.push(resolve(repo.repository));
      try {
        const common = execFileSync(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-C",
            repo.repository,
            "rev-parse",
            "--git-common-dir",
          ],
          {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              PATH: process.env.PATH,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
            },
          },
        ).trim();
        roots.push(resolve(repo.repository, common));
      } catch {
        repositoryErrors.push(repo.repository);
      }
    }
    const unique = [
      ...new Set(roots.map((p) => (existsSync(p) ? realpathSync(p) : p))),
    ]
      .sort((a, b) => a.length - b.length)
      .filter(
        (p, _, all) => !all.some((a) => a !== p && p.startsWith(a + "/")),
      );
    const missing = unique.filter((p) => !existsSync(p));
    const integrity = db.prepare("PRAGMA quick_check").get();
    return {
      readOnly: true,
      schema,
      supported: { minimum: 1, current: BUSINESS_SCHEMA_VERSION },
      compatible: schema >= 1 && schema <= BUSINESS_SCHEMA_VERSION,
      migrationRequired: schema < BUSINESS_SCHEMA_VERSION,
      ownerActive,
      controlSocketPresent: existsSync(join(state, "control.sock")),
      backupRoots: unique,
      missing,
      repositoryErrors,
      configurationMismatch,
      integrity,
      nativeActivity:
        "Not established by stopped Coordinator; inspect native history and stop external writers before backup/restore",
      threadCatalog: "Existing native Threads keep their original tool catalog",
      downgrade:
        "Restore matching pre-upgrade full backup and reconcile intervening native/external effects; never restore over a live owner",
    };
  } finally {
    db.close();
  }
}
function inventory(root: string) {
  const entries: {
    path: string;
    kind: string;
    sha256?: string;
    target?: string;
    bytes?: number;
    mode?: number;
  }[] = [];
  function walk(path: string) {
    const stat = lstatSync(path),
      rel = relative(root, path) || ".";
    if (stat.isSymbolicLink())
      entries.push({ path: rel, kind: "symlink", target: readlinkSync(path) });
    else if (stat.isDirectory()) {
      entries.push({ path: rel, kind: "directory", mode: stat.mode & 0o7777 });
      for (const n of readdirSync(path).sort()) walk(join(path, n));
    } else if (stat.isFile())
      entries.push({
        path: rel,
        kind: "file",
        bytes: stat.size,
        mode: stat.mode & 0o7777,
        sha256: sha256File(path),
      });
    else
      requireCondition(
        false,
        "STATE_BLOCKED",
        "Special file prevents complete backup: " + path,
      );
  }
  walk(root);
  return entries;
}
export function backupState(state: string, destination: string) {
  const report = preflight(state);
  const canonical = (p: string): string =>
    existsSync(p)
      ? realpathSync(p)
      : join(canonical(dirname(p)), p.slice(dirname(p).length + 1));
  const output = canonical(resolve(destination));
  requireCondition(
    report.compatible &&
      !report.ownerActive &&
      !report.controlSocketPresent &&
      !report.missing.length &&
      !report.repositoryErrors.length &&
      !report.configurationMismatch,
    "STATE_BLOCKED",
    "Backup requires a compatible stopped state, no socket, and all registered roots; inspect preflight",
  );
  requireCondition(
    Object.values(report.integrity ?? {}).every((v) => v === "ok"),
    "STATE_BLOCKED",
    "Database integrity check failed",
  );
  requireCondition(
    !existsSync(output),
    "CONFLICT",
    "Backup destination already exists",
  );
  requireCondition(
    !report.backupRoots.some(
      (p) =>
        output === p ||
        output.startsWith(p + "/") ||
        p.startsWith(output + "/"),
    ),
    "FORBIDDEN",
    "Backup destination must be outside all source roots",
  );
  for (const p of report.backupRoots)
    requireCondition(
      realpathSync(p) === p,
      "FORBIDDEN",
      "Backup roots must be canonical, non-symlink paths",
    );
  const before = report.backupRoots.map((p) => inventory(p));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(output, "INCOMPLETE"),
    "Do not restore until manifest.json says complete\n",
    { mode: 0o600 },
  );
  for (const [i, p] of report.backupRoots.entries()) {
    cpSync(p, join(output, String(i)), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
    for (const item of before[i]!)
      if (item.mode !== undefined)
        chmodSync(join(output, String(i), item.path), item.mode);
    requireCondition(
      JSON.stringify(inventory(join(output, String(i)))) ===
        JSON.stringify(before[i]),
      "STATE_BLOCKED",
      "Backup copy verification failed",
    );
  }
  requireCondition(
    !preflight(state).ownerActive && !existsSync(join(state, "control.sock")),
    "STATE_BLOCKED",
    "Owner changed during backup",
  );
  requireCondition(
    report.backupRoots.every(
      (p, i) => JSON.stringify(inventory(p)) === JSON.stringify(before[i]),
    ),
    "STATE_BLOCKED",
    "Sources changed during backup; preserve incomplete backup and retry only after stopping writers",
  );
  const manifest = {
    format: 1,
    complete: true,
    createdAt: new Date().toISOString(),
    sourceState: resolve(state),
    schema: report.schema,
    roots: report.backupRoots.map((source, i) => ({
      source,
      directory: String(i),
      inventory: before[i],
    })),
    externalSymlinkTargetsCopied: false,
    restore:
      "Verify this manifest, stop all writers and restore each root to its original absolute path. Do not start two copies. Reconcile intervening native/external work. Symlink targets outside listed roots and OS Keychain secrets require separate preservation.",
  };
  writeFileSync(
    join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 },
  );
  unlinkSync(join(output, "INCOMPLETE"));
  return {
    destination: output,
    complete: true,
    manifest: join(output, "manifest.json"),
    warning:
      "Contains credentials and repository history. Verify manifest and file hashes before restore; missing completion manifest means incomplete backup.",
  };
}

export function verifyBackup(destination: string) {
  const output = resolve(destination),
    manifest = json(join(output, "manifest.json"));
  requireCondition(
    manifest.format === 1 &&
      manifest.complete === true &&
      Array.isArray(manifest.roots),
    "INVALID_INPUT",
    "Incomplete or unsupported backup manifest",
  );
  const roots = manifest.roots.map(
    (r: { directory: string; source: string; inventory: unknown }) => {
      requireCondition(
        /^\d+$/.test(r.directory),
        "INVALID_INPUT",
        "Invalid backup directory",
      );
      try {
        return {
          source: r.source,
          valid:
            JSON.stringify(inventory(join(output, r.directory))) ===
            JSON.stringify(r.inventory),
        };
      } catch (error) {
        return { source: r.source, valid: false, reason: String(error) };
      }
    },
  );
  return {
    readOnly: true,
    complete: roots.every((r: { valid: boolean }) => r.valid),
    roots,
    restore: manifest.restore,
    warning:
      "This checks file integrity against an unsigned local manifest, not the authenticity of an untrusted backup or absence of intervening native effects.",
  };
}
