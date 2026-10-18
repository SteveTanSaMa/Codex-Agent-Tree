# Codex Agent Tree

> This README describes development on main; published packages contain the features of their matching tags.

[简体中文](README.md) · English

An installable Codex Skill for recursive teams of independent, recoverable Codex sessions, with message wakeups, task dependencies, controlled coding and conservative recovery.

**`0.1.0-beta.2`: qualified on macOS arm64, Node ≥26.3.1 and exactly `codex-cli 0.162.0-alpha.17.2`, with one credential domain.** Text analysis remains the default. Opt-in Git workspaces give Lead an audited terminal, second-level members isolated writable worktrees and approved test commands, and deeper members read-only review tools. Your current conversation is the operator; the managed Root is a separate session.

This Beta targets trusted local repositories in the qualified environment. It does not claim production-grade isolation, multiple credential domains or automatic merges. See [coding operations](references/coding.md), [Beta 2 qualification](docs/beta-2-validation.md) and [usage reconciliation](docs/usage-reconciliation.md). Back up stopped state before migration to schema 12 in Beta 2. Existing read-only teams do not gain permissions automatically.

Beta 2 includes multiple repositories and worktrees, live guidance, configurable usage reminders, post-Beta-1 task projection improvements and worktree recovery guidance. The published Beta 1 ZIP remains unchanged. See [Beta 2 qualification](docs/beta-2-validation.md), the [multi-repository design and validation](docs/multi-repository-plan.md) and [review follow-up](docs/review-beta-1.md).

The [independent follow-up qualification](docs/beta-2-gap-test-results.md) is now collected; the published Beta 2 payload remains unchanged. The [next plan and acceptance goals](docs/post-beta-2-plan.md) cover scope changes, recovery, cross-environment/version compatibility and scale qualification. These planned improvements are not implemented yet.

Use `init --workspace-config /absolute/path/workspaces.json` to register independent Git roots; their parent directory does not need Git. A secondary may receive one or more repositories, each in `state/workspaces/AGENT_ID/REPOSITORY_DIRECTORY`, preserving sibling layouts such as MiPlay App / DXMT / LSFG. Deeper Agents inherit their parent's worktrees read-only by default or create isolated read-only worktrees. Repository grants only narrow; Lead reviews and integrates each repository separately. See [configuration and tool examples](references/coding.md#multiple-repositories).

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

