import type { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
export function worktreeDiagnosis(db: DatabaseSync, state: string) {
  state = realpathSync(state);
  const malformedMarkers: string[] = [],
    configurationIssues: string[] = [];
  type Candidate = {
    path: string;
    markers: { path: string; identity: Record<string, unknown> }[];
    expected?: Record<string, unknown>;
    sources: string[];
  };
  const candidates = new Map<string, Candidate>();
  const add = (path: string, source: string) => {
    const key = resolve(path),
      prior = candidates.get(key) ?? { path: key, markers: [], sources: [] };
    prior.sources.push(source);
    candidates.set(key, prior);
    return prior;
  };
  function scanMarkers(dir: string) {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) scanMarkers(path);
      else if (e.isFile())
        try {
          const identity = JSON.parse(readFileSync(path, "utf8"));
          if (!identity || typeof identity.path !== "string")
            throw new Error("marker path missing");
          add(identity.path, "completion-marker").markers.push({
            path,
            identity,
          });
        } catch {
          malformedMarkers.push(path);
        }
      else malformedMarkers.push(path);
    }
  }
  scanMarkers(join(state, "worktree-ready"));
  let config: Record<string, any> = {};
  if (existsSync(join(state, "config.json")))
    try {
      config = JSON.parse(readFileSync(join(state, "config.json"), "utf8"));
    } catch {
      configurationIssues.push("config-json-invalid");
    }
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => String(r.name)),
  );
  const registry = tables.has("workspace_registry")
    ? db
        .prepare("SELECT policy FROM workspace_registry WHERE singleton=1")
        .get()
    : undefined;
  const policy = registry
    ? JSON.parse(String(registry.policy))
    : config.workspace;
  // Compare deeply, independent of key ordering.
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
  if (
    registry &&
    config.workspace &&
    JSON.stringify(stable(policy)) !== JSON.stringify(stable(config.workspace))
  )
    configurationIssues.push(
      "config-workspace-differs-from-persisted-registry",
    );
  if (policy) {
    const repos = policy.repositories ?? { default: policy };
    const agents = db.prepare("SELECT id,parent_id,depth FROM agents").all();
    const byId = new Map(agents.map((a) => [String(a.id), a]));
    const assignments = new Map(
      tables.has("agent_workspaces")
        ? db
            .prepare("SELECT agent_id,assignment FROM agent_workspaces")
            .all()
            .map((r) => [String(r.agent_id), JSON.parse(String(r.assignment))])
        : [],
    );
    for (const agent of agents) {
      const id = String(agent.id),
        assignment = assignments.get(id);
      let owner = agent;
      const seen = new Set<string>();
      while (
        (assignments.get(String(owner.id))?.worktree === "inherit" ||
          (!assignments.has(String(owner.id)) && Number(owner.depth) > 1)) &&
        owner.parent_id &&
        !seen.has(String(owner.id))
      ) {
        seen.add(String(owner.id));
        const parent = byId.get(String(owner.parent_id));
        if (!parent) break;
        owner = parent;
      }
      for (const repositoryId of assignment?.repositoryIds ??
        Object.keys(repos)) {
        const repo = repos[repositoryId];
        if (
          !repo ||
          typeof repo.repository !== "string" ||
          (policy.repositories && typeof repo.directory !== "string")
        ) {
          configurationIssues.push(
            "assignment-repository-missing:" + id + ":" + repositoryId,
          );
          continue;
        }
        const root = Number(owner.depth) === 0;
        const path = root
          ? repo.repository
          : policy.repositories
            ? join(state, "workspaces", String(owner.id), repo.directory)
            : join(state, "workspaces", String(owner.id));
        const item = add(path, "persisted-workspace-assignment");
        item.expected = {
          path,
          baseCommit: repo.baseCommit,
          ...(policy.repositories
            ? {
                repositoryId,
                repository: repo.repository,
                ownerAgentId: owner.id,
              }
            : {}),
        };
        if (root) item.sources.push("original-repository");
      }
    }
  }
  function scan(dir: string, depth = 0) {
    if (!existsSync(dir) || depth > 2) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (!e.isDirectory()) {
        if (e.isSymbolicLink()) add(path, "residual-symlink");
        continue;
      }
      if (candidates.has(resolve(path)) || existsSync(join(path, ".git"))) {
        add(path, "directory-scan");
        continue;
      }
      if (!policy?.repositories || depth >= 1) {
        add(path, "residual-directory-without-git");
        continue;
      }
      const children = readdirSync(path, { withFileTypes: true });
      // Preserve owner containers; identify early empty leaf directories too.
      if (!children.some((c) => c.isDirectory()))
        add(path, "residual-directory-without-git");
      else scan(path, depth + 1);
    }
  }
  scan(join(state, "workspaces"));
  const worktrees = [...candidates.values()].map((c) => {
    const stat = lstatSync(c.path, { throwIfNoEntry: false }),
      reasons: string[] = [];
    const marker = c.markers[0];
    const original = c.sources.includes("original-repository");
    if (!stat)
      reasons.push(
        marker ? "marker-directory-missing" : "workspace-not-provisioned",
      );
    else if (!stat.isDirectory() || stat.isSymbolicLink())
      reasons.push("unexpected-workspace-type");
    else if (!existsSync(join(c.path, ".git")))
      reasons.push("directory-without-git");
    if (stat && !marker && !original) reasons.push("completion-marker-missing");
    if (marker && !c.expected) reasons.push("unregistered-marker-identity");
    if (
      marker &&
      c.expected &&
      Object.entries(c.expected).some(([k, v]) => marker.identity[k] !== v)
    )
      reasons.push("marker-identity-mismatch");
    if (c.markers.length > 1) reasons.push("duplicate-markers");
    return {
      ...c,
      marker: marker?.path ?? null,
      reasons,
      reason:
        reasons.join("; ") || "metadata-consistent-git-identity-not-verified",
      evidence: {
        registry: "workspace_registry.policy",
        assignments: "agent_workspaces.assignment",
        config: join(state, "config.json"),
      },
      recovery:
        !stat && !marker
          ? "May be normally unprovisioned. Inspect events before normal scheduling; no directory was created by diagnosis."
          : "Preserve all files, markers and Git administrative entries. Compare persisted identity, config and git worktree list --porcelain; do not manufacture markers, remove directories or auto-adopt. If incomplete, transfer a reviewed salvage patch to a fresh authorized workspace; respect lifetime limits.",
    };
  });
  return { worktrees, malformedMarkers, configurationIssues };
}
