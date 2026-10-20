# Maintenance and durable handoff / 维护与持久交接

2026-10-20; continuation of [engineering improvements](engineering-improvements.md), baseline `1e0fe62`. Main remains an unreleased Beta 4 candidate. Published Beta 3 and prior evidence are unchanged. No long or paid-model test is part of this work.

本轮延续上一轮改进，基线为 `1e0fe62`，仍为未发布 Beta 4 候选，不修改已发布 Beta 3，不扩展长测或付费模型测试。

## Audit and implementation order / 核对与实施顺序

Prior active queries, task auto-archives and early-tool/start ACK binding fixes remain in place. Completed-task archives release active capacity, not disk space. Diagnose only discovered `.git` directories; previews had raw/generalized Git failures; commit handoffs retained SHA alone. Isolated Git reproduced detached-commit loss after HEAD movement, reflog expiration and GC. The Skill wrapper also rejected the prior candidate's new CLI commands. Growing dependency chains exposed repeated-wave graph validation.

已有活跃查询、归档和 start ACK 修复保留，不重复列为缺陷。归档只释放活跃容量。确认诊断扫描漏项、预览错误处理不足、SHA-only 交接在 GC 后丢失；另复现包装器拒绝新 CLI 命令及深依赖链重复扫描。未将其他恢复竞态直接定性为 Bug。

Priority: read-only diagnostic coverage → preview failure classification and retained artifacts → explicit integration receipts → capacity/export and upgrade backup. Acceptance requires deterministic cases, real isolated Git, growing datasets, short native CLI checks and preservation of transaction, authorization, scope, single-active-attempt and unknown-no-replay invariants.

顺序：只读诊断 → 预览及成果保留 → 整合回执 → 容量、导出和升级备份。验收采用确定性用例、真实隔离 Git、增长数据和短时原生 CLI；保留事务、授权、代际、单有效 Attempt 与未知不重放不变量。

## Diagnose / 诊断

`node scripts/cat.mjs diagnose --state "$STATE"` combines persisted `workspace_registry`/`agent_workspaces`, config, completion-marker identities and directory inventory. It reports no-Git residuals (including empty leaves), missing marked directories, mismatched/unregistered markers, malformed marker files, configuration disagreement and unprovisioned assignments. Unprovisioned with no marker may be normal, not failed execution. Metadata agreement does not prove Git identity or completed checkout. Evidence paths and recovery instructions accompany each entry. It never creates directories/markers, deletes residuals or adopts a checkout.

`diagnose` 交叉检查持久仓库与工作区身份、配置、完成标记及目录，覆盖无 `.git` 残留、标记对应目录丢失、身份不匹配和配置差异。“未创建且无标记”可能是正常未调度状态，不直接判失败。元数据一致不证明 Git 身份；输出证据位置及恢复步骤，不改动现场或认领目录。

## Preview and retention / 预览与保留

Preview returns `checks`, `checkComplete`, `status`, `issues` and `retention`. Missing commit/base objects, permissions, unavailable repositories and failed Git checks produce `incomplete` with named codes; genuine merge/patch conflict evidence is separate. `no-conflict-detected` only describes completed inspection, not successful integration or tests. Unknown error paths also remain incomplete. It never imports objects or applies code.

预览结构化返回检查完成度、错误分类和保留状态。对象缺失、权限限制、仓库不可用及检查失败不泛化为冲突，也不视为成功。`no-conflict-detected` 仅表示本次检查未发现冲突，不保证整合或测试成功；不会自动导入对象或应用代码。

Before accepting a new committed handoff, the host creates a full reachable-history Git bundle, checks its HEAD against the declared commit, fsyncs it and records SHA-256, size and path in the immutable receipt. Bundles live in `STATE/handoff-artifacts/ID.bundle`; generation takes at most the existing ten-second Git deadline and acceptance rejects bundles larger than 128 MiB. Hashing uses bounded memory. Large histories need an operator-managed artifact workflow outside this feature. Bundles may contain historical secrets; protect them like the original repository.

新提交式交接接受前，宿主生成包含完整可达历史的 Git bundle，核对 HEAD、同步并记录哈希、大小及位置。目录为 `STATE/handoff-artifacts`；沿用 10 秒 Git 超时，拒绝超过 128 MiB 的成果包。大历史需另行由操作者管理；包可能含历史敏感数据，应按原仓库保护。

