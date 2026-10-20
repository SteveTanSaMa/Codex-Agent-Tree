import { createHash, randomUUID } from "node:crypto";
import { requireCondition, text } from "../core/errors.ts";
import type { Store } from "../storage/store.ts";
import type { WorkspaceBroker } from "./broker.ts";
export function handoff(
  store: Store,
  broker: WorkspaceBroker,
  agentId: string,
  input: Record<string, unknown>,
) {
  const agent = store.agent(agentId);
  requireCondition(
    agent.desired === "active" &&
      !store.runtimeBlock(agentId) &&
      !store.scopes.blocked(agentId),
    "STATE_BLOCKED",
    "Handoff source is fenced",
  );
  requireCondition(
    Object.keys(input).every((k) =>
      [
        "requestKey",
        "repositoryId",
        "baseCommit",
        "commit",
        "dependsOn",
        "validation",
      ].includes(k),
    ),
    "INVALID_INPUT",
    "Unknown handoff field",
  );
  const key = text(input.requestKey, "requestKey", 128);
  const repo = broker.selection(agent, input.repositoryId);
  const base = text(input.baseCommit, "baseCommit", 64),
    commit =
      input.commit === undefined ? undefined : text(input.commit, "commit", 64);
  requireCondition(
    /^[a-f0-9]{40,64}$/.test(base) &&
      (commit === undefined || /^[a-f0-9]{40,64}$/.test(commit)),
    "INVALID_INPUT",
    "Handoff requires full commit hashes",
  );
  const depends = input.dependsOn ?? [];
  requireCondition(
    Array.isArray(depends) &&
      depends.length <= 32 &&
      depends.every((d) => typeof d === "string" && d.length <= 128),
    "INVALID_INPUT",
    "Invalid handoff dependencies",
  );
  const validation = text(input.validation, "validation declaration", 8000);
  const canonical = {
    repositoryId: repo.id,
    baseCommit: base,
    ...(commit === undefined ? {} : { commit }),
    dependsOn: depends,
    validation,
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
  const prior = store.db
    .prepare("SELECT * FROM handoffs WHERE agent_id=? AND request_key=?")
    .get(agentId, key);
  if (prior) {
    requireCondition(
      prior.fingerprint === fingerprint,
      "CONFLICT",
      "Handoff request key changed content",
    );
    return JSON.parse(String(prior.body));
  }
  broker.assertHandoffPaths(agent, repo.id, base, commit);
  let patch: string | undefined;
  let files: { path: string; content: string; sha256: string }[] = [];
  if (commit !== undefined) {
    requireCondition(
      broker.inspectGit(agent, repo.id, ["merge-base", base, commit]).trim() ===
        base,
      "CONFLICT",
      "Baseline is not an ancestor of change commit",
    );
    requireCondition(
      broker.inspectGit(agent, repo.id, ["rev-parse", "HEAD"]).trim() ===
        commit,
      "CONFLICT",
      "Commit is not the current source HEAD",
    );
    requireCondition(
      !broker.inspectGit(agent, repo.id, ["status", "--porcelain"]).trim(),
      "STATE_BLOCKED",
      "Commit handoff requires a clean source checkout",
    );
  } else {
    requireCondition(
      broker.inspectGit(agent, repo.id, ["rev-parse", "HEAD"]).trim() === base,
      "CONFLICT",
      "Patch baseline must match source HEAD",
    );
    files = broker.handoffFiles(agent, repo.id);
    patch = broker.inspectGit(agent, repo.id, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      base,
      "--",
    ]);
    requireCondition(
      Buffer.byteLength(patch) +
        files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) <=
        65536,
      "INVALID_INPUT",
      "Patch exceeds 64 KiB; use a committed handoff",
    );
  }
  const record = {
    id: randomUUID(),
    agentId,
    treeId: agent.tree_id,
    scopeGeneration: store.scopes.epoch(agentId).generation,
    workspace: broker.cwd(agent, repo.id),
    ...canonical,
    files,
    artifactKind: commit === undefined ? "tracked-patch" : "commit",
    ...(patch === undefined
      ? {}
      : {
          patch,
          patchSha256: createHash("sha256").update(patch).digest("hex"),
        }),
    createdAt: new Date().toISOString(),
    validationSource: "agent-declared-not-independent",
  };
  return store.saveHandoff(agentId, key, fingerprint, record);
}

