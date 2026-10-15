# Beta 1 qualification

Decision: **ready for a scoped `0.1.0-beta.1` prerelease**, not production certification.

Qualified environment: macOS arm64, Node 26.3.1, `codex-cli 0.162.0-alpha.17.2`; one credential domain. Third-party model qualification used the existing isolated DeepSeek provider configuration through Command Code. Its source configuration remained unchanged. Native execution still uses the official Codex daemon; coding capabilities use the host broker.

## Gates and evidence

| Gate | Result | Reproduction / observable evidence |
| --- | --- | --- |
| Default regression | 95 passed; 4 native tests skipped in default run and executed separately | `npm test` (8 unit + 87 integration passes) |
| Fault injection | 27 passed | `npm run test:fault`; includes actual host SIGKILL, SQLite rollback and supervisor parent-death cleanup |
| Official daemon integration | 4 passed, no model calls | `npm run test:native`; separate CLI processes, reconnect, restart, tasks/CAS and cursor waiting |
| Real recursive coding | 1 passed; 3 independent Sessions, 5 Turns, 68.8 seconds including setup/cleanup | `test/real/coding-workspace.test.ts`; actual file change, test receipts, messages and restart checks |
| File and command boundaries | Passed | `workspace.test.ts`: traversal, symlink/hardlink, private read, external write, network, hidden tools, forged identity, pause, CAS, output bound and cancellation |
| Git command boundary | Passed | Sandboxed worktree checkout and read-only diff; clean/smudge filter positive controls, fsmonitor disabled, protected case aliases refused |
| Lead integration | Passed | Lead terminal applies a child's diff, commits it locally and runs a test; descendants cannot call terminal |
| FIFO and schema migration | Passed | `fifo-receipts.test.ts`: mixed sources, reversed clock, retries/restart, actual schema-7 message-table upgrade |
| Late receipts | Passed in observe and enforce, four submission orders each | Pending evidence persists across reopen and automatically converges to fixture oracle 30 + 45 + 10 = 85; native cursor remains 85 |
| Skill distribution | Passed | ZIP extracted outside checkout, isolated coder edits/tests and Lead patch integration; fresh `setup` installed only `ws` and `doctor` passed |
| Static and packaging | Passed | `typecheck`, `format:check`, Skill validator, package input allowlist |

These are 127 passing executions across the listed suites, not 123 independent proofs. The earlier rigorous audit, its repetitions and its 30-Turn budget are separate historical evidence; they are not added to this total.

## Real coding result

The real fixture began with `sum(2,3)` incorrectly returning `-1`. Lead delegated to a coder in a detached worktree. Coder's approved test returned exit 1, the hash-checked write replaced subtraction with addition, and a third-level reviewer inspected the current parent worktree using read/search tools. After its report, coder's test returned exit 0 with `CODING_TEST_PASS`. Lead integrated the reviewed file and its audited terminal returned exit 0 with the same output. All required messages were acknowledged and processed. A Coordinator restart retained binding IDs and did not add another Turn.

The passing run recorded 205,527 cumulative reported tokens across five Turns, including repeated/cached context. This is not a provider bill or evidence of efficiency. It is one deliberately small coding fixture, not a benchmark demonstrating superiority over a single agent.

The first real attempt used six Turns and **failed** the required Lead terminal evidence assertion: legacy native history returned no command execution item. File integration and descendant tests had succeeded, but model prose was not accepted as terminal proof. The final implementation supplies an audited host terminal for Lead and keeps native shell disabled. A second complete run passed with stored command output and exit-code receipts. Both attempts remain in local evidence; only the passing one is counted above. The qualification journal retained all 11 dispatches; its initial eight-Turn test ceiling was explicitly expanded to sixteen for this changed implementation, without resetting counts or touching the prior rigorous audit's exhausted budget.

Local raw evidence is under `.artifacts/beta-qualification/` (ignored), including separate failed/passed run directories, statuses, events, native histories, dispatch journal and the integrated patch. It contains local paths and model text and is not a release input. The deterministic reproduction sources are committed. The real coding test is opt-in:

```sh
CAT_TEST_CODING=1 CAT_CODEX_EXECUTABLE=/absolute/path/to/pinned/codex \
  node --test test/real/coding-workspace.test.ts
```

That test specifically uses the operator's existing `~/.codex-cli/config.toml` and the named `codex-cli-command-code` Keychain entry. Read it before running; it consumes real model usage and shares a durable sixteen-Turn qualification ceiling across reruns. It neither installs a different Codex binary nor modifies that source config. General users should use normal Skill setup rather than this machine-specific qualification fixture.

## Supported boundary and remaining limits

- Native ownership, binding generations, unknown execution and admission limits retain the conservative protocol: no automatic replay of an accepted uncertain Turn. No exactly-once claim for arbitrary external effects.
- Commands are restricted by macOS Seatbelt and fixed environment; trusted repository/toolchain code is assumed. Deliberately daemonized hostile programs, hostile local processes and all OS IPC are not qualified. No unrestricted fallback, networked build, external-service access or cross-platform guarantee.
- One Lead tree per coding state; use separate repository checkouts for separate coordinators. Existing read-only native catalogs are not retrofitted.
- Second-level worktrees start from the initialization commit, without ignored files or dependencies. Lead integration is explicit and reviewed; no automatic merge. Third-level writes are not implemented.
- Host commands stop on Coordinator shutdown; native text Turns can remain alive in the dedicated daemon. Accepted commands without final receipts remain inspectable and block same-call replay.
- Pending contradictory usage evidence does not erase observations or fabricate final costs. Token policy stays observe by default; depth/concurrency/lifetime controls remain hard admission limits.
- Schema 8 is a one-way migration. Stop and back up complete state before upgrading; rollback requires the matching source and backup plus reconciliation of intervening native work.

Larger coding tasks, multiple providers/credential domains, dependency provisioning, higher concurrency and broader toolchains require additional qualification before expanding these claims.