Retention is indefinite, with **no automatic deletion or expiry**. Source worktree removal, HEAD movement and source GC do not remove the bundle. Preview verifies the saved checksum; absent/corrupt artifacts are reported. Legacy SHA-only records are explicitly `legacy-unretained`, never falsely backfilled. A crash before the database receipt may leave an unreferenced bundle; capacity diagnosis flags and preserves it. Explicit manual deletion invalidates artifact recovery but never deletes the receipt/audit history. There is no cleanup command in this iteration.

默认无限期保留，无自动过期或删除。源 worktree 删除、HEAD 移动和 GC 不影响包；缺失或损坏明确报告。旧 SHA-only 记录标为未保留，不伪造补录。跨文件系统/数据库边界崩溃可能留下孤立包，容量诊断会提示并保留。人工删除包会失去恢复能力，但回执和审计仍保留；本轮不提供自动清理。

For missing objects: compare the bundle SHA-256 with the saved receipt first, then an operator may explicitly run `git -C TARGET bundle verify BUNDLE` and `git -C TARGET bundle unbundle BUNDLE`. Importing objects does not change HEAD or integrate code; review and explicitly cherry-pick/merge afterward. Local checksums detect corruption, not the authenticity of an untrusted repository or backup.

对象丢失时先核对保存的哈希，再由操作者显式执行 bundle verify/unbundle。导入对象不改变 HEAD、不完成整合，仍需审查后显式挑选或合并。哈希用于检测损坏，不是对不可信数据的签名认证。

## Integration receipts / 整合回执

Operator-only command (authenticated control socket):

```sh
node scripts/cat.mjs integration-record --state "$STATE" --target LEAD_ID --input-file result.json
node scripts/cat.mjs integration-history --state "$STATE" --target LEAD_ID --after 0 --limit 50
```

```json
{"requestKey":"integration-v1","handoffId":"HANDOFF_ID","repositoryId":"default","targetBaseline":"FULL_BASE_SHA","integrationCommit":"FULL_RESULT_SHA","status":"unverified","validation":{"command":"node verify.mjs","result":"not run","evidence":"test report location"}}
```

For uncommitted outcomes, replace `integrationCommit` with `appliedArtifact` describing the actual patch/files and evidence. Status is `success`, `failed` or `unverified`, always **operator-declared**. Independent validation command, reported result and evidence location are declarations, not executed or certified by this endpoint. `hostFacts` separately records observed HEAD, dirty state, commit availability/ancestry, inspection failure and generation. Optional `commandCallId` links an existing Lead command receipt and its actual outcome, but does not certify that its command, repository or tested commit matches the declaration. `hostVerifiedSuccess` stays false. Keep Agent declarations in the original handoff; the Lead/operator must independently validate before declaring success.

回执关联原交接、目标仓库、目标基线、整合提交或实际成果、验证命令/结果/证据及状态。状态始终是操作者声明；本接口不执行或认证独立验证。`hostFacts` 单独保存 HEAD、脏状态、提交关系、检查失败及代际等观测。可引用已有 Lead 命令收据，但不据此证明命令、仓库或提交与声明相符，`hostVerifiedSuccess` 始终为 false。原交接中的 Agent 声明不替代 Lead 的独立验证。

Same key/content returns the original record even if HEAD subsequently changes; changed content conflicts. New outcomes use new keys. History is append-only with stable cursors, maximum 100 rows and a response byte bound. Same-tree and repository grants apply; descendants cannot record operator integration results. Recording a failed outcome is possible even if Git inspection fails; the failure remains in host facts. No automatic merge, cross-repository atomicity or task/message completion inference is added.

相同 key 与内容幂等返回原回执，后续状态另用新 key；历史追加、稳定游标分页。执行树和仓库授权仍校验，子 Agent 不能调用操作者整合接口。Git 检查失败仍可收录失败结果，并保留未完成检查。无自动合并、跨仓库原子性或任务/消息完成推断。

## Capacity and export / 容量与导出

```sh
node scripts/cat.mjs capacity --state "$STATE" --policy capacity.json
node scripts/cat.mjs history-export --state "$STATE" --target ROOT_ID --kind events --after 0 --limit 50
```

Policy example: `{"warnBytes":1073741824,"warnRows":1000000}` (also the defaults). Thresholds must be positive integers. Capacity reports state-file bytes, table counts, orphan artifact candidates, unreadable paths and threshold warnings on demand. It excludes external repositories/runtime homes, does not follow symlinks and is not an atomic snapshot under live writers. Counting/scanning remains proportional to history/files. This is on-demand warning output, not a background notification service or admission limit. Nothing is deleted.