export function previewHandoff(
  store: Store,
  broker: WorkspaceBroker,
  target: string,
  id: string,
) {
  const agent = store.agent(target);
  const row = store.db
    .prepare("SELECT body FROM handoffs WHERE id=? AND tree_id=?")
    .get(id, agent.tree_id);
  requireCondition(row, "NOT_FOUND", "Handoff not found in caller tree");
  const record = JSON.parse(String(row.body));
  const repo = broker.selection(agent, record.repositoryId);
  const head = broker.inspectGit(agent, repo.id, ["rev-parse", "HEAD"]).trim();
  const issues: string[] = [];
  if (head !== record.baseCommit) issues.push("target-baseline-changed");
  if (store.scopes.epoch(record.agentId).generation !== record.scopeGeneration)
    issues.push("source-scope-withdrawn");
  if (broker.inspectGit(agent, repo.id, ["status", "--porcelain"]).trim())
    issues.push("target-worktree-dirty");
  for (const dep of record.dependsOn) {
    const d = store.db
      .prepare("SELECT body FROM handoffs WHERE id=? AND tree_id=?")
      .get(dep, agent.tree_id);
    if (!d) {
      issues.push("missing-dependency:" + dep);
      continue;
    }
    const v = JSON.parse(String(d.body));
    try {
      if (!v.commit) {
        issues.push("dependency-patch-requires-review:" + dep);
        continue;
      }
      const common = broker
        .inspectGit(agent, v.repositoryId, ["merge-base", "HEAD", v.commit])
        .trim();
      if (common !== v.commit) issues.push("dependency-not-integrated:" + dep);
    } catch {
      issues.push("dependency-unavailable:" + dep);
    }
  }
  let merge = "";
  if (record.artifactKind === "tracked-patch") {
    merge = record.patch;
    const targetNames = new Set(
      (
        broker.inspectGit(agent, repo.id, ["ls-files", "-z"]) +
        "\0" +
        broker.inspectGit(agent, repo.id, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ])
      )
        .split("\0")
        .filter(Boolean),
    );
    for (const file of record.files ?? [])
      if (targetNames.has(file.path))
        issues.push("new-file-collision:" + file.path);
    try {
      if (record.patch)
        broker.inspectGit(
          agent,
          repo.id,
          ["apply", "--check", "--whitespace=nowarn"],
          record.patch,
        );
    } catch {
      issues.push("patch-does-not-apply-cleanly");
    }
  } else {
    try {
      broker.assertHandoffPaths(agent, repo.id, record.baseCommit, head);
    } catch {
      issues.push("protected-target-changes-require-human-review");
      return {
        readOnly: true,
        record,
        targetHead: head,
        issues,
        automaticMerge: false,
      };
    }
    merge = broker.inspectGit(agent, repo.id, [
      "merge-tree",
      record.baseCommit,
      head,
      record.commit,
    ]);
    if (/<{7}|changed in both/.test(merge))
      issues.push("possible-merge-conflict");
  }
  return {
    readOnly: true,
    record,
    targetHead: head,
    issues,
    mergePreview: merge.slice(0, 16000),
    truncated: merge.length > 16000,
    review: [
      "Review dependency order, base-to-change diff and declared validation evidence.",
      "Commit or preserve target edits before integration.",
      "Explicitly cherry-pick/merge only after review, then run target tests. Cross-repository steps are separate commits; no atomic merge is promised.",
    ],
    automaticMerge: false,
  };
}
