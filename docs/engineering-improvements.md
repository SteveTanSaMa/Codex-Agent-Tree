# Beta 4 candidate engineering improvements / Beta 4 候选工程改进

> Historical first-pass record (schema 14). Current candidate continuation uses schema 15: [maintenance and durable handoff](maintenance-and-handoff.md). / 本页保留首轮结果，当前后续改进见链接。

2026-10-20. Baseline: main `9cff5bf`; published Beta 3 `b9dba2f`. Candidate: `0.1.0-beta.4`, schema 14. No release is published by this work.

## Scope and acceptance / 范围与验收

按历史性能、归档容量、异常恢复、成果交接、macOS 配置顺序实施。验收使用逐步增长的累计数据、小规模确定性回归及短时原生 CLI 集成；不追加长测或付费模型任务。必须保持授权、事务、单有效 Attempt 和未知工作不重放等现有约束。

Work proceeds through historical performance, archive capacity, recovery diagnosis, handoff and macOS configuration. Acceptance uses growing datasets, deterministic regressions and short native CLI integration, without new long-running or paid-model workloads. Authorization, transactions, single-active-attempt rules and conservative unknown-outcome recovery remain required.

## Baseline audit / 基线核对

- Beta 3 already groups Task Board dependencies/scopes, bounds status projections and isolates slow preflight RPCs. These are not new unresolved defects. / Beta 3 已完成依赖与范围分组、状态投影限界及慢预检隔离，不重复列为待修复问题。
- Main already contains `811ad57` and `d023e96`: early native tools wait for start ACK binding, including lost-ACK coverage. This candidate includes them; the published Beta 3 archive remains unchanged. / 候选包含 main 已有的早到工具等待 start ACK 绑定及丢失 ACK 回归，旧发布不变。
- Confirmed gaps: Task Board mutations/get loaded tree history; scheduling loaded settled Attempts/messages; completed tasks occupied nondeleted capacity. Unknown recovery and ambiguous-worktree refusal were conservative design choices, with insufficient operator guidance. / 确认短板是历史全量投影、调度读取已结算历史、完成任务占容量；保守拒绝未知恢复本身不是 Bug。

## Changes / 改进

### Historical queries and archives / 历史查询与归档

Task mutations/get project active tasks plus the requested dependency closure, using indexed IDs and grouped edges/scopes. Scheduler paths query queued messages and unsettled Attempts directly; existence checks avoid loading settled history. Audit rows and necessary recovery evidence remain intact.

任务读写仅投影活跃任务及所需依赖闭包，调度直接查询待投递消息和未结算 Attempt；保留全部审计及必要恢复证据。

Completion atomically records archive metadata and releases active capacity. Only pending/in_progress tasks count toward 256; reopening requires capacity and preserves dependency checks. No unfinished task is silently archived. Explicit deletion remains a tombstone, and completed dependencies remain available. Repeated request keys retain their original receipts, including pre-upgrade results.

完成时在事务内记录归档并释放容量；256 上限只统计 pending/in_progress，重新打开仍校验容量和依赖。不静默归档未完成任务；删除仍为墓碑，历史依赖可查询，旧幂等回执保持原样。

`view` and model task-list expose active tasks. `task-get` still reads archived tasks. CLI `task-history --target ID --after CURSOR --limit 50` provides bounded pages (maximum 100), including tombstones. Legacy CLI `task-list` retains its complete nondeleted array and can still be expensive; prefer paged history for large trees.

`view` 和模型列表只展示活跃任务，归档用 `task-get` 或分页 `task-history` 查询。旧 CLI `task-list` 保持完整未删除数组兼容性，大树请使用分页。

### Diagnosis and recovery / 诊断与恢复

`diagnose --state PATH` opens SQLite read-only without claiming a lease or migrating it. It identifies unknown Attempts, unresolved command receipts, malformed markers and checkout/marker gaps, with evidence locations and command argument previews. Existing `native-history`, conservative reconnect reconciliation and explicit `command-review` are reused. No automatic retry, successful-outcome fabrication or ambiguous worktree adoption is added. Marker presence alone does not establish Git identity.

