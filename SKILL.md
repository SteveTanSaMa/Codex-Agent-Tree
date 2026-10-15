---
name: codex-agent-tree
description: Run durable, recursive Codex teams for analysis of supplied text, with independent sessions, persistent messages, token budgets, and pause/resume. Use when the user wants an asynchronous agent tree or wants to inspect or control an existing team.
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

`status` returns `attempts[].result`, binding/Thread IDs, messages, budget, and errors. An idle Root or the Root's first delegation response is not a finished team. Check descendants and queued messages in `tree`, then read the Root's synthesis after its result message Turn completes. Poll at a reasonable interval (e.g. five seconds), in bounded calls; on timeout, report the Root ID and current progress without claiming success or submitting a duplicate team. Continue monitoring when the user wants the completed result. For background-only requests, return the Root ID and query command once accepted.

If a Turn is `unknown`, quarantined, failed, or has unsettled cost, inspect `status`, `events`, and `native-history`. Do not replay work, clear a quarantine, or invent a final usage amount to make progress. Read [operations](references/operations.md) for recovery and accounting.

## Operate an existing team

```sh
node "$SKILL_DIR/scripts/cat.mjs" send --state "$STATE" --target AGENT_ID --key UNIQUE_MESSAGE_KEY --message 'Additional input'
node "$SKILL_DIR/scripts/cat.mjs" control --state "$STATE" --target AGENT_ID --action pause
node "$SKILL_DIR/scripts/cat.mjs" control --state "$STATE" --target AGENT_ID --action resume
```

Control defaults to the entire subtree; use `--scope agent` for one node. Pause drains running Turns and retains incoming messages. `cancel` requests interruption and cancels queued work; `terminate` is permanent. Apply the user's requested scope. Closing a CLI leaves the team running. `stop` detaches the Coordinator and leaves the dedicated native daemon and accepted work alive; `start` reconciles before scheduling again. See [operations](references/operations.md) before shutdown, recovery, or final usage settlement.

Report the outcome, stable Root ID, actual result or pending state, and material errors/budget limitations. Do not describe accepted work as completed.