默认告警阈值为 state 文件 1 GiB、表记录合计 100 万条，可通过 JSON 显式配置。按需报告文件量、表计数、孤立成果候选、读取失败及告警，不扫描外部仓库/Runtime home，不跟随链接。统计成本随历史增长，活跃写入时不是原子快照；不是后台通知或准入上限，不删除数据。

Export kinds: `events`, `attempts`, `messages` (shared FIFO cursor), `handoffs`, `integrations`; maximum 100 rows. It opens SQLite read-only without claiming an owner or migrating. Preserve `nextCursor`, use null as end-of-page sequence, and redirect JSON to protected files. Pages are observations under concurrent writes; use a stopped complete backup for a coherent export. Task history uses existing `task-history`. Large individual payloads may require smaller pages.

导出按游标分页，保留完整事件体与审计，不迁移、不认领租约。消息使用统一 FIFO 游标；任务沿用 `task-history`。活跃写入下分页不是整个历史的一次快照，需要一致导出时先做停止状态备份。大 payload 可缩小页长。

## Upgrade and restore / 升级与恢复

```sh
node scripts/cat.mjs preflight --state "$STATE"
# Stop Coordinator and separately stop native/external writers after inspecting their work.
node scripts/cat.mjs backup --state "$STATE" --destination NEW_BACKUP_DIRECTORY
node scripts/cat.mjs backup-verify --destination NEW_BACKUP_DIRECTORY
```

Schema 15 adds only `integration_results` and its history index; existing schema 14 data is not reinterpreted. Previous schema 13→14 archive semantics remain intact. Supported migration input remains schemas 1–14; source fixtures exercise legacy paths, including 14→15 with pending messages, unknown execution, task receipts and paused identity. This does not constitute new native qualification of every historical binary. Schema 15 cannot be opened by the previous schema-14 binary; downgrade requires the matching pre-upgrade backup.

schema 15 仅为整合回执新增表及索引，14 的既有数据不重新解释。仍支持 1–14 输入迁移；旧状态夹具覆盖历史路径及 14→15 的队列、未知执行、任务回执和暂停身份，不等于重新验证所有旧二进制。旧 schema-14 程序不能直接读 15，降级必须恢复匹配旧备份。

Preflight is read-only: schema compatibility, live owner, socket, integrity and required roots. It does not establish native quiescence. Backup refuses live owners/sockets, missing repository roots, source/copy changes or special files; never stops writers for you. The new destination contains copies of state, configured runtime home, registered repositories and external Git common directories, plus hashes, modes, symlink identities and original absolute paths. Source/copy inventories must match. Interrupted/failed copies remain incomplete evidence, without a completed manifest; a retry uses another destination. No overwrite or automatic restore is supported.

预检只读，核对 schema、宿主、socket、完整性和备份根，不证明原生执行已停。备份拒绝活跃宿主、socket、缺失仓库、变化的源/副本及特殊文件，不替用户停止写入者。副本含 state、配置的 Runtime home、仓库和外部 Git 公共目录，记录哈希、权限、链接身份及原绝对路径。失败副本保留现场但无完成清单；重试换新目录，不覆盖、不自动恢复。

Before restore: stop all old/new Coordinators, native and external writers; verify the manifest and hashes; preserve the current state; restore **every listed root to its original absolute path** and use the matching executable/configuration. Worktree `.git` links retain absolute paths: relocation is not supported. Never run both copies or restore an old DB over live native work. Reconcile all intervening native/external effects before dispatch; unknown stays unknown. Existing native Threads retain their original tool catalogs. Keychain secrets, external symlink targets, SDKs and unregistered resources need separate preservation/reinstallation. The backup is a stopped filesystem snapshot with inventory verification, not a power-loss or adversarial-filesystem guarantee. ACLs, extended attributes and ownership are not certified; regular file modes and contents are checked. SQLite may maintain auxiliary WAL/shared-memory bookkeeping even with read-only SQL connections.

恢复前停止所有相关写入者，验证清单，保留当前现场，按原绝对路径恢复所有根并使用匹配程序和配置。worktree 链接不支持随意搬迁；不能同时启动两份、不能用旧库覆盖仍有原生工作的现场。恢复后先对账备份后的外部副作用，未知仍未知。已有 Thread 不更新工具目录。Keychain、外部链接目标、SDK 和未注册资源需另行保留；本功能不承诺断电或恶意文件系统下的快照保证；检查普通文件权限和内容，不认证 ACL、扩展属性及所有权。只读 SQL 连接仍可能维护 SQLite 的 WAL/共享内存辅助文件。