只读 `diagnose` 不获取租约、不迁移数据库，输出未知 Attempt、命令收据、标记损坏及工作树标记缺口的原因、证据和操作参数。复用既有恢复命令；不会重放未知操作、伪造成功或认领身份不明的工作树。标记存在不等于 Git 身份已验证。

### Handoff / 成果交接

`agent_handoff` / CLI `handoff-record --target SOURCE --input-file JSON` persist repository, source generation, base SHA, change commit or bounded patch, dependencies and declared validation. Small untracked UTF-8 files are bundled; protected paths, links and oversized bundles are rejected. A request key fixes the original snapshot.

交接记录包含仓库、源代际、基线 SHA、变更提交或限长补丁、依赖及声明的验证结果。可携带少量 UTF-8 新文件，拒绝受保护路径、链接和超限内容；幂等键固定原始快照。

`agent_handoff_preview` / `handoff-preview --target LEAD --id ID` checks stale baselines, withdrawn generations, dirty targets, missing/unintegrated dependencies and possible conflicts using read-only Git checks. Validation text is agent-declared, never independent certification. Preview never merges or applies patches, and worktrees remain isolated. Lead reviews the preview, resolves dependencies, applies/cherry-picks explicitly in its authorized workspace, inspects the diff and runs independent verification. Large/binary untracked changes require a reviewed commit workflow. Cross-repository integration is not atomic.

预览检查过期基线、撤回代际、目标脏状态、缺失依赖及潜在冲突，不应用或合并。Lead 审查后在授权工作区显式应用或挑选提交，检查 diff 并独立验证。声明的验证不视为认证；大型或二进制新文件需提交式交接，跨仓库无原子整合保证。

### macOS environment / macOS 环境

Named tests may explicitly grant up to eight fixed `127.0.0.1` TCP ports through operator-configured `networkEndpoints`; unconfigured and adjacent ports remain denied. Generic terminal commands receive no such grant. This enables local fixture services without arbitrary outbound networking. SDK/toolchain read access reuses named `readOnlyResources`; no broad shell, DNS/domain access, arbitrary remote services or credential forwarding is introduced. Complete coding sandbox support remains macOS-only for trusted local repositories.

命名测试可由操作者显式配置最多八个固定 `127.0.0.1` TCP 端口；未授权及相邻端口仍拒绝，普通 terminal 不继承授权。SDK 继续使用现有只读资源配置；不新增任意远程联网、通用 shell、凭据透传或其他平台支持承诺。

## Cumulative microbenchmark / 累计数据微基准

`scripts/diagnostics/history-growth.ts`: isolated SQLite, 100/1,000/5,000 completed tasks, settled Attempts and processed messages; nine samples, median milliseconds. No history deletion. Task get compares original baseline with the final candidate; Attempt/message columns compare full-load filtering with indexed active queries on the same final database.

| Historical records / 历史量 | Task get before→after / 任务读取 | Attempt full→active | Message full→queued |
|---|---:|---:|---:|
| 100 | 0.425→0.223 | 0.269→0.022 | 0.252→0.041 |
| 1,000 | 3.276→0.214 | 3.413→0.016 | 2.920→0.038 |
| 5,000 | 17.516→0.202 | 21.123→0.018 | 16.559→0.042 |

Final create/delete medians are 1.753/1.380/1.620 ms. The old capacity rule rejected creation at larger sizes, so these are not equivalent before/after mutation speedups. Query plans verify primary-key dependency traversal rather than whole-tree scans. Hardware/cache variance applies; this is synthetic query evidence, not native CLI throughput or long-term qualification.

最终创建/删除中位数为 1.753/1.380/1.620 ms；旧版大数据集会先被容量拒绝，因此不宣称等价读写加速。查询计划确认按主键遍历依赖。本结果是合成数据查询基准，不代表真实 CLI 吞吐或长期资格。

## Compatibility and remaining boundaries / 兼容与保留边界

Stop the Coordinator and back up the complete state before upgrading. Schema 13→14 backfills completed-task archive metadata at migration time without rewriting historical events, timestamps or idempotent receipts; new handoff/archive tables are additive. Older binaries cannot open schema 14: restore the pre-upgrade backup to downgrade. Existing Threads retain their original tool catalogs; use the operator CLI or new Threads for new handoff tools. Existing network grants do not expand automatically.

