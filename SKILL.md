---
name: codex-agent-tree
description: Run durable, recursive Codex analysis and coding teams with independent sessions, persistent messages, explicit tasks and dependencies, usage reminders, optional task budgets, and event waiting. Use when the user wants an asynchronous agent tree or wants to inspect, coordinate, or control an existing team.
---

# Codex Agent Tree

Use the bundled CLI to operate a persistent local team. Each managed Agent has its own Codex Thread; children can create children and messages wake idle recipients. The caller's current conversation remains the operator; it does not become the managed Root.

Qualified platform: **macOS arm64 and Node >=26.3.1**. Beta 3 admits Codex CLI by required protocol capabilities, without an exact release pin; 0.162.0-alpha.17.2 and 0.163.0-alpha.10.2 have native qualification evidence (see [qualification results](https://github.com/SteveTanSaMa/Codex-Agent-Tree/blob/main/docs/compatibility-recovery-results.md)). Teams default to text-only analysis. For a user-requested coding team, explicitly select clean committed repositories with `init --workspace PATH` (optional `--test-commands JSON`) or an operator-authored `--workspace-config JSON` manifest; first read [coding operations](references/coding.md). Lead receives an audited terminal, second-level members write isolated Git worktrees through restricted tools, and third-level members review read-only in inherited or explicitly isolated worktrees. Native shell and native subagents remain disabled. Do not retrofit permissions into an existing team's configuration.

## Locate and prepare

Resolve `SKILL_DIR` from the directory containing this loaded `SKILL.md`, not the caller's working directory. Invoke all helpers by absolute path; quote paths and pass task text as a single argument or use `--task-file`.

```sh
node "$SKILL_DIR/scripts/cat.mjs" doctor
```

If only dependencies are missing, run `setup` (installs the locked production dependency with npm; no install scripts), then retry `doctor`. If required CLI capabilities are missing or the platform is unsupported, report the specific diagnostic. Version differences alone do not block admission. Do not silently replace the user's Codex installation. If the user requests a binary change for an existing team, follow [changing the executable](references/operations.md#changing-the-codex-executable); the official daemon retains its own package even after its process stops. Default login uses a file-backed `auth.json` from `codex login`. For an explicitly requested third-party provider, use the dedicated config and credential options in [operations](references/operations.md#third-party-provider-configuration), then run `doctor --state "$STATE"` for its selected binary. Never print credentials or reuse the ordinary CODEX_HOME as the runtime home.

For a new team, choose dedicated short paths, for example `STATE="$HOME/.cat/team"`, `RUNTIME="$HOME/.cat/runtime"`. Reuse the user's existing team when requested. Never point the runtime home at their ordinary `CODEX_HOME`. `init` copies login into the dedicated home, leaves the source untouched, and refuses an already initialized state.

```sh
node "$SKILL_DIR/scripts/cat.mjs" init --state "$STATE" --runtime-home "$RUNTIME"
node "$SKILL_DIR/scripts/cat.mjs" start --state "$STATE"
```

## Coding teams

Use the coding workflow only for repository work authorized by the user. Keep state and runtime home outside the repository. Second-level worktrees start from the initialization commit; dependencies and ignored files are not copied. File writes can create missing parent directories within the workspace. Descendants cannot obtain terminal through a task or a prompt. Test commands are operator-authored fixed executable/argv entries, not model-supplied shell strings. Commands are sandboxed and bounded to 30 seconds. Networking defaults to denied; an operator may allow fixed loopback TCP endpoints for a named test. Terminal receives no such grant; inspect failures instead of weakening permissions.

Require coders to report actual diffs, worktree paths and test receipts. Lead reviews and integrates changes using `terminal`, then verifies in its own checkout. Third-level review is static unless the operator performs the test. On an uncertain command receipt, inspect its existing outcome; do not switch call IDs to bypass recovery. Retain worktrees until changes have been reviewed. See [coding operations](references/coding.md) for capabilities and limitations.

External files and toolchains require explicit operator-selected `readOnlyResources` in the new-team manifest; see [resource access](references/coding.md#external-read-only-resources). All team members can browse/read registered resources, but resources remain protected from writes even in Lead terminal. Do not use copied targets or wrapper commands to silently bypass missing authorization.

For multiple repositories, read the manifest and delegation examples in [coding operations](references/coding.md#multiple-repositories). Register each independent Git root, including sibling repositories below a non-Git parent. Delegate only the needed `repositoryIds`, select a primary `repositoryId`, and keep all paths and test commands operator-controlled. A secondary gets an isolated worktree per granted repository; deeper members inherit by default or request `worktree: "isolated"` while remaining read-only. Use `workspace_list` to inspect mappings. Independent worktrees start at pinned base commits and do not copy parent patches. Lead reviews and integrates each repository separately.

## Delegate and retrieve

Translate the user's objective into a task containing the relevant input, expected output, child roles, and completion criteria. Include: delegate through `agent_spawn`; end the initial Turn after delegation; children report to their parent with `agent_send`; recipients explicitly `agent_ack` delivered messages and synthesize the actual reports. Managed Agents receive these tools automatically; they are not tools exposed in the operator's current chat.

New teams use token observation by default: do not plan token transfers or require child `tokens`. Set structural limits suitable for the task: depth, lifetime Agent count and concurrent Turns. New teams default to interactive mode: depth 2, 20 Agents, 3 concurrent Turns, with unlimited lifetime Turns. `--mode batch` retains 20 Turns per Agent and 100 total; explicit Turn ceilings remain available. A small recursive team usually needs much less; these are ceilings, not targets. Lifetime counts include finished members and failed/interrupted/prepared Turns and survive restart.

```sh
node "$SKILL_DIR/scripts/cat.mjs" root --state "$STATE" --name Lead --key UNIQUE_TASK_KEY --task-file /absolute/path/task.txt --max-depth 2 --max-agents 3 --concurrent 2 --max-turns 6 --max-total-turns 12
node "$SKILL_DIR/scripts/cat.mjs" tree --state "$STATE"
node "$SKILL_DIR/scripts/cat.mjs" status --state "$STATE" --target ROOT_ID
```

Keep the returned stable Root ID and request key. Retry an uncertain submission with the **same key and identical content**, after inspecting existing state. A different task requires a different key.

`status` returns `attempts[].result`, binding/Thread IDs, messages, budget, and errors. An idle Root or the Root's first delegation response is not a finished team. Check descendants and queued messages, then read the Root's synthesis after its result message Turn completes. Prefer the compact `view` and cursor-based `wait` below to repeated status polling. On timeout, report current progress without claiming success or submitting a duplicate team. Continue monitoring when the user wants the completed result. For background-only requests, return the Root ID and query command once accepted.

## Interactive guidance and stopping

When the user revises a running managed task, forward the correction through the operator channel; acknowledging it only in this chat does not deliver it to the team. `send` defaults to live guidance for a running interactive Agent; use `--delivery queue` for later work. `steer` explicitly requests live guidance. Keep the same key/content on retry and inspect `status.interaction` for delivered/deferred/unknown; accepted input is not proof of compliance. Unknown delivery is never automatically replayed and blocks new Turns for that Agent until operator review. Existing teams without an interaction policy keep queue behavior.

Use `control --action pause --immediate` for an authorized immediate subtree stop; ordinary pause drains. Resume does not replay interrupted side effects. Interactive defaults warn after 15 minutes of autonomous work, 10 minutes without selected observable activity, or 8 consecutive identical tool rejections; automatic pauses and task budgets are opt-in. Only successful new human live guidance, explicit check-in or human resume renews autonomy, not task totals. Read [interactive control](docs/interactive-control.md) for policy configuration, delivery uncertainty, soft-budget limits and the bounded validation scope.

## Explicit tasks and dependencies

For an explicit replacement of a subtree's objective, use `scope-replace` with the current `status.workScope.generation`, a stable key and the replacement task; first read [scope replacement](references/operations.md#scope-replacement). Ordinary guidance does not revoke descendant work. Replacement withdraws old queued work and old Turn tool authority, interrupts accepted execution, and waits for reconciliation before new work. Existing descendants wait for new assignments; paused/terminated state and lifetime counts remain intact. Report `draining` with outstanding Attempts/commands/blocks; `ready` permits scheduling but does not prove task completion. Never replay unknown work to clear the barrier. Managed tool contract v2 omits message bodies, assignment text and input previews from status/list; formal delivered input remains the source of message content.

Turn ceilings can be explicitly disabled with `root --max-turns unlimited --max-total-turns unlimited`. To change an existing tree only on user authorization, use `limits --target ROOT_ID --max-turns unlimited --max-total-turns unlimited --reason TEXT`; counters and identities remain intact. `--offline` requires a stopped Coordinator and refuses a live owner. Read [operations](references/operations.md) before changing limits.

Use `limits --target ROOT_ID --max-agents 20 --reason TEXT` for an authorized change to an existing team's lifetime member ceiling. This positive integer includes terminated members and cannot be lower than retained membership; it does not change depth, concurrency or Turn ceilings.

New teams have no per-Agent token allocation. Default reminders fire once at 5000000 tree-wide total tokens; `token-reminder` configures per-Agent/tree single or incremental alerts using total, noncached input or output. Read [token reminders](docs/token-reminders.md) for commands and measurement limits. Surface `usage.reminder` events from wait/events once to the user; do not inject them into the managed dialogue. Alerts never pause or create Turns. Users may separately opt into task-wide soft budgets. Legacy enforce trees keep their constraints; never bypass them by recreating a root. Cached input is not a bill.

For delegated work with completion criteria, ask the managed Root to create tasks using `agent_task_create`, passing a stable `requestKey`, `subject`, `description`, and optional `blockedBy` task IDs. For example, create a calculation task and a verification task blocked by that calculation. Include task IDs and expected outputs in child assignments.

Members use `agent_task_get` / `agent_task_list`, then `agent_task_update` with `taskId`, `requestKey`, current `expectedRevision`, and an action. `claim` takes ready unowned work; `complete` explicitly supplies a nonempty `result`. Use a fresh operation key for each logical mutation, but retry an uncertain mutation with identical fields/key/revision. A replay returns the original response; get the task again for current state. On `STALE_REVISION`, read current state and decide whether the intended change still applies before using a new key.

Tasks do not start models. A member still ends its delegation Turn and reports actual results through `agent_send`; `agent_ack` consumes messages. For a finished task-board workflow, verify required tasks are explicitly completed and inspect full results with `agent_task_get` or operator `task-get`. Completion is an authorized assertion with a result, not automatic quality validation. Other actions and operator commands are documented in [operations](references/operations.md).

New task tools are registered on newly created native Threads. Existing teams retain their original native tool catalog and can continue the old message workflow; the operator CLI can manage their tasks. Do not replace an existing binding merely to add tools.

## Wait for progress

```sh
node "$SKILL_DIR/scripts/cat.mjs" view --state "$STATE" --target ROOT_ID
node "$SKILL_DIR/scripts/cat.mjs" wait --state "$STATE" --target ROOT_ID --after CURSOR --timeout-ms 25000
```

Take `CURSOR` from `view.cursor`, then from each wait response's **top-level** `cursor`. `changed` includes event metadata and the latest view; `hasMore` means read the next page using that cursor. `timedOut` means keep waiting if the user wants completion. `noProgress` means inspect `view.reasons`, task owners, fences, budget and unknown work; send needed input only within the user's task and with a stable message key. Do not repeatedly wait on an idle team or bypass a pause. `stopped` means the Coordinator is stopping. A cursor ahead of the database requires a fresh `view`.

Waiting is for the operator; do not instruct managed Agents to hold their native Turns open while waiting for children. A ready task or an idle team does not itself prove the objective completed.

If a Turn is `unknown`, quarantined, failed, or has unsettled cost, inspect `status`, `events`, and `native-history`. Do not replay work, clear a quarantine, or invent a final usage amount to make progress. Read [operations](references/operations.md) for recovery and accounting.

A `processed` receipt confirms consumption in a successful Turn, not completion of a delegated task. If a message is `rejected`, report its ID and the `message.delivery_rejected` reason from `events`; later messages may still run. Report `budget.warningExceeded` with `observedTokens` and `warningThresholdTokens`. Explain retained unknown usage separately. In enforce mode, also report positive `excessLiabilityTokens`; none of these numbers is exact provider billing.

## Operate an existing team

```sh
node "$SKILL_DIR/scripts/cat.mjs" send --state "$STATE" --target AGENT_ID --key UNIQUE_MESSAGE_KEY --message 'Additional input'
node "$SKILL_DIR/scripts/cat.mjs" control --state "$STATE" --target AGENT_ID --action pause
node "$SKILL_DIR/scripts/cat.mjs" control --state "$STATE" --target AGENT_ID --action resume
```

Control defaults to the entire subtree; use `--scope agent` for one node. Pause drains running Turns and retains incoming messages. `cancel` requests interruption and cancels queued work; `terminate` is permanent. Apply the user's requested scope. Closing a CLI leaves the team running. `stop` detaches the Coordinator and leaves the dedicated native daemon and accepted work alive; `start` reconciles before scheduling again. See [operations](references/operations.md) before shutdown, recovery, or final usage settlement.

Use `agent_handoff` to snapshot a commit or bounded patch/file bundle, and `agent_handoff_preview` to review it before integration. Completed tasks auto-archive; use task-get/history for retained results. For uncertain execution or incomplete worktrees, use the read-only `diagnose` command and the recovery procedure in operations.

Report the outcome, stable Root ID, actual result or pending state, and material errors/budget limitations. Do not describe accepted work as completed.

For upgrade preflight, verified stopped backups, capacity warnings, paged audit export and explicit integration receipts, read [maintenance and durable handoff](docs/maintenance-and-handoff.md). Preserve unknown outcomes; declared integration success is not host-certified verification.
