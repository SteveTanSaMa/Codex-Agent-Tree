# Team operations

All commands below use `node "$SKILL_DIR/scripts/cat.mjs"` and accept `--state DIR`. Default state: `~/.cat/team`. Use dedicated short paths because macOS Unix sockets are length-limited. Tested protocol: `codex-cli 0.162.0-alpha.17.2`; do not change the pin without qualification.

## Identity, output, and retries

- `root --name NAME --task TEXT --key KEY` returns a stable Agent ID. `--task-file PATH` reads UTF-8 literally. Same key and content returns the existing operation; changed content is rejected.
- `tree` / `list` returns all Agents. Filter by `tree_id` when multiple roots share a Coordinator. `status --target ID` includes binding/Thread, last 20 attempts with `state` and `result`, last 50 messages, execution, budget, and runtime block. Use `events --target ID` for causal records and errors.
- A first delegation Turn can complete before child results arrive. Team completion requires the requested synthesis, no outstanding descendant work, and processed relevant receipts. A successful submission means acceptance, not completed analysis.
- `send --target ID --message TEXT --key KEY` adds human input and wakes an eligible Agent. Managed `agent_send` derives the sender from its actual Thread/Turn; it cannot forge an operator message.

## Budgets

Root defaults: `--tokens 200000 --max-depth 2 --max-agents 16 --concurrent 3 --max-turns 20 --reserve 5000`. Agent limits count lifetime accepted Agents; depth starts at zero. Child allocation transfers from the parent's pool. These are per-tree admission/accounting controls, not an account budget or a hard cap on an executing black-box Turn.

When admission fails, inspect remaining budget, reservations, depth/count/Turn limits; reduce delegation, synthesize available results, or report blocked state. Do not create another root to bypass the pool. Failed/interrupted Turns may have partial usage: liability remains until final usage is proven. Cumulative native observations are deduplicated; actual overruns remain visible.

## Human control

`control --target ID --action pause|resume|cancel|terminate [--scope agent|subtree]` defaults to subtree.

| Action | Effect |
| --- | --- |
| pause | Fence future dispatch/spawn; drain running Turns; queue messages. |
| resume | Clear the applicable human fence and dispatch eligible work. |
| cancel | Cancel queued work and request interruption of active Turns. |
| terminate | Permanent termination; retain identity/history/audit. |

An interruption request is not confirmation of stopping. Only confirmed unconsumed child capacity is refunded. Models cannot clear human fences or call settlement/quarantine operator endpoints. Approvals are declined and logged; no interactive approval queue is included.

## Recovery and shutdown

`stop` stops the Coordinator and closes its control socket. It leaves the dedicated official daemon and accepted native Turns alive. `start` claims exclusive ownership, reconnects Threads, and reconciles history before dispatching. Closing the invoking CLI stops neither service.

For full shutdown, pause/drain or cancel the requested tree, inspect native execution and costs, stop the Coordinator, then run `CODEX_HOME="$RUNTIME" codex app-server daemon stop` for the dedicated runtime home. Never stop the user's ordinary Codex daemon. Stopping a daemon may interrupt work; it does not delete auth or business records. Keep state for later resumption; remove a dedicated auth copy only when retiring that service.

Use `status`, `events`, `native-history --target ID` for diagnosis. For startup errors, run `serve --state DIR` in the foreground; `start` detaches output. Do not run a second Coordinator for the same state. A missing socket does not prove accepted work was lost.

An accepted Turn with a lost reply is adopted only from its known Turn ID or unique attempt marker. Completion events trigger reinspection when history was initially incomplete. Ambiguous history remains unknown; no blind resend. Old connection/binding generations cannot mutate current execution. Foreign native work quarantines dispatch.

`release-quarantine --target ID --reason TEXT` requires human-reviewed history proving no active Turn. It does not resolve unknown attempts, mark messages completed, or erase cost. Do not use merely to unblock a task.

`settle-usage --attempt ID --tokens FINAL_TOTAL --reason TEXT` records an operator-attested final amount after native history confirms a terminal Turn and idle Thread. It cannot be below observed/charged usage. Original observations and provenance remain; late reports add only an uncharged difference. Use an actually verified amount, never an invented one. No model tool exposes this command.

## Current scope

Validated on macOS arm64, Node 26.3.1, one file-backed login domain, fixed Codex alpha. No managed shell/file inspection, parallel repository writes, worktrees, merge automation, full DAG, multi-machine scheduler, or GUI. Budget controls cannot promise exact provider billing; recovery cannot promise exactly-once external effects. The operator CLI is trusted local control, not an isolation boundary against arbitrary code run as that OS user.
