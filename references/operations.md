# Team operations

All commands below use `node "$SKILL_DIR/scripts/cat.mjs"` and accept `--state DIR`. Default state: `~/.cat/team`. Use dedicated short paths because macOS Unix sockets are length-limited. Beta 3 uses capability-based CLI admission, with no exact release pin. Versions and protocol fingerprints are diagnostic evidence; missing required capabilities block startup. Published Beta 2 retains its historical pin.

For repository coding, initialize a new opt-in workspace using [coding operations](coding.md). Existing text-only teams keep their permissions.

## Identity, output, and retries

- `root --name NAME --task TEXT --key KEY` returns a stable Agent ID. `--task-file PATH` reads UTF-8 literally. Same key and content returns the existing operation; changed content is rejected.
- `tree` / `list` returns all Agents. Filter by `tree_id` when multiple roots share a Coordinator. `status --target ID` includes binding/Thread, last 20 attempts with `state` and `result`, last 50 messages, execution, budget, and runtime block. Use `events --target ID` for causal records and errors.
- A first delegation Turn can complete before child results arrive. Team completion requires the requested synthesis, no outstanding descendant work, and processed relevant receipts. A successful submission means acceptance, not completed analysis.
- `send --target ID --message TEXT --key KEY` adds human input and wakes an eligible Agent. Managed `agent_send` derives the sender from its actual Thread/Turn; it cannot forge an operator message.

Message states describe consumption, not business task completion: `queued` → `delivering` → explicit `acknowledged` → `processed` when that Turn succeeds. A processed message may have delegated work to a child that is still running. Explicit Task completion and dependency checks are separate records, described below; evaluate the reported output and descendant work as well. Failure/interruption without a conclusive successful receipt leaves `unknown`, not a fabricated success.

Messages accepted by current source use one durable FIFO enqueue sequence across human and Agent sources; request retries keep their original position. Migration preserves historical timestamp/ID ordering because the original cross-source insertion order cannot be recovered.

Bodies are limited to 12000 UTF-16 code units and must be well-formed Unicode without disallowed controls. Batches hold up to 20 messages and 44000 serialized characters. An oversized historical row becomes `rejected` before delivery; its original body remains stored, and `events` contains `message.delivery_rejected` with the ID and reason. Later queued messages can proceed. This is a visible terminal delivery failure, not successful consumption or automatic task cancellation.

## Explicit task board

Task state is `pending` → `in_progress` → `completed`, with `deleted` tombstones. Turn completion and message acknowledgment never complete a Task. Required dependencies must be completed before claim/assignment or completion. A ready task does not wake an Agent or reserve a Turn; use delegation/messages to arrange execution.

```sh
node "$SKILL_DIR/scripts/cat.mjs" task-create --target ROOT_ID --key calc --subject Calculate --description 'Six racks with seven packets each'
node "$SKILL_DIR/scripts/cat.mjs" task-list --target ROOT_ID
node "$SKILL_DIR/scripts/cat.mjs" task-get --target ROOT_ID --task-id TASK_ID
node "$SKILL_DIR/scripts/cat.mjs" task-update --target ROOT_ID --task-id TASK_ID --key claim-calc --revision 1 --action claim
node "$SKILL_DIR/scripts/cat.mjs" task-update --target ROOT_ID --task-id TASK_ID --key finish-calc --revision 2 --action complete --result '42 packets'
```

`--target` selects a tree and, for operator-created/claimed work, the represented Agent. Model tools derive identity from the authenticated Thread/Turn; no caller ID is accepted. `agent_task_create/get/list/update` expose the same domain operations on newly created Threads. Existing Threads keep their original native tool catalog; use the operator CLI or continue their message workflow rather than replacing bindings.

Creation accepts `--blocked-by '["TASK_ID"]'` and `--write-scopes '["src"]'`. Create/update alternatively accept `--input-file /absolute/path/input.json` with tool-shaped fields (`requestKey`, `taskId`, `expectedRevision`, `action`, etc.); do not mix file input with field flags. No shell evaluation is performed on file contents. There are at most 256 active (pending/in-progress) tasks per tree, 32 blockers and 16 relative scope prefixes per task; subject is limited to 200, description/result to 8000 UTF-16 code units. Scope overlap warnings are advisory, with no filesystem locking or write authority.

