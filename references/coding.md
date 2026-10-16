# Coding workspace operations

Coding is opt-in for a **new** team. Existing read-only teams retain their native tool catalogs. Use one coding team per repository; concurrent coordinators editing the same Lead checkout and hostile local processes are outside this qualification.

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

## Capabilities

| Level (depth) | Workspace | Tools |
| --- | --- | --- |
| Lead (0) | Selected repository | `terminal`, `read_file`, `write_file`, `search_code`, `git_diff`, configured `run_test` |
| Second (1) | Own detached Git worktree | `read_file`, `write_file`, `search_code`, `git_diff`, configured `run_test`; no terminal |
| Third and deeper (2+) | Nearest second-level ancestor's worktree | `read_file`, `search_code`, `git_diff`; no writes, tests or terminal |

Each second-level worktree starts from the commit captured during initialization. It does not automatically inherit the Lead's subsequent changes or another member's uncommitted work. Third-level review sees the parent's current files. Worktree checkout and diff also run in a sandbox; hooks and fsmonitor are disabled, and diff has no workspace write permission. A durable ready marker detects interrupted provisioning and refuses automatic reset; inspect retained files before recovery.

Worktrees remain available after task completion and restart; no automatic branch merge, commit, reset or deletion occurs.

For new files, `write_file` uses `expectedHash: null`; existing files require the SHA-256 from `read_file`. Repeating identical content succeeds without rewriting. A conflicting hash requires a fresh read and an intentional decision. Missing parent directories are created within the workspace. Paths are relative, without `..` or symlinks. `.git`, `.codex`, `.agents`, `node_modules`, `.env*`, `auth.json` and `operator-token` are protected. File size is bounded at 64 KiB. This broker handles ordinary UTF-8 text; binary files and symlink changes need Lead's review and terminal.

Search is literal, bounded, and skips protected paths. `git_diff` shows tracked changes against the initial commit and lists untracked files separately. Task `writeScopes` remain planning metadata; actual authority is determined by level and worktree, not by a task claim. Third-level write scope delegation is not implemented.

## Commands, sandbox and recovery

Lead `terminal` accepts a shell command, runs `/bin/zsh -f -c` in the Lead checkout, and returns its actual exit code and output. It can review a child's patch with `git -C CHILD_WORKTREE diff --no-ext-diff --no-textconv`, apply a reviewed patch, run tests and perform local Git commits. Lead terminal may read the team's worktree directory but cannot write there; it can write its repository (including Git metadata) and private temporary home. All commands have a 30-second timeout and 64 KiB combined output limit. Longer builds require operator execution outside this tool.

`run_test` takes only an approved command **name**, no shell string or extra argv. Test code can execute code, so both tests and terminal run under a macOS Seatbelt profile: network denied, writes limited to their own workspace and private temporary home, reads limited to workspace and required system/toolchain roots. The environment excludes provider keys, ordinary HOME and global Git configuration. Descendant tests cannot write the parent repository or Git common directory. Tests that require network, external databases, arbitrary SDK locations or Unix services can fail closed. The current qualified environment uses macOS arm64 and Homebrew Node 26.3.1. There is no unrestricted fallback on another platform.

Dependencies and ignored local files are not copied into detached worktrees. For dependency-heavy projects, prepare an operator-approved offline test setup or have Lead run integration tests in the original checkout. Do not copy credential-bearing `.env` files into children to make tests pass.

File operations are refused while a host command is running in the same workspace, including third-level reads; wait for its result before reading or writing.

Commands are recorded before launch using the native call ID and input fingerprint. An identical completed retry returns the stored outcome; an accepted command without a stored result blocks replay as unknown. `status.workspace.commands` shows the latest 20 receipts with a 2,000-character output preview; `commandSummary.unresolved` counts accepted commands lacking a final receipt. `workspace.command.accepted/completed` and `workspace.tool.completed` events provide correlation and exit codes. Treat an accepted receipt without completion as requiring inspection. A new call ID is new work, not an exactly-once retry.

Cancel/terminate stops running host commands. Normal Coordinator shutdown also cancels host commands; native text Turns remain attached to the dedicated daemon. A supervisor kills ordinary test descendants when the host dies. Crash between file rename and reply is resolved by reading the file and retrying the same desired content/hash, not by assuming success from a message. The runtime still reconciles uncertain native Turns before scheduling more work.

The sandbox does not make hostile local processes, the repository's toolchain, arbitrary detached daemons, or all OS IPC safe. Run trusted repositories and inspect patches. Seatbelt protections and host checks complement each other; prompts do not grant permissions.

## Handoff and completion

A useful delegation: Lead asks a coder to reproduce a defect, implement it in its worktree, delegate static review to a third-level member, run the configured test, and report the worktree path, actual diff, test exit code and caveats. Lead reviews and integrates the actual patch, then uses `terminal` for final integration tests. Require actual command receipts before claiming a test passed. A reviewer without `run_test` must label its result as static review.

Messages still require `agent_ack`. Idle/processed messages do not imply the coding task is complete. Check the integrated repository diff, actual test receipts and any explicit task completion results.

## Incomplete worktree runbook

`events --target CHILD_ID` now includes the safe diagnostic message on `scheduler.error`. “Worktree provisioning is incomplete or changed” means the private ready marker is missing/mismatched, not that the files are disposable. A present marker records successful provisioning; it does not certify subsequent file contents or protect against hostile local changes.

1. Pause the affected root/subtree, inspect its status and events, then stop the Coordinator. Stop cancels host commands; inspect native history separately rather than assuming every native Turn stopped.
2. Back up the complete state and preserve the affected worktree directory, including untracked files. Record the child ID, configured `workspace.baseCommit`, worktree path and any native binding. Do not run reset, clean, checkout, prune, remove, or delete its ready marker to try to unblock scheduling.
3. For the trusted repository, inspect `git worktree list --porcelain` and the affected directory's `git rev-parse --show-toplevel`, `--git-common-dir` and `HEAD`. The path/common directory must belong to this configured repository; HEAD should be the initialization commit for a newly provisioned detached worktree. Matching metadata alone does not prove checkout finished. A directory that belongs to another checkout must not be adopted.
4. Review/salvage the preserved files as an explicit patch. This Beta has no command that safely adopts an unmarked worktree into the same Agent. Restart the original team, intentionally terminate the failed member, and ask its parent for a replacement **only if existing lifetime limits permit**; review the salvaged patch before applying it to the replacement. If limits are exhausted, report that state and require an explicit operator decision; do not silently create another tree to evade limits.

The original directory and Git administrative entry remain preserved for inspection. Cleanup or removal is a separate intentional operator action after the changes have been secured. Do not manufacture a ready marker or retire/rebind a live or unknown native Thread. Restoring an intact matching backup is another option, but reconcile any intervening native work before scheduling.
