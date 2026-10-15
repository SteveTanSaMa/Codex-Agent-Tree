# Codex Agent Tree

[简体中文](README.md) · English

An installable Codex Skill for delegating supplied-text analysis to independent Codex sessions that can recursively create child agents. It persists identities, messages, explicit tasks, budgets and execution records. Teams keep running after the invoking CLI exits; messages wake eligible idle agents, and the Coordinator reconciles native history before scheduling after a restart.

**Version `0.1.0-alpha.3`: validated only on macOS arm64, Node ≥26.3.1 and exactly `codex-cli 0.162.0-alpha.17.2`, with one credential domain and read-only tasks.** Managed agents have no shell, cannot inspect the caller's repository, and do not support concurrent code changes or automatic merges. Supply the relevant text in the task. Your current Codex conversation operates the team; the managed Root is a separate session.

## Install

Clone into your skills directory; the destination must not already exist:

```sh
git clone https://github.com/SteveTanSaMa/Codex-Agent-Tree.git "${CODEX_HOME:-$HOME/.codex}/skills/codex-agent-tree"
```

Alternatively, ask the built-in installer to use its download method:

```text
$skill-installer Install the root Skill from SteveTanSaMa/Codex-Agent-Tree with path ., name codex-agent-tree, and method download.
```

Avoid the installer's Git sparse-checkout method for this root-level Skill: it can omit source subdirectories. If Python cannot find its CA certificates, use the ordinary `git clone` above; do not disable certificate verification.

Use `$codex-agent-tree` in a new conversation. The repository root is the complete Skill, containing `SKILL.md` and its helpers; no separate MCP server is required.

Prepare Node and the exact Codex CLI version above, then complete file-backed login with `codex login`. This project does not replace your Codex installation. Install runtime dependencies and check prerequisites:

```sh
SKILL_DIR="${CODEX_HOME:-$HOME/.codex}/skills/codex-agent-tree"
node "$SKILL_DIR/scripts/cat.mjs" setup
node "$SKILL_DIR/scripts/cat.mjs" doctor
```

