# Beta 2 qualification / Beta 2 验收

Release candidate: `v0.1.0-beta.2`, 2026-10-18. This document records release checks separately from the bilingual change-only release notes.

候选版本：`v0.1.0-beta.2`，2026-10-18。发布验证与仅包含变更的双语 Release 说明分开记录。

## Scope / 范围

macOS arm64, Node >=26.3.1, exactly `codex-cli 0.162.0-alpha.17.2`, one credential domain, trusted local repositories. The release includes schema 12, multiple repositories/worktrees, external read-only resources, interactive guidance, unlimited interactive lifetime Turns, token reminders and the default 20-member lifetime ceiling. This is a prerelease, not a production-isolation or exactly-once side-effect claim.

限定 macOS arm64、Node >=26.3.1、精确 CLI 版本、单凭据域和可信本地仓库。包含 schema 12、多仓库/工作树、外部只读资源、交互引导、交互模式不限累计 Turn、用量提醒及默认累计 20 成员。预发布不构成生产隔离或外部副作用 exactly-once 保证。

## Release checks / 发布检查

The candidate was exported from the Git index into a clean directory, followed by a fresh locked dependency install. No local diagnostic harness or raw evidence was included.

候选源码从 Git 暂存区导出到干净目录，重新安装锁定依赖；不含本机专用诊断或原始证据。

| Check / 检查 | Result / 结果 |
| --- | --- |
| Clean `npm ci --ignore-scripts` | Passed / 通过 |
| Typecheck and full configured formatting / 类型与完整注册格式检查 | Passed / 通过 |
| Default regression / 默认回归 | 133 passed: 8 unit + 125 integration; 6 native cases skipped here / 133 通过，6 项原生测试在此默认跳过 |
| Fault injection / 故障注入 | 32 passed / 32 通过 |
| Native daemon integration, enabled separately / 单独启用原生集成 | 6 passed, 0 skipped; retained exact-version CLI, no paid model calls / 6 通过、0 跳过，使用保留的精确 CLI 版本，无付费模型调用 |
| Skill metadata and local documentation references / Skill 元数据及本地文档引用 | Passed / 通过 |
| Repository-independent ZIP regressions / 仓库外 ZIP 回归 | Included in default tests: literal task passing, referenced files, packaged coding workspace / 默认套件包含原样任务传递、引用完整性和打包编码工作区 |
| Fresh ZIP install / 全新 ZIP 安装 | Extracted outside the checkout; actual `setup` and `doctor` passed / 仓库外解压，实际 setup 与 doctor 通过 |
| Reproducibility / 可重现打包 | 30 files; repeated builds and clean-source build byte-identical; every payload file matches source / 30 文件，重复及干净源码打包一致，内容逐字节匹配源码 |

ZIP SHA-256: `084aa79ec29e76fee4de6e8eaef20244ab9830aa2871dffce5a7210b685793bd`.

Native integration covers detached CLI lifetime, multiple repository cwd/tool registration, independent Threads and reconnect ownership, restart before first Turn, expected-ID steering against a local fixture provider, and task/CAS/wait persistence. It does not repeat paid-model recovery windows or establish arbitrary provider history completeness.

原生集成覆盖独立 CLI 生命周期、多仓库 cwd/工具注册、独立 Thread 与重连归属、首次 Turn 前重启、本地替身提供商的 expected-ID 引导，以及 Task/CAS/wait 持久化；不等于本轮重跑了付费模型恢复窗口或证明任意提供商历史完整。

## Existing-team evidence / 既有团队证据

The earlier [upgrade validation](upgrade-validation.md) records the stopped-state backup, schema migration, unchanged identities/configuration and actual third-party-model steering/pause. A subsequent representative engineering continuation retained the existing team, reached 10 lifetime members and 34 retained Turns (16 new Attempts, all completed), with observed peak concurrency 3. Target files, runtime configuration and old native bindings were unchanged. Independent verification passed 361 research tests; these are workload tests, **not 361 Agent Tree runtime tests**. The run included operator guidance and is not an independent one-shot trial. Raw workload artifacts and target-derived material remain local and are excluded from the repository and ZIP.

既有[升级记录](upgrade-validation.md)涵盖停机备份、迁移、身份/配置连续性和真实第三方模型引导/暂停。随后真实工程续作保留原团队，累计 10 成员、34 Turn（新增 16 个 Attempt 全部 completed），实测最高并发 3；目标文件、运行配置与旧绑定不变。361 项研究测试独立通过，但**不是 Agent Tree 的 361 项 Runtime 回归**。本次包含操作侧引导，不算新的独立 one-shot。原始负载证据与目标派生内容仅保留本地，不进入仓库或 ZIP。

## Remaining limits / 保留边界

- A queued message can be visible in status before formal delivery; queueing is not a content-isolation boundary. ACK and task completion remain separate.
- Scope changes must reach the relevant descendants; an older queued assignment can start a later Turn unless explicitly handled. Check pending messages after changing scope.
- Fixed-base child worktrees do not include Lead's uncommitted test entrypoints. Register self-contained test commands or include the required entrypoint in the base; Lead still verifies integrated results. No general child terminal permission was added.
- Unknown usage/consumption remains unknown when final evidence is absent; it is not zero usage or permission to replay. The continuation retained one unknown Agent-message consumption receipt and an earlier interrupted probe's unknown final usage, with no new unknown execution.
- No new long-running or paid-model test is required by these release checks. The continuation does not prove multi-Agent quality/cost superiority, calibrated warning thresholds, arbitrary provider compatibility or every recovery race.

- 排队消息可在正式投递前通过状态被读取，不能把排队当成内容隔离；ACK 与任务完成分开。
- 范围变更需传达给相关子成员，旧排队任务可能触发后续 Turn；变更后检查待处理消息。
- 固定基线子工作树不含 Lead 未提交的测试入口，应提供自包含注册测试或在基线中准备入口；Lead 仍复验集成结果。没有扩大低层 terminal 权限。
- 缺证据的未知用量/消费不等于零消耗或允许重放。本轮保留一条 Agent 消费 unknown 和旧中断探针未知用量，没有新增执行 unknown。
- 发布检查不安排新的长时间或付费模型测试；不据本轮宣称多 Agent 质量/成本优势、告警阈值校准、任意提供商兼容或所有恢复竞态已验证。
## Subsequent gap qualification / 后续补验

2026-10-18: the [follow-up qualification](beta-2-gap-test-results.md) adds independent synthetic real-provider workflows, subtree-control crash windows and native steering/authentication negatives. Its current results are separate from the release-time counts above; published Beta 2 assets remain unchanged.

同日[后续补验](beta-2-gap-test-results.md)已完成独立合成真实任务、子树控制崩溃窗口和原生引导/认证负向检查；当前结果与上述发布时计数分开，已发布安装包保持不变。