Every mutation requires a request key, scoped to tree and caller. Retrying identical input/key returns the original response snapshot without another event; changed input with that key is rejected. Every update requires the current revision (CLI `--revision`, tool `expectedRevision`). On `STALE_REVISION`, fetch current state and reconsider the mutation before submitting a new operation. An idempotent replay may contain an old revision or derived `ready`; use `task-get` for current state.

Any member may claim ready unowned work within its tree. Other mutations require its owner or a management ancestor of the owner (creator when unowned); the trusted operator may override. `assign --owner-id ID` is limited to the model caller's subtree; `--owner-id null` releases ownership. Human pause fences remain intact; running paused Turns may drain metadata, while cancelled/terminated model callers cannot mutate tasks. Owners are not automatically released after cancellation or failure: the operator must inspect and reassign intentionally.

`release` returns in-progress work to pending. `edit` changes subject/description/scopes. `set_dependencies --blocked-by JSON` changes unfinished task blockers and rejects missing/cross-tree/deleted references, duplicates and cycles. `complete --result TEXT` is an authorized assertion, not proof of result quality. `reopen` clears a completed task's owner/result; first release or reopen any started/completed dependents. `delete` keeps a tombstone and fails if a nondeleted task still depends on it. `task-list` omits tombstones and truncates descriptions/results; `task-get` returns the full record.

## Compact view and event waiting

```sh
node "$SKILL_DIR/scripts/cat.mjs" view --target ROOT_ID
node "$SKILL_DIR/scripts/cat.mjs" wait --target ROOT_ID --after CURSOR --timeout-ms 25000
```

`view` returns compact Agents, task summaries, budget, message counts, progress diagnosis and a durable tree cursor. `wait` is an operator command, not a managed-Agent tool: it waits for committed SQLite events without occupying model capacity. The timeout defaults to 25000 ms, range 0–30000; disconnect cancels the waiter. It returns at most 100 event metadata rows (no bodies), the latest view, a top-level continuation `cursor`, `hasMore` and a reason:

- `changed`: consume the page, then use its top-level cursor for the next call. The nested latest `view.cursor` may be ahead; skipping to it would skip pages.
- `timedOut`: no matching event before the deadline; continue waiting if needed.
- `noProgress`: current scheduler state cannot progress without input/control; inspect `view.reasons`, tasks and native status. This diagnosis is advisory, not completion or failure proof. Do not repeatedly wait on an idle tree or bypass a human fence.
- `stopped`: Coordinator shutdown; view is null. Restart/reconcile before continuing.

Events already committed after a cursor are returned immediately; unrelated tree commits do not finish a wait or reset its deadline. Cursors persist across Coordinator restart. A cursor ahead of the current database is rejected; read a fresh view after restoring a backup. Detailed payloads remain available through `events`. Task edits and waiting do not trigger model calls on their own.

## Execution limits and token policy

Interactive root defaults: depth 2, 20 Agents, concurrency 3, unlimited cumulative Turns. Batch keeps 20 Turns per Agent / 100 per tree. Finite explicit limits are admission gates. Depth starts at zero; Agent count is lifetime accepted members, including terminated ones. `--max-turns` applies per Agent; `--max-total-turns` counts all prepared Turns in the tree, including later failures, interruptions and cancelled unsent attempts. Counts survive restart; cancellation never refunds a Turn. A prepared Turn already owns its slot and can finish dispatch when the limit is reached. Limits do not stop a currently executing Turn mid-flight.

`status` and `view` expose `executionLimits` with used/remaining tree Turns and structural bounds. `tree-turn-limit` means no further Turns or new children can be admitted. Inspect the requested result and queued work, then report the limit; do not create another root or clear a human fence to evade it.

New trees default to `--token-policy observe`. `--tokens 5000000` is a usage warning threshold; `--reserve 5000` remains an accounting estimate, not an admission gate. Child `tokens` is optional and does not transfer capacity in this mode. Legacy token hints are accepted but ignored for allocation; child `capacity` remains zero. Token overruns and another Agent's unsettled usage do not block new work. Unknown execution still blocks its own Agent, occupies concurrency, and is never automatically replayed.

