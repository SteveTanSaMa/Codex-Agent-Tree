import { sha256File } from "../core/file-hash.ts";
import { lstatSync } from "node:fs";
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
  const id = randomUUID();
  const artifact =
    commit === undefined
      ? undefined
      : broker.retainHandoff(agent, repo.id, id, commit);
  const record = {
    id,
    ...(artifact ? { artifact } : {}),
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
  const issues: string[] = [];
  const checks: {
    name: string;
    status: string;
    code?: string;
    message?: string;
  }[] = [];
  let targetHead: string | null = null;
  let merge = "";
  function check<T>(name: string, action: () => T): T {
    try {
      const value = action();
      checks.push({ name, status: "passed" });
      return value;
    } catch (error) {
      const e = error as Error & {
        code?: string;
        status?: number;
        stderr?: string | Buffer;
      };
      const detail = (String(e.stderr ?? "") + " " + e.message).slice(0, 4000);
      const code =
        name === "baseline-ancestry" && e.status === 1
          ? "invalid-baseline"
          : e.code === "FORBIDDEN"
            ? "permission-restricted"
            : e.code === "STATE_BLOCKED"
              ? "workspace-blocked"
              : /not a valid object|bad object|invalid object|not a valid commit|could not get object|unknown revision/i.test(
                    detail,
                  )
                ? "object-missing"
                : /not a git repository|cannot change to|ENOENT|no such file/i.test(
                      detail,
                    )
                  ? "repository-unavailable"
                  : /permission denied|operation not permitted/i.test(detail)
                    ? "permission-restricted"
                    : "git-check-failed";
      checks.push({ name, status: "incomplete", code, message: detail });
      throw error;
    }
  }
  const retention = record.commit
    ? artifactStatus(record.artifact)
    : { status: "embedded-patch" };
  try {
    const repo = check("repository-grant", () =>
      broker.selection(agent, record.repositoryId),
    );
    targetHead = check("target-head", () =>
      broker.inspectGit(agent, repo.id, ["rev-parse", "HEAD"]).trim(),
    );
    for (const [name, sha] of [
      ["baseline", record.baseCommit],
      ...(record.commit ? [["change", record.commit]] : []),
    ])
      check(name + "-object", () =>
        broker.inspectGit(agent, repo.id, [
          "cat-file",
          "-e",
          sha + "^{commit}",
        ]),
      );
    if (record.commit) {
      const ancestor = check("baseline-ancestry", () =>
        broker
          .inspectGit(agent, repo.id, [
            "merge-base",
            record.baseCommit,
            record.commit,
          ])
          .trim(),
      );
      if (ancestor !== record.baseCommit) {
        issues.push("invalid-source-baseline");
        checks.push({
          name: "baseline-ancestry",
          status: "failed",
          code: "invalid-baseline",
        });
      }
    }
    if (targetHead !== record.baseCommit)
      issues.push("target-baseline-changed");
    if (
      store.scopes.epoch(record.agentId).generation !== record.scopeGeneration
    )
      issues.push("source-scope-withdrawn");
    if (
      check("target-status", () =>
        broker.inspectGit(agent, repo.id, ["status", "--porcelain"]).trim(),
      )
    )
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
      if (!v.commit) {
        issues.push("dependency-patch-requires-review:" + dep);
        continue;
      }
      const common = check("dependency:" + dep, () =>
        broker
          .inspectGit(agent, v.repositoryId, ["merge-base", "HEAD", v.commit])
          .trim(),
      );
      if (common !== v.commit) issues.push("dependency-not-integrated:" + dep);
    }
    if (record.artifactKind === "tracked-patch") {
      merge = record.patch;
      const targetNames = new Set(
        check(
          "target-files",
          () =>
            broker.inspectGit(agent, repo.id, ["ls-files", "-z"]) +
            "\0" +
            broker.inspectGit(agent, repo.id, [
              "ls-files",
              "--others",
              "--exclude-standard",
              "-z",
            ]),
        )
          .split("\0")
          .filter(Boolean),
      );
      for (const file of record.files ?? [])
        if (targetNames.has(file.path))
          issues.push("new-file-collision:" + file.path);
      if (record.patch) {
        try {
          check("patch-application", () =>
            broker.inspectGit(
              agent,
              repo.id,
              ["apply", "--check", "--whitespace=nowarn"],
              record.patch,
            ),
          );
        } catch (error) {
          const detail = String((error as { stderr?: unknown }).stderr ?? "");
          if (
            /patch failed|patch does not apply|already exists in working directory/i.test(
              detail,
            )
          ) {
            checks[checks.length - 1] = {
              name: "patch-application",
              status: "failed",
              code: "patch-conflict",
            };
            issues.push("patch-does-not-apply-cleanly");
          } else throw error;
        }
      }
    } else if (!issues.includes("invalid-source-baseline")) {
      check("protected-target-paths", () =>
        broker.assertHandoffPaths(
          agent,
          repo.id,
          record.baseCommit,
          targetHead!,
        ),
      );
      merge = check("merge-inspection", () =>
        broker.inspectGit(agent, repo.id, [
          "merge-tree",
          record.baseCommit,
          targetHead!,
          record.commit,
        ]),
      );
      if (/<{7}/.test(merge)) {
        issues.push("possible-merge-conflict");
        checks.push({
          name: "merge-conflict",
          status: "failed",
          code: "merge-conflict",
        });
      }
    }
  } catch (error) {
    if (!checks.some((c) => c.status === "incomplete"))
      checks.push({
        name: "unexpected-check",
        status: "incomplete",
        code: "check-failed",
        message: String(error).slice(0, 4000),
      });
  }
  if (record.commit && retention.status !== "verified")
    issues.push("retention-" + retention.status);
  const incomplete = checks.some((c) => c.status === "incomplete");
  return {
    readOnly: true,
    record,
    targetHead,
    issues,
    checks,
    retention,
    checkComplete: !incomplete,
    status: incomplete
      ? "incomplete"
      : issues.length
        ? "review-required"
        : "no-conflict-detected",
    mergePreview: merge.slice(0, 16000),
    truncated: merge.length > 16000,
    review: [
      "Review dependencies, baseline and declared validation; incomplete checks do not prove mergeability.",
      "Explicitly integrate in an authorized workspace and independently verify. No automatic merge or cross-repository atomicity.",
      "If objects are missing, verify the retained bundle checksum, then an operator may explicitly git bundle verify and git bundle unbundle it in the intended repository. No automatic import.",
    ],
    automaticMerge: false,
  };
}

export function artifactStatus(artifact?: { path: string; sha256: string }) {
  if (!artifact)
    return {
      status: "legacy-unretained",
      recovery:
        "SHA-only legacy record: preserve reachable source objects explicitly; no automatic backfill.",
    };
  try {
    const stat = lstatSync(artifact.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      return { status: "invalid-artifact-type" };
    const actual = sha256File(artifact.path);
    return {
      status: actual === artifact.sha256 ? "verified" : "checksum-mismatch",
      path: artifact.path,
      sha256: actual,
    };
  } catch (error) {
    return {
      status: "artifact-unavailable",
      path: artifact.path,
      reason: String(error),
    };
  }
}
