# Team operations

All commands below use `node "$SKILL_DIR/scripts/cat.mjs"` and accept `--state DIR`. Default state: `~/.cat/team`. Use dedicated short paths because macOS Unix sockets are length-limited. Tested protocol: `codex-cli 0.162.0-alpha.17.2`; do not change the pin without qualification.

## Identity, output, and retries

- `root --name NAME --task TEXT --key KEY` returns a stable Agent ID. `--task-file PATH` reads UTF-8 literally. Same key and content returns the existing operation; changed content is rejected.
- `tree` / `list` returns all Agents. Filter by `tree_id` when multiple roots share a Coordinator. `status --target ID` includes binding/Thread, last 20 attempts with `state` and `result`, last 50 messages, execution, budget, and runtime block. Use `events --target ID` for causal records and errors.
- A first delegation Turn can complete before child results arrive. Team completion requires the requested synthesis, no outstanding descendant work, and processed relevant receipts. A successful submission means acceptance, not completed analysis.
- `send --target ID --message TEXT --key KEY` adds human input and wakes an eligible Agent. Managed `agent_send` derives the sender from its actual Thread/Turn; it cannot forge an operator message.

Message states describe consumption, not business task completion: `queued` → `delivering` → explicit `acknowledged` → `processed` when that Turn succeeds. A processed message may have delegated work to a child that is still running. Explicit Task completion and dependency checks are separate records, described below; evaluate the reported output and descendant work as well. Failure/interruption without a conclusive successful receipt leaves `unknown`, not a fabricated success.

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

Creation accepts `--blocked-by '["TASK_ID"]'` and `--write-scopes '["src"]'`. Create/update alternatively accept `--input-file /absolute/path/input.json` with tool-shaped fields (`requestKey`, `taskId`, `expectedRevision`, `action`, etc.); do not mix file input with field flags. No shell evaluation is performed on file contents. There are at most 256 nondeleted tasks per tree, 32 blockers and 16 relative scope prefixes per task; subject is limited to 200, description/result to 8000 UTF-16 code units. Scope overlap warnings are advisory, with no filesystem locking or write authority.

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

## Budgets

Root defaults: `--tokens 200000 --max-depth 2 --max-agents 16 --concurrent 3 --max-turns 20 --reserve 5000`. Agent limits count lifetime accepted Agents; depth starts at zero. Child allocation transfers from the parent's pool. These are per-tree admission/accounting controls, not an account budget or a hard cap on an executing black-box Turn.

When admission fails, inspect remaining budget, reservations, depth/count/Turn limits; reduce delegation, synthesize available results, or report blocked state. Do not create another root to bypass the pool. Failed/interrupted Turns may have partial usage: liability remains until final usage is proven. Cumulative native observations are deduplicated; actual overruns remain visible. Native totals include cached input: repeated Task tool calls can consume substantially more cumulative tokens than a short message-only workflow. The three-node/two-task acceptance case explicitly uses a 600000-token pool (B: 300000, C: 120000 from B); this is not a price estimate or a guarantee for arbitrary prompts. Plan the pool before root creation; a budget-blocked team must not be silently replaced to bypass its limits.

Keep allocation (`Agent.capacity`, transferred on delegation), reservation/liability (`reserved`), and observed/charged usage (`attempt.observed`, `accounting.charged`, Agent `spent`) distinct. `budget.availableTokens` is the tree's arithmetic unencumbered balance; other gates may still block admission. `budget.excessLiabilityTokens` reports positive `spent + reserved - tokens`, including retained liability; it is not a provider invoice. When native usage changes the tree from within budget to excess liability, `budget.tree_overcommitted` persists the warning. Duplicate usage does not duplicate the threshold warning. This visibility does not stop an already executing Turn at a hard limit.

## Human control

`control --target ID --action pause|resume|cancel|terminate [--scope agent|subtree]` defaults to subtree.

| Action | Effect |
| --- | --- |
| pause | Fence future dispatch/spawn; drain running Turns; queue messages. |
| resume | Clear the applicable human fence and dispatch eligible work. |
| cancel | Cancel queued work and request interruption of active Turns. |
| terminate | Permanent termination; retain identity/history/audit. |

An interruption request is not confirmation of stopping. Only confirmed unconsumed child capacity is refunded. Models cannot clear human fences or call settlement/quarantine operator endpoints. Approvals are declined and logged; no interactive approval queue is included.

## Upgrading from alpha.2

Alpha.3 migrates the business database from schema 4 to 5, preserving Agents, bindings, messages and budget. This is one-way; alpha.2 refuses schema 5. Stop the Coordinator before replacing source, back up the stopped state directory including any SQLite sidecars, and keep the dedicated runtime home. Do not run old/new Coordinators together or overwrite an active installation. Restart with the existing state so native history is reconciled. Rollback requires the matching pre-upgrade backup and careful reconciliation of any native work executed since it was taken.

## Recovery and shutdown

`stop` stops the Coordinator and closes its control socket. It leaves the dedicated official daemon and accepted native Turns alive. `start` claims exclusive ownership, reconnects Threads, and reconciles history before dispatching. Closing the invoking CLI stops neither service.

For full shutdown, pause/drain or cancel the requested tree, inspect native execution and costs, stop the Coordinator, then run `CODEX_HOME="$RUNTIME" codex app-server daemon stop` for the dedicated runtime home. Never stop the user's ordinary Codex daemon. Stopping a daemon may interrupt work; it does not delete auth or business records. Keep state for later resumption; remove a dedicated auth copy only when retiring that service.

Use `status`, `events`, `native-history --target ID` for diagnosis. For startup errors, run `serve --state DIR` in the foreground; `start` detaches output. Do not run a second Coordinator for the same state. A missing socket does not prove accepted work was lost.

An accepted Turn with a lost reply is adopted only from its known Turn ID or unique attempt marker. Completion events trigger reinspection when history was initially incomplete. Ambiguous history remains unknown; no blind resend. Old connection/binding generations cannot mutate current execution. Foreign native work quarantines dispatch.

`release-quarantine --target ID --reason TEXT` requires human-reviewed history proving no active Turn. It does not resolve unknown attempts, mark messages completed, or erase cost. Do not use merely to unblock a task.

`settle-usage --attempt ID --tokens FINAL_TOTAL --reason TEXT` records an operator-attested final amount after native history confirms a terminal Turn and idle Thread. It cannot be below observed/charged usage. Original observations and provenance remain; late reports add only an uncharged difference. Use an actually verified amount, never an invented one. No model tool exposes this command.

## Current scope

Validated on macOS arm64, Node 26.3.1, one file-backed login domain, fixed Codex alpha. No managed shell/file inspection, parallel repository writes, worktrees, merge automation, automatic DAG execution, multi-machine scheduler, or GUI. Budget controls cannot promise exact provider billing; recovery cannot promise exactly-once external effects. The operator CLI is trusted local control, not an isolation boundary against arbitrary code run as that OS user.