## Evidence and remaining work / 证据与未完成事项

Growing chain benchmark (`scripts/diagnostics/history-boundaries.ts`, five read samples; creation is one operation):

| Tasks / 历史节点 | Full list ms / 完整列表 | Page 50 ms / 分页 | Full dependency get ms / 闭包读取 | Create before→after ms / 创建 |
|---|---:|---:|---:|---:|
|100|1.21|0.86|1.26|3.58→3.49|
|1,000|9.86|1.02|9.09|40.53→22.38|
|5,000|52.05|1.74|48.42|592.56→101.58|

Graph validation now uses O(V+E) topology traversal, preserving missing/duplicate/cycle checks. The total operation still projects and validates its dependency closure. Legacy full lists and large closures remain proportional to retained data, and page cost can grow with the selected tasks' dependencies. These synthetic SQLite/Git fixtures are not native CLI throughput evidence. Prior 80M/120M-token task evidence and terminated soak/dense conclusions remain unchanged.

图校验改为 O(V+E) 拓扑遍历，保留全部校验；完整列表和大闭包仍随数据增长，分页也可能被所选任务的深依赖放大。此为合成数据基准，不作为原生 CLI 吞吐证据；此前真实长任务、提前终止测试和密集测试结论均保留。

Verification: typecheck passed; default regression **22 unit + 168 integration passed**, with 18 conditional native cases skipped. Fault injection **44 passed**. A targeted **3-case real CLI suite passed** in about 55 seconds (maintenance/receipts, existing task CLI persistence, lost ACK/duplicate event transport); the maintenance case was repeated after final path fixes and passed in about 14 seconds, not counted as a fourth distinct case. These use actual Codex CLI `0.163.0-alpha.10.2`; local scripted-provider transport cases are not autonomous-model engineering evidence. Missing-object/GC tests use real isolated Git; permission/general-failure classification also uses fault injection, not a new OS security qualification. Packaged-Skill checks, Skill validation and formatting are recorded below. No long workload, paid model, release or platform-support expansion was performed.

验证：类型检查通过；默认回归 **22 单元 + 168 集成通过**，18 条条件原生用例跳过；故障注入 **44 通过**。针对性 **3 条真实 CLI 用例通过**，约 55 秒；维护入口在路径修正后重跑约 14 秒通过，不重复算第四条。使用真实 CLI `0.163.0-alpha.10.2`，本地脚本服务的传输验证不等于自主模型工程成果。对象缺失和 GC 使用真实隔离 Git；部分权限/通用失败分类采用故障注入，不是新的 OS 安全资格。未运行长测、付费模型或发布 release。

已修复 Bug：诊断漏项、预览错误处理、GC 后交接成果丢失、Skill 命令路由遗漏、深图重复扫描。体验改进：显式整合回执、容量告警、分页导出、升级预检及校验备份。保留边界：未知不重放、隔离不自动合并、权限不扩展、历史不自动清理。未证实风险：大仓库包生成成本、外部并发写入、任意 SDK/环境组合。未完成：自动清理/过期策略、自动成果导入、自动独立复验、路径迁移恢复、跨仓库原子整合；均未宣称已实现。

Fixed bugs: diagnostic blind spots, preview failure handling, SHA-only GC loss, Skill routing omissions and repeated deep-graph scans. Improvements: explicit integration receipts, capacity warnings, paged export, preflight and verified backup. Boundaries: conservative unknown handling, isolated worktrees, unchanged permissions and retained history. Unproven risks: large-bundle cost, concurrent external writers and arbitrary SDK/environment combinations. Not implemented: automatic cleanup/expiry, artifact import, independent test execution, relocated restore or cross-repository atomic integration.

Final packaging: three unpacked Skill checks passed; Skill metadata/reference validation, typecheck, formatting and whitespace checks passed. The candidate ZIP includes the maintenance procedures and all new host modules. Candidate version remains `0.1.0-beta.4`; schema changed for the integration table, not to synchronize version numbers. No tag or release was created.

最后打包：独立解包 Skill 检查 3 通过，Skill 校验、类型检查、格式及空白检查通过。候选 ZIP 包含维护文档及新增模块，版本保持 `0.1.0-beta.4`；schema 变更源于新增表，不为对齐版本号。未创建 tag 或 release。