升级前停止 Coordinator 并备份整个 state。13→14 在迁移时补归档元数据，不重写旧事件、任务时间戳和回执；新增表是增量结构。降级需恢复旧备份，不能用旧程序直接读取 schema 14。已有 Thread 不强制换绑，新工具可用 CLI 或新 Thread；权限不自动扩大。

Retained boundaries: history grows on disk; full legacy lists and explicit audit/export operations remain proportional to history. Active dependency closure may grow with the graph. Unknown external effects can remain unknown indefinitely. Conflict previews are advisory, not merge success guarantees. No exactly-once external-effect, hostile-repository isolation, arbitrary remote-service networking, cross-platform coding or multi-agent cost/quality claim is made.

保留边界：磁盘历史持续增长，完整历史读取仍与历史规模相关，依赖闭包随图增长；未知外部副作用可持续未知，冲突预览不保证合并成功。恶意仓库隔离、任意外部服务、跨平台编码和多 Agent 成本/质量优势均未获本轮证明。

## Verification / 验证

- `npm run typecheck`: passed. Default `npm test`: 22 unit + 161 integration passed; 17 conditional native cases skipped. / 类型检查通过，默认回归 22 单元 + 161 集成通过，17 条条件原生用例跳过。
- `npm run test:fault`: 44 passed. / 故障注入 44 通过。
- `npm run test:native`: 15 passed, 2 skipped, approximately 200 seconds. Actual CLI was `0.163.0-alpha.10.2` on macOS arm64. Covers daemon ownership/reconnect, abrupt command-host death, local-provider failures, lost start ACK, duplicate/late events, steering and task CLI persistence/history compatibility. Local scripted providers are deterministic fixtures, with no paid-model calls. The historical Beta 2 ZIP upgrade and alternate-version scope-replacement cases were skipped because their explicit environment fixtures were absent; they are not newly qualified by this run. / 原生 CLI 短测 15 通过、2 跳过，约 200 秒；涵盖恢复、强杀、错误响应、ACK 丢失、迟到/重复事件、引导及任务 CLI 历史兼容。使用本地脚本服务，不调用付费模型；未配置的旧 Beta 2 ZIP 升级和另一版本范围替换未获本轮资格。
- New handoff checks use real local Git worktrees and read-only merge/patch inspection; endpoint checks execute actual macOS Seatbelt profiles. New tools were not evaluated in a real autonomous model task. / 新交接检查使用真实本地 Git，端口检查使用真实 Seatbelt；未开展新工具的自主模型工程任务评估。
- Final targeted lookup checks: 33 passed; workspace/diagnosis/migration checks: 21 passed. These overlap the default suite and are not additional unique test counts. / 最后针对性查询 33 通过、工作区及诊断迁移 21 通过，与默认回归重叠，不重复计入独立数量。
- Packaged-Skill checks: 3 passed outside the checkout, including offline production-dependency use and literal task arguments. Skill validation, source/test formatting and diff whitespace checks passed. / 独立解包 Skill 检查 3 通过，Skill 校验、源码测试格式及 diff 空白检查通过。

Confirmed bugs fixed: unnecessary historical reads on active paths and completed-task capacity exhaustion. Experience improvements: archives/history pagination, actionable diagnosis, durable handoff/preview and explicit loopback test access. Existing conservative recovery and sandbox boundaries are retained. Unproven risks: very large dependency closures, long-term disk growth, arbitrary SDK/service combinations, autonomous-model handoff quality and other CLI versions beyond existing historical evidence. No long-running or paid-model test was scheduled, and simulated Runtime results are not native qualification.

已修复 Bug：活跃路径无关历史读取及完成任务耗尽容量。体验改进：归档分页、可操作诊断、持久交接预览和本地端口授权。保留保守恢复与沙箱边界。未证实风险：极大依赖闭包、长期磁盘增长、任意 SDK/服务组合、自主模型交接质量及本轮未覆盖 CLI 版本；未把模拟 Runtime 作为原生证据，未安排长测或付费模型测试。