`setup` runs locked `npm ci --omit=dev --ignore-scripts` inside the Skill, installing only the runtime dependency `ws`. `doctor` makes no model calls. The [Beta release ZIP](https://github.com/SteveTanSaMa/Codex-Agent-Tree/releases/tag/v0.1.0-beta.2) contains the same self-contained Skill without dependency caches or credentials; extract it and run `setup`.

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

Teams consume model usage from your signed-in account. New teams observe token usage by default: 5000000 is a warning threshold, not an execution gate, and no Agent receives a token allocation. New teams default to interactive mode with unlimited lifetime Turns and retained statistics. `--mode batch` keeps 20 per Agent / 100 per tree. Depth, lifetime Agent count and concurrency remain hard limits. Choose per-Agent/tree single or incremental reminders using total, noncached input or output. Task-wide soft budgets are separate; existing enforce trees retain compatibility.

```sh
node "$SKILL_DIR/scripts/cat.mjs" send --target AGENT_ID --key input-001 --message 'Additional input'
node "$SKILL_DIR/scripts/cat.mjs" control --target ROOT_ID --action pause
node "$SKILL_DIR/scripts/cat.mjs" control --target ROOT_ID --action resume
node "$SKILL_DIR/scripts/cat.mjs" stop
node "$SKILL_DIR/scripts/cat.mjs" start
```

Pause applies to the subtree by default, drains active Turns and queues messages; `--scope agent` selects one agent. `cancel` requests interruption; `terminate` is permanent. `stop` closes the Coordinator and cancels host commands, leaving the dedicated official daemon and accepted native Turns alive. See [operations](references/operations.md) for full shutdown, recovery, unknown execution and final usage settlement.

## Coding teams

Initialize a new team with a clean, committed repository; state and runtime home must be outside it:

```sh
node "$SKILL_DIR/scripts/cat.mjs" init --state "$HOME/.cat/code-team" --runtime-home "$HOME/.cat/code-runtime" --workspace /absolute/path/repository --test-commands /absolute/path/tests.json
node "$SKILL_DIR/scripts/cat.mjs" start --state "$HOME/.cat/code-team"
```

The operator-authored JSON maps names to fixed executables and argv, for example `{"unit":{"executable":"/opt/homebrew/bin/node","args":["--test","test/sum.test.mjs"]}}`. Omit `--test-commands` if descendants do not need to run tests.

| Level | Files | Commands |
| --- | --- | --- |
| Lead | Selected repository; reviews and integrates patches | Host `terminal` for commands, tests and local Git operations |
| Second | Own detached Git worktree | Approved `run_test` names; no general shell |
| Third and deeper | Parent worktree read/search/diff | No terminal, writes or test execution |

Restricted tools are `read_file`, hash-checked `write_file`, literal `search_code`, `git_diff` and `run_test`. Host authorization also rejects direct calls to tools hidden from a member. Commands use a macOS sandbox with network disabled, workspace-limited writes, a 30-second timeout and 64 KiB output limit. Persistent receipts protect against automatic replay of uncertain commands.

Each coding state supports one Lead tree. Worktrees start from the initial commit, without dependencies, ignored files or subsequent parent changes. Do not run separate Coordinators against the same Lead checkout. Lead can run integration tests in the original checkout with its existing dependencies. Reported tokens are not billing; this Beta does not establish that teams use fewer tokens than a single agent. See [coding operations](references/coding.md) for setup, recovery and boundaries.

## Execution limits

Interactive defaults are depth 2, 20 lifetime Agents, 3 concurrent Turns and unlimited lifetime Turns. `--mode batch` defaults to 20 Turns per Agent and 100 total Turns per tree. Configure them with `--max-depth`, `--max-agents`, `--concurrent`, `--max-turns` and `--max-total-turns`. Finishing an Agent does not refund its lifetime count. Prepared Turns count even if later cancelled, failed or interrupted; restart does not reset counts. Exhaustion blocks new admissions while accepted work can finish.

Depth and concurrency alone cannot bound sequential spawning or repeated message-triggered Turns. Lifetime member and Turn limits cover those cases. `view/status` expose `executionLimits` and token policy. In default observe mode, `--tokens N` only sets the usage warning threshold. Unknown execution keeps its original reconciliation fence and is never automatically replayed. See [operations](references/operations.md).

## Tasks and event waiting

New teams receive `agent_task_create/get/list/update` tools to record owners, revisions, dependencies and explicit results. Updates require the current `expectedRevision` and an idempotent `requestKey`. `claim` takes ready work; `complete` supplies a result. Message acknowledgment and successful Turns do not complete a business Task. Task completion is an authorized assertion, not an independent quality review. Dependencies are checked for cycles and valid states; readiness alone does not dispatch a model. Task tool round trips add cumulative context usage, including cached input. Default observation records and warns about that usage without requiring a fixed token allocation for ordinary delegation.

The operator has corresponding `task-create/get/list/update` commands:

```sh
node "$SKILL_DIR/scripts/cat.mjs" task-create --target ROOT_ID --key calc --subject Calculate --description 'Six groups of seven packets'
node "$SKILL_DIR/scripts/cat.mjs" task-update --target ROOT_ID --task-id TASK_ID --key claim-calc --revision 1 --action claim
node "$SKILL_DIR/scripts/cat.mjs" task-update --target ROOT_ID --task-id TASK_ID --key finish-calc --revision 2 --action complete --result '42 packets'
```

`view` combines agent summaries, tasks, budgets, message counts and blocking reasons. Pass its cursor to `wait`, then continue with each response's top-level cursor. `hasMore` indicates another event page. `noProgress` calls for inspecting missing input, fences, budgets or unknown work; it does not prove completion. Operator waiting does not occupy a managed Turn. See [operations](references/operations.md) for permissions, dependency edits, input files and cursor details.

Before upgrading, stop the Coordinator and back up the complete state directory, then update source and rerun `setup/start`. Beta 2 migrates the database to schema 12; older versions cannot directly read it. Existing trees retain their token policies; new trees default to observe. Existing native Threads retain their original tool catalogs and can keep using messages or operator-managed tasks. New Task tools apply to new Threads; upgrading does not force rebinding.

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

This Beta does not qualify Linux/Windows, multiple credential domains, automatic DAG execution, networked commands, automatic merging, a GUI or interactive approval queues. Recovery preserves ambiguous work as unknown rather than blindly replaying it. There is no claim of exactly-once external effects or evidence that teams outperform a single agent on quality or cost.

[Execution limits plan](docs/execution-limits-plan.md) · [Task board plan](docs/task-board-plan.md) · [DeepSeek comparison](docs/deepseek-agent-team.md) · [Review fixes](docs/review-round-1.md) · [Architecture review and open issues](docs/review-architecture.md) · [Architecture](docs/architecture.md) · [Validation](docs/validation.md) · [Skill entry](SKILL.md)

## License

Apache-2.0. The JSON-RPC transport reuses and modifies Stoneforge code; provenance and attribution are in [vendor](src/runtime/codex/vendor/README.md) and [NOTICE](NOTICE). Model execution and native history use the official Codex App Server daemon. This project is not affiliated with OpenAI.

Beta 2 supports explicit external read-only resource registration for restricted browsing and Lead analysis commands. Resources remain protected from writes. With explicit user authorization, `limits --max-turns unlimited --max-total-turns unlimited --target ROOT_ID --reason TEXT` removes an existing tree's Turn ceilings without resetting counters or identities. See [resource access](references/coding.md#external-read-only-resources) and [limit updates](references/operations.md#explicit-turn-limit-changes).

## Interactive execution control

`send` attempts live guidance for a running interactive Agent; `--delivery queue` waits for the next Turn, and `steer` explicitly requests current-Turn delivery. `status.interaction` exposes delivery and uncertainty. Unknown outcomes are never automatically replayed. `control --action pause --immediate` persists a subtree fence and requests interruption; ordinary pause still drains.

Defaults warn after 15 minutes of autonomous execution, 10 minutes without selected observable activity, or 8 consecutive identical tool rejections. Automatic pause and task token/time soft budgets are opt-in. Existing teams keep their policies and limits. See the [implementation plan, defaults and operations](docs/interactive-control.md). Validation uses bounded tests and a local native protocol probe; long-running real tasks are deferred.

## Token usage reminders

New teams have no per-dialogue token allocation. Default: one tree-wide reminder at 5000000 total tokens. Configure with `token-reminder --target ID --threshold N [--every N] [--scope agent|tree] [--metric total|uncachedInput|output]`; disable with `--disable`. Alerts never pause, start Turns or request a model. Missing metrics remain unknown. See [reminders and migration](docs/token-reminders.md).
