import { createHash, randomUUID } from "node:crypto";
import { requireCondition, text } from "../core/errors.ts";
import type { Store } from "../storage/store.ts";
import type { WorkspaceBroker } from "./broker.ts";
/** Operator-authenticated receipt, no command execution and no code application. */
export function recordIntegration(
  store: Store,
  broker: WorkspaceBroker,
  target: string,
  input: Record<string, unknown>,
) {
  const agent = store.agent(target);
  requireCondition(
    agent.depth === 0 &&
      agent.desired !== "terminated" &&
      !store.scopes.blocked(target) &&
      !store.runtimeBlock(target),
    "FORBIDDEN",
    "Integration recording requires an unfenced Lead",
  );
  requireCondition(
    Object.keys(input).every((k) =>
      [
        "requestKey",
        "handoffId",
        "repositoryId",
        "targetBaseline",
        "integrationCommit",
        "appliedArtifact",
        "status",
        "validation",
        "commandCallId",
      ].includes(k),
    ),
    "INVALID_INPUT",
    "Unknown integration field",
  );
  const key = text(input.requestKey, "requestKey", 128);
  const handoffId = text(input.handoffId, "handoffId", 128);
  const row = store.db
    .prepare("SELECT body FROM handoffs WHERE id=? AND tree_id=?")
    .get(handoffId, agent.tree_id);
  requireCondition(row, "NOT_FOUND", "Handoff not found in caller tree");
  const handoff = JSON.parse(String(row.body));
  const repo = broker.selection(agent, input.repositoryId);
  requireCondition(
    repo.id === handoff.repositoryId,
    "INVALID_INPUT",
    "Integration repository must match the handoff",
  );
  const base = text(input.targetBaseline, "targetBaseline", 64);
  const commit =
    input.integrationCommit === undefined
      ? null
      : text(input.integrationCommit, "integrationCommit", 64);
  requireCondition(
    /^[a-f0-9]{40,64}$/.test(base) &&
      (commit === null || /^[a-f0-9]{40,64}$/.test(commit)),
    "INVALID_INPUT",
    "Full commit hashes required",
  );
  const appliedArtifact =
    input.appliedArtifact === undefined
      ? null
      : text(input.appliedArtifact, "appliedArtifact", 2000);
  requireCondition(
    commit || appliedArtifact,
    "INVALID_INPUT",
    "Specify integrationCommit or actual applied artifact description",
  );
  const status = input.status ?? "unverified";
  requireCondition(
    typeof status === "string" &&
      ["success", "failed", "unverified"].includes(status),
    "INVALID_INPUT",
    "Invalid integration status",
  );
  const validation = input.validation as Record<string, unknown>;
  requireCondition(
    validation &&
      typeof validation === "object" &&
      !Array.isArray(validation) &&
      Object.keys(validation).every((k) =>
        ["command", "result", "evidence"].includes(k),
      ),
    "INVALID_INPUT",
    "Independent validation declaration required",
  );
  const declaration = {
    command: text(validation.command, "validation command", 4000),
    result: text(validation.result, "validation result", 4000),
    evidence: text(validation.evidence, "validation evidence location", 2000),
  };
  const callId =
    input.commandCallId === undefined
      ? null
      : text(input.commandCallId, "commandCallId", 256);
  const canonical = {
    handoffId,
    repositoryId: repo.id,
    targetBaseline: base,
    integrationCommit: commit,
    appliedArtifact,
    status,
    validation: declaration,
    commandCallId: callId,
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
  const prior = store.db
    .prepare(
      "SELECT fingerprint,body FROM integration_results WHERE agent_id=? AND request_key=?",
    )
    .get(target, key);
  if (prior) {
    requireCondition(
      prior.fingerprint === fingerprint,
      "CONFLICT",
      "Integration request key changed content",
    );
    return JSON.parse(String(prior.body));
  }
  const facts: Record<string, unknown> = {
    scopeGeneration: store.scopes.epoch(target).generation,
    observedAt: new Date().toISOString(),
    validationExecutedByThisOperation: false,
  };
  try {
    broker.inspectGit(agent, repo.id, ["cat-file", "-e", base + "^{commit}"]);
    facts.targetHead = broker.inspectGit(agent, repo.id, ["rev-parse", "HEAD"]);
    facts.targetDirty = !!broker.inspectGit(agent, repo.id, [
      "status",
      "--porcelain",
    ]);
    if (commit) {
      broker.inspectGit(agent, repo.id, [
        "cat-file",
        "-e",
        commit + "^{commit}",
      ]);
      facts.baselineAncestor =
        broker.inspectGit(agent, repo.id, ["merge-base", base, commit]) ===
        base;
      facts.integrationIsCurrentHead = facts.targetHead === commit;
    }
    facts.inspectionComplete = true;
  } catch (error) {
    facts.inspectionComplete = false;
    facts.inspectionError = String(error).slice(0, 4000);
  }
  if (callId) {
    const receipt = store.db
      .prepare(
        "SELECT state,result_json,created_at FROM workspace_commands WHERE agent_id=? AND call_id=?",
      )
      .get(target, callId);
    requireCondition(
      receipt,
      "NOT_FOUND",
      "Command receipt not found for target Lead",
    );
    facts.commandReceipt = {
      ...receipt,
      result:
        receipt.result_json == null
          ? null
          : JSON.parse(String(receipt.result_json)),
    };
    facts.commandAssociation =
      "Receipt existence/outcome only; declared command, repository, commit and evidence association are not host-certified";
  }
  const record = {
    id: randomUUID(),
    agentId: target,
    treeId: agent.tree_id,
    ...canonical,
    statusSource: "operator-declared",
    validationSource: "operator-declared-independent-check",
    hostFacts: facts,
    hostVerifiedSuccess: false,
    createdAt: new Date().toISOString(),
  };
  return store.saveIntegration(target, key, fingerprint, record);
}
export function integrationHistory(
  store: Store,
  target: string,
  after = 0,
  limit = 50,
) {
  const agent = store.agent(target);
  requireCondition(
    Number.isSafeInteger(after) &&
      after >= 0 &&
      Number.isSafeInteger(limit) &&
      limit >= 1 &&
      limit <= 100,
    "INVALID_INPUT",
    "Invalid integration page",
  );
  const rows = store.db
    .prepare(
      "SELECT rowid AS cursor,body FROM integration_results WHERE tree_id=? AND rowid>? ORDER BY rowid LIMIT ?",
    )
    .all(agent.tree_id, after, limit + 1);
  const selected: typeof rows = [];
  let bytes = 0;
  for (const row of rows.slice(0, limit)) {
    const size = Buffer.byteLength(String(row.body));
    if (selected.length && bytes + size > 1024 * 1024) break;
    selected.push(row);
    bytes += size;
  }
  return {
    items: selected.map((r) => JSON.parse(String(r.body))),
    nextCursor: rows.length > selected.length ? selected.at(-1)!.cursor : null,
    byteLimited: selected.length < Math.min(limit, rows.length),
  };
}