```sh
# Default: structure and Turn counts constrain execution; token usage is observed.
node "$SKILL_DIR/scripts/cat.mjs" root --name Lead --key review-001 --max-agents 3 --max-total-turns 12 --task-file /absolute/path/task.txt
# Optional: task-wide soft pause budget, without per-Agent allocation.
node "$SKILL_DIR/scripts/cat.mjs" root --name Lead --key budgeted-001 --task-token-budget 600000 --task-file /absolute/path/task.txt
```

In `enforce`, child allocation transfers from the parent, each Turn reserves budget before dispatch, and unresolved terminal usage blocks new consumption. Allocation (`Agent.capacity`), reservation/liability (`reserved`) and charged usage (`spent`, `accounting.charged`) remain distinct. This is the prior budget protocol, not a hard runtime or provider-billing cap. This protocol is retained only for existing enforce states; new public roots do not enable it. Model tools cannot change it or execution limits. Existing trees without a policy retain `enforce`, with their implicit tree Turn bound derived from maxAgents × maxTurnsPerAgent.

Both policies preserve native observations and deduplicate cumulative usage. New observe-mode roots have no Agent allocations; availableTokens is null, and usage reminders are independent of budget arithmetic. Use status/view tokenUsage and usage.reminder events; see [token reminders](../docs/token-reminders.md). Existing enforce states retain their ledger and admission constraints. Task soft budgets and lifecycle fences remain separate.

When a hard limit blocks progress, reduce delegation, synthesize available results or report blocked work. Do not invent final usage or discard unknown state. Historical usage and human settlement records remain available in both policies.

## Human control

`control --target ID --action pause|resume|cancel|terminate [--scope agent|subtree]` defaults to subtree.

| Action | Effect |
| --- | --- |
| pause | Fence future dispatch/spawn; drain running Turns; queue messages. |
| resume | Clear the applicable human fence and dispatch eligible work. |
| cancel | Cancel queued work and request interruption of active Turns. |
| terminate | Permanent termination; retain identity/history/audit. |

An interruption request is not confirmation of stopping. Only confirmed unconsumed child capacity is refunded. Models cannot clear human fences or call settlement/quarantine operator endpoints. Approvals are declined and logged; no interactive approval queue is included.

## Historical alpha.4 upgrade from alpha.2 / alpha.3

Alpha.4 migrates the business database to schema 6, preserving Agents, bindings, messages and budget. This is one-way; older versions refuse schema 6. Existing trees keep their original enforce policy; only new trees default to observe. Stop the Coordinator before replacing source, back up the stopped state directory including any SQLite sidecars, and keep the dedicated runtime home. Do not run old/new Coordinators together or overwrite an active installation. Restart with the existing state so native history is reconciled. Rollback requires the matching pre-upgrade backup and careful reconciliation of any native work executed since it was taken.

## Recovery and shutdown

`stop` stops the Coordinator and closes its control socket. It leaves the dedicated official daemon and accepted native Turns alive. `start` claims exclusive ownership, reconnects Threads, and reconciles history before dispatching. Closing the invoking CLI stops neither service.

For full shutdown, pause/drain or cancel the requested tree, inspect native execution and costs, stop the Coordinator, then run `CODEX_HOME="$RUNTIME" codex app-server daemon stop` for the dedicated runtime home. Never stop the user's ordinary Codex daemon. Stopping a daemon may interrupt work; it does not delete auth or business records. Keep state for later resumption; remove a dedicated auth copy only when retiring that service.

Use `status`, `events`, `native-history --target ID` for diagnosis. For startup errors, run `serve --state DIR` in the foreground; `start` detaches output. Do not run a second Coordinator for the same state. A missing socket does not prove accepted work was lost.

An accepted Turn with a lost reply is adopted only from its known Turn ID or unique attempt marker. Completion events trigger reinspection when history was initially incomplete. Ambiguous history remains unknown; no blind resend. Old connection/binding generations cannot mutate current execution. Foreign native work quarantines dispatch.

`release-quarantine --target ID --reason TEXT` requires human-reviewed history proving no active Turn. It does not resolve unknown attempts, mark messages completed, or erase cost. Do not use merely to unblock a task.

