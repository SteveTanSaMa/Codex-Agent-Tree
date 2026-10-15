---
name: codex-agent-tree
description: Run durable, recursive Codex analysis teams with independent sessions, persistent messages, explicit tasks and dependencies, token budgets, and event waiting. Use when the user wants an asynchronous agent tree or wants to inspect, coordinate, or control an existing team.
---

# Codex Agent Tree

Use the bundled CLI to operate a persistent local team. Each managed Agent has its own Codex Thread; children can create children and messages wake idle recipients. The caller's current conversation remains the operator; it does not become the managed Root.

This alpha supports **macOS arm64, Node >=26.3.1, and exactly `codex-cli 0.162.0-alpha.17.2`**. Managed sessions are read-only, with shell and native subagents disabled. Give them the relevant text in their task; they cannot inspect the caller's files or write code. For repository editing, use the caller's normal tools and report this limitation instead of promising worktree isolation.

## Locate and prepare

Resolve `SKILL_DIR` from the directory containing this loaded `SKILL.md`, not the caller's working directory. Invoke all helpers by absolute path; quote paths and pass task text as a single argument or use `--task-file`.

```sh
node "$SKILL_DIR/scripts/cat.mjs" doctor
```

If only dependencies are missing, run `setup` (installs the locked production dependency with npm; no install scripts), then retry `doctor`. If the CLI version or platform differs, report the exact mismatch. Do not silently replace the user's Codex installation. Login requires a file-backed `auth.json` from `codex login`; never print credentials.

For a new team, choose dedicated short paths, for example `STATE="$HOME/.cat/team"`, `RUNTIME="$HOME/.cat/runtime"`. Reuse the user's existing team when requested. Never point the runtime home at their ordinary `CODEX_HOME`. `init` copies login into the dedicated home, leaves the source untouched, and refuses an already initialized state.

```sh
node "$SKILL_DIR/scripts/cat.mjs" init --state "$STATE" --runtime-home "$RUNTIME"
node "$SKILL_DIR/scripts/cat.mjs" start --state "$STATE"
```

## Delegate and retrieve

Translate the user's objective into a task containing the relevant input, expected output, child roles, and completion criteria. Include: delegate through `agent_spawn`; end the initial Turn after delegation; children report to their parent with `agent_send`; recipients explicitly `agent_ack` delivered messages and synthesize the actual reports. Managed Agents receive these tools automatically; they are not tools exposed in the operator's current chat.

For a modest two-level team, use the default 200000-token root pool; a child might receive 80000 tokens and its child 30000. Child allocations transfer from the parent's pool. Keep the tree as small as the task needs. The pool is admission/accounting control, not a provider billing cap.

```sh
node "$SKILL_DIR/scripts/cat.mjs" root --state "$STATE" --name Lead --key UNIQUE_TASK_KEY --task-file /absolute/path/task.txt --max-depth 2 --max-agents 3 --concurrent 2 --max-turns 6
node "$SKILL_DIR/scripts/cat.mjs" tree --state "$STATE"
node "$SKILL_DIR/scripts/cat.mjs" status --state "$STATE" --target ROOT_ID
```

Keep the returned stable Root ID and request key. Retry an uncertain submission with the **same key and identical content**, after inspecting existing state. A different task requires a different key.

`status` returns `attempts[].result`, binding/Thread IDs, messages, budget, and errors. An idle Root or the Root's first delegation response is not a finished team. Check descendants and queued messages, then read the Root's synthesis after its result message Turn completes. Prefer the compact `view` and cursor-based `wait` below to repeated status polling. On timeout, report current progress without claiming success or submitting a duplicate team. Continue monitoring when the user wants the completed result. For background-only requests, return the Root ID and query command once accepted.

## Explicit tasks and dependencies

Task tools add model round trips and repeated context usage, including cached input in native totals. Plan a sufficient pool before creating the team: the three-node, two-task acceptance workflow uses `--tokens 600000`, with 300000 allocated to B and 120000 from B to C. The CLI default stays 200000; do not increase or bypass a live pool to force completion.

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

A `processed` receipt confirms consumption in a successful Turn, not completion of a delegated task. If a message is `rejected`, report its ID and the `message.delivery_rejected` reason from `events`; later messages may still run. Include any positive `budget.excessLiabilityTokens` in the result as a budget warning, without describing it as exact provider billing.

## Operate an existing team

```sh
node "$SKILL_DIR/scripts/cat.mjs" send --state "$STATE" --target AGENT_ID --key UNIQUE_MESSAGE_KEY --message 'Additional input'
node "$SKILL_DIR/scripts/cat.mjs" control --state "$STATE" --target AGENT_ID --action pause
node "$SKILL_DIR/scripts/cat.mjs" control --state "$STATE" --target AGENT_ID --action resume
```

Control defaults to the entire subtree; use `--scope agent` for one node. Pause drains running Turns and retains incoming messages. `cancel` requests interruption and cancels queued work; `terminate` is permanent. Apply the user's requested scope. Closing a CLI leaves the team running. `stop` detaches the Coordinator and leaves the dedicated native daemon and accepted work alive; `start` reconciles before scheduling again. See [operations](references/operations.md) before shutdown, recovery, or final usage settlement.

Report the outcome, stable Root ID, actual result or pending state, and material errors/budget limitations. Do not describe accepted work as completed.