`setup` runs locked `npm ci --omit=dev --ignore-scripts` inside the Skill, installing only the runtime dependency `ws`. `doctor` makes no model calls. The [alpha release ZIP](https://github.com/SteveTanSaMa/Codex-Agent-Tree/releases/tag/v0.1.0-alpha.3) contains the same self-contained Skill without dependency caches or credentials; extract it and run `setup`.

## Use

Give Codex a task and its source text:

```text
$codex-agent-tree Review the following proposal with a small team: Lead creates a risk analyst, who creates a budget checker. Return reports through the parent chain and synthesize the findings. Analyze only this text: [paste proposal]
```

You can also operate the CLI directly:

```sh
node "$SKILL_DIR/scripts/cat.mjs" init --state "$HOME/.cat/team" --runtime-home "$HOME/.cat/runtime"
node "$SKILL_DIR/scripts/cat.mjs" start --state "$HOME/.cat/team"
node "$SKILL_DIR/scripts/cat.mjs" root --name Lead --key review-001 --max-agents 3 --task-file /absolute/path/task.txt
node "$SKILL_DIR/scripts/cat.mjs" view --target ROOT_ID
node "$SKILL_DIR/scripts/cat.mjs" wait --target ROOT_ID --after CURSOR --timeout-ms 25000
node "$SKILL_DIR/scripts/cat.mjs" status --target ROOT_ID
```

`init` copies existing login credentials into a dedicated runtime home with mode 0600, preserving the original configuration, history and authentication. Use `--auth-from PATH` for another source. Choose dedicated short paths; never use your ordinary `CODEX_HOME` as the runtime home. State defaults to `~/.cat/team`; specify `--state` on every command when using another location.

Root creation returns a stable Agent ID. Results are in `status.attempts[].result`. An idle Root after its first delegation Turn does not mean the team has finished: inspect descendants and messages, then retrieve the Root's synthesis after child reports arrive. Retry uncertain requests with the same key and identical content.

Teams consume model usage from your signed-in account. The default Root pool is 200000 tokens. Budgets control admission and accounting; they are not hard limits on an executing Turn or your provider bill.

```sh
node "$SKILL_DIR/scripts/cat.mjs" send --target AGENT_ID --key input-001 --message 'Additional input'
node "$SKILL_DIR/scripts/cat.mjs" control --target ROOT_ID --action pause
node "$SKILL_DIR/scripts/cat.mjs" control --target ROOT_ID --action resume
node "$SKILL_DIR/scripts/cat.mjs" stop
node "$SKILL_DIR/scripts/cat.mjs" start
```

Pause applies to the subtree by default, drains active Turns and queues messages; `--scope agent` selects one agent. `cancel` requests interruption; `terminate` is permanent. `stop` closes only the Coordinator, leaving the dedicated official daemon and accepted work alive. See [operations](references/operations.md) for full shutdown, recovery, unknown execution and final usage settlement.

## Tasks and event waiting

New teams receive `agent_task_create/get/list/update` tools to record owners, revisions, dependencies and explicit results. Updates require the current `expectedRevision` and an idempotent `requestKey`. `claim` takes ready work; `complete` supplies a result. Message acknowledgment and successful Turns do not complete a business Task. Task completion is an authorized assertion, not an independent quality review. Dependencies are checked for cycles and valid states; readiness alone does not dispatch a model. Task tool round trips add cumulative context usage, including cached input. The three-node, two-task acceptance workflow explicitly uses 600000 tokens; the default remains 200000. Plan the pool before creating the tree.

The operator has corresponding `task-create/get/list/update` commands:

```sh
node "$SKILL_DIR/scripts/cat.mjs" task-create --target ROOT_ID --key calc --subject Calculate --description 'Six groups of seven packets'
node "$SKILL_DIR/scripts/cat.mjs" task-update --target ROOT_ID --task-id TASK_ID --key claim-calc --revision 1 --action claim
node "$SKILL_DIR/scripts/cat.mjs" task-update --target ROOT_ID --task-id TASK_ID --key finish-calc --revision 2 --action complete --result '42 packets'
```

`view` combines agent summaries, tasks, budgets, message counts and blocking reasons. Pass its cursor to `wait`, then continue with each response's top-level cursor. `hasMore` indicates another event page. `noProgress` calls for inspecting missing input, fences, budgets or unknown work; it does not prove completion. Operator waiting does not occupy a managed Turn. See [operations](references/operations.md) for permissions, dependency edits, input files and cursor details.

Before upgrading, stop the Coordinator and back up the complete state directory, then update source and rerun `setup/start`. Alpha.3 migrates the database to schema 5; older versions cannot directly read it. Existing native Threads retain their original tool catalogs and can keep using messages or operator-managed tasks. New Task tools apply to new Threads; upgrading does not force rebinding.

## Development and validation

```sh
npm ci
npm run typecheck
npm run format:check
npm test
npm run test:fault
npm run test:native   # isolated official daemon; no model calls; exact CLI and login required
npm run test:real     # real model calls; consumes account usage
npm run package:skill
```

Default tests do not consume model usage. Real tests use isolated temporary directories and clean up copied credentials and their own daemons. Evidence goes to `.artifacts/evidence/` and is not committed. See the [recursive example](examples/recursive-team/README.md).

This alpha does not support Linux/Windows qualification, multiple credential domains, automatic DAG execution, repository writes, a GUI or interactive approval queues. Recovery preserves ambiguous work as unknown rather than blindly replaying it. There is no claim of exactly-once external effects or evidence that teams outperform a single agent on quality or cost.

[Implementation plan](docs/task-board-plan.md) · [DeepSeek comparison](docs/deepseek-agent-team.md) · [Review fixes](docs/review-round-1.md) · [Architecture](docs/architecture.md) · [Validation](docs/validation.md) · [Skill entry](SKILL.md)

## License

Apache-2.0. The JSON-RPC transport reuses and modifies Stoneforge code; provenance and attribution are in [vendor](src/runtime/codex/vendor/README.md) and [NOTICE](NOTICE). Model execution and native history use the official Codex App Server daemon. This project is not affiliated with OpenAI.