`settle-usage --attempt ID --tokens FINAL_TOTAL --reason TEXT` records an operator-attested final amount after native history confirms a terminal Turn and idle Thread. It cannot be below observed/charged usage. Original observations and provenance remain; late reports reconcile their coverage with later Turns without duplicating a cumulative prefix. Use an actually verified amount, never an invented one. No model tool exposes this command.

## Current scope

The coding runtime targets macOS arm64, Node ≥26.3.1 and one credential domain (file-backed login or an explicitly selected provider secret). CLI admission checks required protocol capabilities, without a release-number or contract-hash allowlist. Lead terminal, scoped file tools and isolated multi-repository worktrees are supported; merging remains an explicit Lead action. Full Linux/Windows coding isolation, multi-machine scheduling and a GUI are not qualified. Budget controls cannot promise exact provider billing; recovery cannot promise exactly-once external effects. The operator CLI is trusted local control, not an isolation boundary against arbitrary code run as that OS user.

## Usage evidence reconciliation

Beta 3 upgrades to schema 13, adding durable work-scope epochs and replacement receipts alongside an immutable workspace registry and per-Agent repository grants/worktree ownership. Existing coding states retain their original single-repository layout. Multi-repository teams require a new state; see [coding operations](coding.md#multiple-repositories). Native cumulative samples and human final receipts are stored separately, then attributed in Turn order. A missing final notification no longer makes the next Turn charge an already attested difference again. Late evidence may decrease a later Turn's attributed amount while preserving every native fact and receipt. Missing evidence retains unknown liability; contradictory evidence rolls back rather than fabricating a zero cost. See the [reconciliation contract](https://github.com/SteveTanSaMa/Codex-Agent-Tree/blob/main/docs/usage-reconciliation.md).

Stop and back up the complete state before upgrading. Beta 4 candidate uses schema 15; Beta 3 and older source refuse the upgraded database. Migration reconstructs retained events and preserves lower bounds where evidence is unavailable; conflicting evidence refuses migration. Restore the matching backup for rollback, with reconciliation of any intervening native work.

## Changing the Codex executable

Changing `config.json.executable` does not replace the package retained by the official managed daemon. A compatible launcher can pass `doctor` while `start` refuses a different running/managed package. Do not bypass that check or run an updater automatically on a startup failure.

When the operator explicitly selects a new executable: pause the whole tree, interrupt or drain accepted work, and inspect native history plus unknown command/guidance receipts. Stop the Coordinator and back up complete state and runtime home after all native Turns are terminal. Then explicitly update **only the dedicated runtime home's** package from the selected CLI:

```sh
CODEX_HOME="$RUNTIME" "$SELECTED_CODEX" app-server daemon update --from-cli --yes
```

For environment-backed providers, make the existing selected credential available to that command without printing it. For Keychain-backed providers, use an authenticated credential-loading launcher; do not start the new daemon without its configured secret. Update the team's executable path, rerun `doctor --state "$STATE"`, and start/reconcile the same state. Preserve the old paused state until identity, history and queues are checked. If evidence remains unknown, retain it for review instead of replaying work. A rollback requires the matching stopped backup and reconciliation of any intervening native effects.

## Third-party provider configuration

Use a dedicated runtime home and explicitly select a trusted provider config and credential source. The config must declare the matching provider `env_key` and Responses API; use capability admission and reconcile active native work before changing the running daemon binary. Configured model names do not independently prove a provider's underlying routing.

```sh
node "$SKILL_DIR/scripts/cat.mjs" init --state "$STATE" --runtime-home "$RUNTIME" \
  --config-from /absolute/path/provider/config.toml \
  --provider-env COMMAND_CODE_API_KEY \
  --keychain-service codex-cli-command-code \
  --executable /absolute/path/to/codex
node "$SKILL_DIR/scripts/cat.mjs" doctor --state "$STATE"
node "$SKILL_DIR/scripts/cat.mjs" start --state "$STATE"
```

`--keychain-service` is optional and macOS-only: it reads an existing generic password for the current OS user, without creating or changing it. Without that option, set the named credential variable in the environment that launches `start` or `serve`. Variable names must be uppercase and end in KEY or TOKEN. Only this explicitly selected secret is forwarded alongside the existing base/proxy/CA environment; unrelated secrets remain excluded. Missing credentials fail closed. `doctor --state` checks the selected executable and reports the credential source without reading or printing its value; successful doctor alone does not verify model authentication.

`--config-from` copies the selected TOML with private permissions; it refuses different existing runtime config. It suppresses the default App auth.json copy; use `--auth-from` explicitly if this provider also requires file-backed auth. State stores only the credential variable/service names and executable path. The default file-auth path remains available when provider flags are omitted. Shell aliases/functions are not executables: select the actual binary, not the shell function name. Keep state/runtime paths short for Unix sockets.


Operator `settle-usage` now retains a verified receipt as `pending` when preceding evidence prevents safe application. Pending is not finalized and does not release liability. Subsequent compatible receipts/native samples and restart reevaluate it automatically; no resubmission is required. `status.attempts[].usageReceipts` exposes pending/applied evidence. Contradictory evidence stays pending; inspect it instead of inventing another amount. The strict internal settlement operation still refuses erasing native facts.

## Explicit Turn limit changes

New interactive teams default to unlimited lifetime Turns; `--mode batch` retains 20 per Agent and 100 per tree. For explicit finite/unlimited settings, `root --max-turns unlimited --max-total-turns unlimited` stores JSON null as an actual disabled ceiling. `status.executionLimits.remainingTurns` is then null. Agent count, depth, concurrent Turns, token policy and all lifecycle/reconciliation fences continue to apply. Agents cannot alter these limits themselves.

For an existing tree:

```sh
node "$SKILL_DIR/scripts/cat.mjs" limits --state "$STATE" --target ROOT_ID \
  --max-turns unlimited --max-total-turns unlimited --reason 'Explicit user authorization'
# Change the lifetime member ceiling without changing Turn limits:
node "$SKILL_DIR/scripts/cat.mjs" limits --state "$STATE" --target ROOT_ID \
  --max-agents 20 --reason 'Explicit user authorization'
```

Finite integers may also be supplied. The transaction preserves every used Turn, Agent, native binding, and request key, refuses limits below retained usage, and emits `limits.updated` with before/after/reason. Repeating identical values is a no-op. Omit a flag to retain its current value. This operator endpoint does not grant model-callable quota modification.

`--max-agents` accepts a positive integer, never `unlimited`, and cannot be lower than lifetime accepted membership, including terminated Agents. The default for new teams is 20; existing teams retain their stored ceiling until explicitly changed.

`--offline` acquires normal database ownership and refuses a live Coordinator. It is intended for a deliberately stopped service, including upgrading an older service that lacks the online endpoint. Do not restart a working team merely to adjust a ceiling before it matters: wait for a safe execution boundary, preserve queued work, then stop/update/start the same state. A disabled ceiling removes the automatic Turn-count stopping condition; task completion and structural/lifecycle constraints still govern execution.

## Interactive guidance and protection

Read [interactive control](../docs/interactive-control.md) for current-Turn guidance, stable-key retries, unknown delivery review, immediate pause, tree-wide autonomy clocks and optional soft task budgets. Old trees retain policy and limits. Schema 12 requires a stopped-state backup before upgrade.

### Upgrading an existing team

1. Run `doctor --state "$STATE"` and inspect `tree`, unknown Attempts, pending messages and active commands. Stop accepting new operator work during the handover. Prefer an idle boundary; `stop` alone leaves accepted native work alive.
2. Run `stop`, then verify the old Coordinator has exited and its control socket is gone. Back up the entire stopped state directory, including any SQLite sidecars and worktrees. Retain the dedicated runtime home and a copy of its configuration; protect backups like the original state.
3. If changing the selected executable, qualify its capabilities in a separate environment first. An old `expectedVersion` config field is ignored by current main. Never switch a live daemon underneath accepted work; settle or quarantine native execution first. Do not change credentials, provider, model or workspace grants to force startup.
4. Start the same state with the new source. Compare stable Agent IDs, binding Thread IDs/generations, historical Attempt IDs, counters and workspace files against the backup. Review reconciliation errors and unknown evidence before dispatching tests. Old policy and limits remain intact; enabling interactive policy or changing reminders is a separate explicit operator action.
5. Validate with bounded work, then check restart continuity and reminder/event cursors. An interrupted Turn without final usage must retain unknown accounting. Do not replay it or invent a final receipt merely to clean the display.

Schema 13 is one-way. Rollback requires the matching old source and pre-upgrade state backup, with reconciliation of any native work accepted after that backup. Never restore the old database over a live Coordinator or run both versions as owners. See the [existing-team validation](../docs/upgrade-validation.md) for the tested scope and retained uncertainty.

## Scope replacement

Beta 3 adds operator-only subtree replacement (schema 13). The published Beta 2 ZIP does not contain this command. Ordinary `steer` changes current input; pause drains and retains queues. Neither automatically retracts descendant assignments.

Read `status.workScope.generation`, then submit a replacement with that exact generation and a stable key:

```sh
node "$SKILL_DIR/scripts/cat.mjs" status --state "$STATE" --target ROOT_ID
node "$SKILL_DIR/scripts/cat.mjs" scope-replace --state "$STATE" --target ROOT_ID --generation 0 --key change-001 --task-file /absolute/path/new-task.txt
```

Retry an uncertain request with the same key, generation and text. A changed key is a new request; a stale generation fails. The immutable `receipt` identifies the accepted replacement; `state`, `attempts`, `commands` and `blocks` report current draining progress. `status.workScope.replacement` provides subsequent progress. Once `ready`, new input may be scheduled, subject to existing controls and budgets; ready is not task completion.

Replacement advances each existing member's work generation and withdraws queued human/Agent inputs, including queued reports sent by affected members to other branches. Prepared unsent Turns are cancelled without refunding lifetime Turn counts. Running/starting/unknown Turns retain their actual states for native reconciliation. Their subsequent tool requests are rejected as withdrawn work; already accepted external effects cannot be undone. Delivered but unconsumed inputs remain unknown rather than becoming successful receipts.

The target receives the new assignment; existing descendants wait for explicit new assignments rather than automatically repeating their old initial tasks. Old unfinished Tasks owned by affected members, and unowned Tasks created by them, become immutable deleted records. Completed Tasks and work owned outside the subtree are retained. Create new Tasks for the new objective. Pauses and termination remain in effect; replacement does not bypass them. A terminated target cannot be replaced; terminated descendants stay terminated. New work continues existing Native Threads, whose historical context is not erased.

Choose Root to replace the entire team's objective. Replacing only a child subtree does not revoke an outside parent's authority to send new work afterward. A newly accepted replacement renews the human autonomy check-in epoch once, while task-wide totals/budgets and usage reminders remain intact; retrying its receipt does not renew that epoch again.

An old Turn, unknown guidance, quarantined native execution or unresolved command receipt keeps the replacement draining. Use `native-history`, events and existing guidance/quarantine review procedures. Withdrawn guidance cannot use `retry-next` to reenter a new scope. If a command's outcome cannot be recovered, an operator may explicitly acknowledge having inspected its effects and stopped any surviving process:

```sh
node "$SKILL_DIR/scripts/cat.mjs" command-review --state "$STATE" --target AGENT_ID --call-id NATIVE_CALL_ID --reason 'Inspected effects and verified no process remains; final outcome unknown'
```

This is available only after native execution is settled and no host command is running. It records `reviewed-unknown`, retains unknown outcome and usage, and permits draining to finish. It does not report success, enable replay or undo effects. The same review/reason is idempotent. Managed Agents cannot perform this operator review.

Managed `agent_status`, `agent_list` and control responses use tool contract v2: message bodies, assignment text and Attempt input previews are omitted. Formally delivered input supplies message content. Operator diagnostics retain previews. Existing Thread history is not redacted by this change.

Managed Attempt results are previews capped at 2,000 characters with `resultTruncated`; operator status retains the original result. Budget diagnostics list at most 100 unknown-usage Attempt IDs, with the full `unknownUsageAttemptCount` and `unknownUsageTruncated` flag. Liability and admission still use the complete accounting state; the preview limit does not settle or discard unknown costs. Retained events provide the complete Attempt trace.

范围替换为操作者专用：使用当前代际和固定 key 提交，旧队列被撤销，旧执行先中断/对账，新工作随后准入。子节点等待新分配，人工暂停、永久终止、历史计数和未知用量均不重置。`ready` 表示排空完成，不表示业务任务完成；`reviewed-unknown` 只是人工确认已检查未知命令，不是成功收据，也不允许重放。


## Beta 4 candidate: archive, diagnosis and handoff

Completion automatically archives a task in the same transaction. `status` remains `completed`; `archivedAt` is separate metadata, not a deletion. Completed blockers still satisfy dependencies. Reopen clears archive metadata and consumes active capacity; it fails at 256 active tasks or when started dependents require the completed result. Migration archives legacy completed tasks at migration time without changing their updatedAt, historical receipts or events. Old idempotency keys return their original response; use task-get for current state.

`agent_task_list` and view show the active board (up to the existing 256-task limit). Legacy operator task-list retains its nondeleted-history array. Use bounded history with `task-history --target ID --after 0 --limit 50`; follow nextCursor until null. task-get includes archives and tombstones. Never delete evidence merely to free capacity.

`diagnose --state DIR` opens SQLite read-only, acquires no Coordinator lease, performs no migration, and reports unknown Attempts/commands, evidence locations and worktree marker gaps. Keep a backup. For unknown execution, compare native-history Turn IDs and attempt markers, then reconnect/start for conservative reconciliation. Ambiguous outcomes stay unknown; neither usage settlement nor release-quarantine proves execution completion. For command receipts, inspect processes, diffs and output before explicit command-review with a factual reason; it records uncertainty and never reruns the command. For incomplete worktrees, preserve tracked diffs and untracked files, compare `git worktree list --porcelain` with config.json and completion markers, and provision a fresh authorized workspace for reviewed transfer. No automatic marker repair or identity adoption is supported.

`handoff-record --target SOURCE_ID --input-file JSON` and `handoff-preview --target LEAD_ID --id ID` use the authenticated control channel. Model tools are agent_handoff and agent_handoff_preview. Record repositoryId, full baseCommit, optional full commit, dependsOn handoff IDs and a validation declaration. Omitting commit snapshots the tracked diff plus up to 16 regular UTF-8 untracked files, combined content up to 64 KiB. Protected paths, symlinks, hardlinks and oversized untracked files are rejected. Use a committed handoff for larger/binary assets. A commit handoff requires clean source HEAD matching the recorded commit and baseline ancestry.

Preview checks changed target baseline, source scope generation, dirty target, dependencies and possible merge conflicts or patch applicability; file bundles also report name collisions. Validation is explicitly agent-declared, not independently certified. Review the immutable artifact, integrate through an explicitly authorized Lead operation, then run target tests. Preview never merges, applies or provisions a missing worktree; Git inspection uses a private sandbox profile. Patch dependencies require manual verification. Cross-repository steps are independent commits, not an atomic transaction. Existing Threads keep their original native tool catalog; operator CLI commands work without rebinding business identity, while new Threads receive new tools.

交接输入示例 / Handoff input example (omit `commit` to capture a bounded patch):

```json
{"requestKey":"module-v1","repositoryId":"app","baseCommit":"FULL_BASE_SHA","commit":"FULL_CHANGE_SHA","dependsOn":[],"validation":"Declared: unit tests passed; evidence path and command"}
```

完成自动归档、重新打开占用容量；历史和删除记录用分页查询。诊断只读且不迁移，不把未知结果当成失败后可重试。交接预览不应用补丁、不合并；Lead 需审查依赖、基线和冲突后显式整合并独立验证。升级 schema 15 前备份整个 state，降级恢复旧备份；已有 Thread 不会自动换工具目录。

Current candidate adds retained commit bundles and operator integration receipts (schema 15), structured preview failures, capacity/export and stopped backup commands. See [maintenance and durable handoff](../docs/maintenance-and-handoff.md) for bilingual procedures and limits.

当前候选补齐持久提交包、整合回执、预览失败分类及维护命令，详见上述双语操作文档；旧 release 不变。
