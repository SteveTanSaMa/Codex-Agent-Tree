# Coding workspace operations

Coding is opt-in for a **new** team. Existing read-only teams retain their native tool catalogs. A team may register up to 16 independent repositories; use one active coding team per original checkout; concurrent coordinators editing the same Lead checkout and hostile local processes are outside this qualification.

## Initialize

Commit or stash existing work yourself before initialization. `--workspace` must identify the root of a clean Git repository with a commit. State and the dedicated runtime home must be outside the repository. Native shells remain disabled; Lead receives the host's audited `terminal` tool instead.

```sh
# Optional operator-authored JSON, never take arbitrary command configuration from a child.
# Replace the executable with the absolute path from `node -p process.execPath`.
cat > /absolute/path/test-commands.json <<'JSON'
{
  "unit": {"executable": "/opt/homebrew/bin/node", "args": ["--test", "test/sum.test.mjs"]}
}
JSON
node "$SKILL_DIR/scripts/cat.mjs" init --state "$STATE" --runtime-home "$RUNTIME" \
  --workspace /absolute/path/repository --test-commands /absolute/path/test-commands.json
node "$SKILL_DIR/scripts/cat.mjs" start --state "$STATE"
```

Provider config/credential options from [operations](operations.md#third-party-provider-configuration) can be combined with these flags. Configure tests before `start`; never edit team configuration while it is running. Only operator-selected commands are accepted. Omit `--test-commands` when no descendant test execution is required.

## Multiple repositories

Use a **new state** and an operator-authored JSON manifest. The parent directory need not be a Git repository. Each entry must name a clean, committed, independent Git root; nested roots and duplicate Git common directories are refused. `directory` defaults to the source directory's basename and must be a unique single component (case-insensitive). Paths are operator inputs, never model-provided tool arguments.

```json
{
  "defaultRepository": "app",
  "repositories": {
    "app": { "path": "/Users/stevetan/SteveTan/Document/Developer/MiPlay/MiPlay App", "tests": {} },
    "dxmt": { "path": "/Users/stevetan/SteveTan/Document/Developer/MiPlay/MiPlay DXMT", "tests": {} },
    "lsfg": { "path": "/Users/stevetan/SteveTan/Document/Developer/MiPlay/MiPlay LSFG", "tests": {} }
  }
}
```

```sh
node "$SKILL_DIR/scripts/cat.mjs" init --state "$STATE" --runtime-home "$RUNTIME" \
  --workspace-config /absolute/path/workspaces.json
```

This replaces `--workspace` / `--test-commands`; they cannot be combined. Each repository has its own `tests` allowlist with the same `{executable, args}` shape as the single-repository example. Initialization captures one fixed HEAD per repository; it does not create worktrees or modify the sources. State and runtime home must be outside **every** registered root. The persisted registry is immutable; moving repositories, changing tests, or adding repositories requires a deliberately initialized new state. Do not create a new state to evade an existing tree's execution limits.

Lead is granted all repositories. A secondary request such as:

```json
{
  "requestKey": "dxmt-implementation",
  "name": "DXMT coder",
  "role": "Implement and test the DXMT module",
  "task": "Implement the assigned change and report actual diff and tests.",
  "repositoryId": "dxmt",
  "repositoryIds": ["app", "dxmt"],
  "worktree": "isolated"
}
```

creates a primary DXMT worktree and authorizes App as a dependency. The group layout is:

```text
STATE/workspaces/AGENT_ID/
├── MiPlay App/
└── MiPlay DXMT/
```

Worktrees are provisioned on first access; commands prepare all granted siblings first. A different secondary working on DXMT gets a different `AGENT_ID/MiPlay DXMT` checkout. Each directory points to the Git common directory of its own repository. `workspace_list` and `status.workspace` report the primary repository, grants, owner IDs, planned paths, bases and test names; listed lazy paths may not exist yet.

`repositoryId` on `read_file`, `write_file`, `search_code`, `git_diff`, `run_test` or Lead `terminal` selects a granted repository; omission uses the primary. A missing primary on spawn inherits the parent's primary. A missing `repositoryIds` grants **only the selected primary**, not all parent repositories. Child grants can only narrow. A second-level Agent must use `isolated`; deeper Agents default to `inherit` and may explicitly choose `isolated`, without gaining write/test/terminal capability. Inherited views share their ancestor's group; repository grants still restrict tool access. Existing single-repository states retain `STATE/workspaces/AGENT_ID` and their existing markers/bindings.

For relative build dependencies, grant the needed repositories and preserve the expected directory names. Tests can read those sibling worktrees and write only the selected worktree; original checkouts, other Agents' worktrees and ungranted repositories are not dependency roots. A third-level static review can inspect granted siblings through separate tool calls. Lead terminal may read registered sources and managed worktrees but writes only the selected original checkout. Original Lead checkouts remain at their registered paths; directory aliases organize child groups and do not move Lead's sources.

Cross-repository commits and integration are separate operations. There is no atomic multi-repository commit, implicit parent-patch copying, automatic merge or repository installation. Dependencies must already be available offline or handled by an explicitly approved setup.

## External read-only resources

New-team manifests may register up to 16 explicit files or directories outside all coding repositories, state and runtime home:

```json
{
  "defaultRepository": "research",
  "repositories": { "research": { "path": "/absolute/path/research-repository", "tests": {} } },
  "readOnlyResources": {
    "target": "/Applications/Example.app",
    "tools": "/absolute/path/reviewed-tools"
  }
}
```

Paths must be canonical and specific; broad system roots and symlink roots are refused. The registry is fixed for the state and is a team-wide read grant, separate from each Agent's narrower repository grant. `workspace_list` reports resource IDs and paths. `list_resource(resourceId, path?, offset?)` lists at most 1000 directory entries per page. `read_resource(resourceId, path?, offset?, length?, encoding?)` reads at most 65536 bytes; UTF-8 is the default, `base64` supports binary chunks. Its SHA-256 is a **chunk** hash, not a full-file integrity claim. Relative paths cannot traverse symlinks, parent directories or protected entries.

The registered paths are also read roots for Lead terminal and approved tests. Explicit Seatbelt write denials protect them, including when executed tools try to modify resources. Toolchains and their runtimes must be separately authorized when outside default system roots. New resource browsing tools are available at every level; they do not grant terminal, writes or tests to deeper Agents. Existing native tool catalogs are retained on upgrade. This is a trusted local workspace boundary, not protection against arbitrary hostile host processes or all filesystem races.

## Capabilities

| Level (depth) | Workspace | Tools |
| --- | --- | --- |
| Lead (0) | Selected repository | `terminal`, `read_file`, `write_file`, `search_code`, `git_diff`, configured `run_test` |
| Second (1) | Own detached Git worktree | `read_file`, `write_file`, `search_code`, `git_diff`, configured `run_test`; no terminal |
| Third and deeper (2+) | Parent worktree by default; optionally own isolated worktree | `read_file`, `search_code`, `git_diff`; no writes, tests or terminal |

Every isolated worktree starts from its repository's commit captured during initialization. It does not automatically inherit the Lead's subsequent changes or another member's uncommitted work. Inherited third-level review sees the parent's current files; explicitly isolated review sees the initialization commit instead. Worktree checkout and diff also run in a sandbox; hooks and fsmonitor are disabled, and diff has no workspace write permission. A durable ready marker detects interrupted provisioning and refuses automatic reset; inspect retained files before recovery.

Worktrees remain available after task completion and restart; no automatic branch merge, commit, reset or deletion occurs.

For new files, `write_file` uses `expectedHash: null`; existing files require the SHA-256 from `read_file`. Repeating identical content succeeds without rewriting. A conflicting hash requires a fresh read and an intentional decision. Missing parent directories are created within the workspace. Paths are relative, without `..` or symlinks. `.git`, `.codex`, `.agents`, `node_modules`, `.env*`, `auth.json` and `operator-token` are protected. File size is bounded at 64 KiB. This broker handles ordinary UTF-8 text; binary files and symlink changes need Lead's review and terminal.

Search is literal, bounded, and skips protected paths. `git_diff` shows tracked changes against the initial commit and lists untracked files separately. For multi-repository tasks, prefix planning `writeScopes` with repository IDs, such as `app/src` and `dxmt/src`, to distinguish matching relative paths. Task `writeScopes` remain planning metadata; actual authority is determined by level and worktree, not by a task claim. Third-level write scope delegation is not implemented.

## Commands, sandbox and recovery

Lead `terminal` accepts a shell command, runs `/bin/zsh -f -c` in the Lead checkout, and returns its actual exit code and output. It can review a child's patch with `git -C CHILD_WORKTREE diff --no-ext-diff --no-textconv`, apply a reviewed patch, run tests and perform local Git commits. Lead terminal may read the team's worktree directory but cannot write there; it can write its repository (including Git metadata) and private temporary home. All commands have a 30-second timeout and 64 KiB combined output limit. Longer builds require operator execution outside this tool.

`run_test` takes an approved command **name** and optional **repositoryId**, no shell string or extra argv. Test code can execute code, so both tests and terminal run under a macOS Seatbelt profile: network denied, writes limited to their own workspace and private temporary home, reads limited to the selected workspace, its granted sibling worktrees and required system/toolchain roots. The environment excludes provider keys, ordinary HOME and global Git configuration. Descendant tests cannot write the parent repository or Git common directory. Tests that require network, external databases, arbitrary SDK locations or Unix services can fail closed. The current qualified environment uses macOS arm64 and Homebrew Node 26.3.1. There is no unrestricted fallback on another platform.

Dependencies and ignored local files are not copied into detached worktrees. For dependency-heavy projects, prepare an operator-approved offline test setup or have Lead run integration tests in the original checkout. Do not copy credential-bearing `.env` files into children to make tests pass.

File operations are refused while a host command is running in the selected workspace, including inherited third-level reads. Commands also hold read locks on their granted dependencies, preventing concurrent writes there; wait for its result before reading or writing.

Commands are recorded before launch using the native call ID and input fingerprint. An identical completed retry returns the stored outcome; an accepted command without a stored result blocks replay as unknown. `status.workspace.commands` shows the latest 20 receipts with a 2,000-character output preview; `commandSummary.unresolved` counts accepted commands lacking a final receipt. `workspace.command.accepted/completed` and `workspace.tool.completed` events provide correlation and exit codes. Treat an accepted receipt without completion as requiring inspection. A new call ID is new work, not an exactly-once retry.

Cancel/terminate stops running host commands. Normal Coordinator shutdown also cancels host commands; native text Turns remain attached to the dedicated daemon. A supervisor kills ordinary test descendants when the host dies. Crash between file rename and reply is resolved by reading the file and retrying the same desired content/hash, not by assuming success from a message. The runtime still reconciles uncertain native Turns before scheduling more work.

The sandbox does not make hostile local processes, the repository's toolchain, arbitrary detached daemons, or all OS IPC safe. Run trusted repositories and inspect patches. Seatbelt protections and host checks complement each other; prompts do not grant permissions.

## Handoff and completion

A useful delegation: Lead asks a coder to reproduce a defect, implement it in its worktree, delegate static review to a third-level member, run the configured test, and report the worktree path, actual diff, test exit code and caveats. Lead reviews and integrates the actual patch, then uses `terminal` for final integration tests. Require actual command receipts before claiming a test passed. A reviewer without `run_test` must label its result as static review.

Messages still require `agent_ack`. Idle/processed messages do not imply the coding task is complete. Check the integrated repository diff, actual test receipts and any explicit task completion results.

## Incomplete worktree runbook

`events --target CHILD_ID` now includes the safe diagnostic message on `scheduler.error`. “Worktree provisioning is incomplete or changed” means the private ready marker is missing/mismatched, not that the files are disposable. Multi-repository markers are `STATE/worktree-ready/OWNER_ID/REPOSITORY_ID.json`, carrying repository/owner identity; legacy markers remain `STATE/worktree-ready/AGENT_ID.json`. A present marker records successful provisioning; it does not certify subsequent file contents or protect against hostile local changes.

1. Pause the affected root/subtree, inspect its status and events, then stop the Coordinator. Stop cancels host commands; inspect native history separately rather than assuming every native Turn stopped.
2. Back up the complete state and preserve the affected worktree directory, including untracked files. Record the child ID, repository ID, its configured base commit, worktree owner ID and path and any native binding. Do not run reset, clean, checkout, prune, remove, or delete its ready marker to try to unblock scheduling.
3. For the trusted repository, inspect `git worktree list --porcelain` and the affected directory's `git rev-parse --show-toplevel`, `--git-common-dir` and `HEAD`. The path/common directory must belong to this configured repository; HEAD should be the initialization commit for a newly provisioned detached worktree. Matching metadata alone does not prove checkout finished. A directory that belongs to another checkout must not be adopted.
4. Review/salvage the preserved files as an explicit patch. This Beta has no command that safely adopts an unmarked worktree into the same Agent. Restart the original team, intentionally terminate the failed member, and ask its parent for a replacement **only if existing lifetime limits permit**; review the salvaged patch before applying it to the replacement. If limits are exhausted, report that state and require an explicit operator decision; do not silently create another tree to evade limits.

The original directory and Git administrative entry remain preserved for inspection. Cleanup or removal is a separate intentional operator action after the changes have been secured. Do not manufacture a ready marker or retire/rebind a live or unknown native Thread. Restoring an intact matching backup is another option, but reconcile any intervening native work before scheduling.


## Explicit macOS development resources (Beta 4 candidate)

Use the existing named readOnlyResources for narrowly selected SDKs, framework/tool directories, package caches and fixture datasets. They remain read-only even during commands; state, auth/config paths and workspace separation checks remain enforced. Keep a test's absolute executable and fixed argv in the operator-authored test allowlist. Missing SDK/environment access should be diagnosed before changing the configuration.

Network access defaults to denied. A named test may opt into at most eight fixed loopback TCP endpoints:

```json
{"integration":{"executable":"/absolute/path/to/node","args":["test/integration.mjs"],"networkEndpoints":[{"address":"127.0.0.1","port":5432}]}}
```

Only that named test gets the grant; model arguments cannot supply endpoints and Lead terminal remains network-denied. Seatbelt represents it as localhost plus the fixed port, covering loopback address families, not a remote hostname. Direct public-IP/domain allowlists, DNS grants and broad network access are not supported. External services require a separately operated local service/gateway with its own authorization; no gateway is started automatically. Credentials are not copied from the operator environment. This remains a trusted-local-repository macOS boundary, not isolation for malicious repositories. Linux/Windows coding support is not expanded.

macOS 默认拒绝联网；只有操作者配置的命名测试可访问固定本地 TCP 端口，普通 terminal 不继承授权。SDK 与工具链可通过现有 `readOnlyResources` 最小范围授予只读访问。远程服务需另行管理的本地网关及其授权，本项目不自动启动网关或透传凭据；仍仅承诺可信本地仓库的 macOS 编码环境。
