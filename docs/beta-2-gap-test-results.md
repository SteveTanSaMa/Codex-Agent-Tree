# Beta 2 补验结果 / Follow-up qualification

日期：2026-10-18。生产基线：`v0.1.0-beta.2` / `2c9a29f`。两个真实场景均从已发布 ZIP 运行，30 个分发文件与标签逐字节一致，包 SHA-256 为 `084aa79ec29e76fee4de6e8eaef20244ab9830aa2871dffce5a7210b685793bd`。[方案](beta-2-gap-test-plan.md)与实际测试源码一同保留。

**结论：本次选定的测试缺口已补验，没有确认新的生产实现缺陷。** 完成两个独立真实任务、原生协议负向验证、实际 SQLite 进程崩溃窗口与契约回归。排队可见性、范围传播和固定基线工作树的限制是已复现的行为，不能把测试通过写成这些限制已经消失。

## 结果分层

| 检查 | 实际结果 | 证明范围 |
| --- | --- | --- |
| 默认回归 | **139 pass**（8 unit + 131 integration）；8 native 默认跳过 | 包含新增 6 项协作/测试入口/测试预算准入用例；不把跳过算通过 |
| 故障套件 | **36 pass** | 新增 4 项 pause/cancel 事务故障用例；每项 3 个实际进程 SIGKILL 窗口，共 12 个窗口；重复执行不算额外独立保证 |
| 完整原生套件 | **8 pass，0 skip** | 真实固定 CLI、隔离 home、本地替身提供商，不调用付费模型；包含新增的引导确认丢失和 HTTP 401 |
| 真实 ZIP 多仓库编码 | **pass，4 Agent / 7 Turn**；约 264 秒 | 两个独立 Git 仓库、L2 自测、L3 静态审查、Lead 集成、重启身份连续性 |
| 真实 ZIP 执行中引导与恢复 | **pass，1 Agent / 3 Turn**；约 59 秒 | 同 Turn 引导、幂等重发、命令中断、暂停态 Coordinator SIGKILL、重启、旧范围取消与新范围执行 |
| 独立只读审计 | **pass，0 errors** | SQLite/FK、业务/原生 Turn 一一对应、实际调用与审查文件哈希、消息路径、配置连续性、测试服务清理 |
| 静态检查 | 类型、所有新增 TS 格式、Python 审计脚本语法通过 | 测试代码和诊断入口；未改生产代码 |

### 多仓库真实场景

两个合成仓库分别含一个缺陷：Core 的加法写成减法，App 的格式字符串以 `}` 结尾。已提交的 `test/unit.test.mjs` 是自包含入口，不依赖 Lead 未提交文件。

1. CoreCoder 在独立工作树实跑失败、修改 `add.mjs`、获得通过收据并向 Lead 报告。
2. Lead 集成 Core；AppCoder 修正 `format.mjs`，同样保留失败→通过收据，再创建继承其工作树的三级 Reviewer。
3. Reviewer 实际读取 App 修改和 Core 依赖，并向 AppCoder 回报；只做静态审查，不声称运行过测试。
4. AppCoder 的 Core 工作树仍是注册时的减法基线；独立文件核对确认没有复制 Lead 的未提交修改。Lead 最终集成 App，在原始两个仓库上获得 `MULTIREPO_GOLDEN_PASS`，独立 golden 再次确认结果。
5. 4 个 Thread、7 个 Turn 全部 completed；真实原生时间区间的最高并发为 2，没有同一 Agent 的重叠 Turn。正常重启后绑定和 Turn 数不变。

审计同时读取原生 rollout 的真实 `function_call`/输出，核对两名 L2 的写入集合仅含其模块，L3 两次成功读取的内容 SHA-256 与输出相符。三条 Agent 报告路径恰为 CoreCoder→Lead、Reviewer→AppCoder、AppCoder→Lead，全部 processed。

### 交互与崩溃真实场景

同一个 Agent 先运行 12 秒合成命令。命令已实际启动后，脚本发送 steer 并以同 key/内容重复提交，确认返回幂等。最终输出 `GUIDED_SAME_TURN`，Native Turn ID 不变，累计仍为 1 Turn。

第二次显式要求执行该命令，文件计数达到 2 后立即暂停。该次测得从请求到观察为 idle 约 **584 ms**，原生状态为 interrupted；这是单次样本，不是延迟 SLA。随后排队旧任务，在暂停状态对本测试拥有的 Coordinator 做真实 SIGKILL，再通过正式 start 恢复：绑定、暂停状态和累计 2 Turn 保持。

使用现有 `cancel` 明确撤销旧排队范围，再 resume；没有新工作时没有额外 Turn。提交替代范围后，第三个 Turn 完成 `FINAL_REPLACEMENT_DONE`。文件计数始终为 2、命令收据恰为 2，没有恢复时自动重放，也没有第三次执行命令。

中断 Turn 已观察到 **10,340 tokens**，但没有最终用量，账本保留未 finalized；其输入消息消费状态为 unknown。两个已完成 Turn 的输入 processed，被撤销的旧任务 cancelled。没有伪造 ACK、补零或重投 unknown。

### 原生与 SQLite 故障覆盖

- **引导确认丢失**：真实固定 CLI 接受 steer 后，故障适配器故意丢弃调用方收到的确认。重启仍采用原 Native Turn，引导保持 unknown；相同 key 不重复 steer，也不新增 Turn。此为指定调用方故障窗口，不冒充随机网络丢包测试。
- **HTTP 401**：本地明确选择的提供商返回 401，使用假的测试凭据；真实 CLI 产生一个 failed Attempt，没有业务重试。仅验证该配置路径，不能据此宣称所有远程提供商的认证、路由和重试策略均兼容。
- **控制事务 SIGKILL**：在子树 pause/cancel 的事务中、提交后分别杀死实际存储进程。父子 fence、desired 和 Agent/人工两种 queued 消息的状态保持原子；Native 执行仍需单独对账。这不是断电持久化或完整 Runtime 故障证明。

## 独立核算与清理

两个真实提供商场景共 **10 Turn**，低于预先配置的 10+3=13 上限，未用完的 3 个名额未使用。9 completed、1 interrupted；原生历史与业务 Attempt 的 10 个 Turn ID 一一对应，无新增执行 unknown。

观测用量合计 **423,938 total tokens**（包含缓存输入及上述未最终结算的部分用量），不是最终账单；没有把工具调用数当作模型请求数。没有在失败后新建团队重试真实任务，初始任务后的交互输入由脚本在预定条件下自动发送，没有人工修补代码或纠正模型。

既有运行配置、原第三方配置逐字节未变；只停止本次测试拥有的 Coordinator/daemon，独立核对其已记录 Native PID 不再存活。合成仓库、工作树及状态保留在本地用于检查，原始证据不分发。

初跑日志与会话工具记录保留了测试夹具修正过程：直接调用 Store.spawn 没有触发 Coordinator 的工具调度、在配置冻结前加入未提交文件，以及漏建测试 state 目录，均属夹具错误。修正后走实际工具路径并使用正确初始化顺序；不是生产修复。真实模型两项首次执行即通过。

真实场景完成后进一步加强了测试入口：在任何进程/RPC 启动前以独占文件预留场景名，避免崩溃丢失返回身份后重跑付费场景。该防重改动通过离线用例验证，未因此重跑模型；真实执行时的原驱动另存本地。

## 复现入口与保留边界

- `npm test`、`npm run test:fault` 运行确定性和实际沙箱/进程检查。
- `npm run test:native` 需明确选择匹配的 `codex`；`CAT_TEST_CODEX` 与进程 PATH 只用于该次测试，不替换全局 CLI。
- 真实场景默认跳过。显式设置 `CAT_TEST_GAP_REAL=1`、`CAT_GAP_SKILL`（已安装 Beta 2）、`CAT_GAP_EXECUTABLE`、`CAT_GAP_PROVIDER_CONFIG`、`CAT_GAP_PROVIDER_ENV`、可选 `CAT_GAP_KEYCHAIN_SERVICE`，再执行 `node --test --test-concurrency=1 test/real/beta2-gaps.test.ts`。ENV 参数是变量名，不是密钥值。新的明确授权批次使用独立 `CAT_GAP_EVIDENCE`；不要删除旧准入记录来重置本批次。
- `python3 scripts/diagnostics/beta2-gap-audit.py EVIDENCE_ROOT` 只读审计保存的数据，不启动 Runtime。

本次仍不能证明任意第三方提供商、任意事件时序、生产级恶意代码隔离、外部副作用 exactly-once，或多 Agent 的质量/成本优势。15/10 分钟提示值的适用性仍需要更广泛负载校准。排队内容可见、引导不广播、固定基线不复制未提交文件均是明确契约；安全替换范围须使用现有控制流程，不能只给 Lead 一条新提示就假定旧队列已撤销。

## 收录复核 / Collection check

2026-10-18 收录时重新执行类型、格式、默认回归和故障测试：全部通过。默认回归分为 8 个 unit 通过，以及 integration 的 131 通过 / 8 native 跳过，合计 **139 通过**；故障测试 **36 通过**。原生 8 通过与真实任务 2 通过沿用上述补验证据，本次没有重跑，不作为新增执行计数。

收录范围仅为本方案列出的测试、夹具、审计脚本与报告；本地 `test/rigorous/` 历史诊断草稿不属于本次成果。没有收录凭据、原始 rollout、状态数据库或机器专用证据，也没有修改已发布 Beta 2 的 tag、ZIP 或生产代码。后续改进和兼容性资格验证见[计划与验收目标](post-beta-2-plan.md)；计划尚未实施。

Collection rechecked type/format, 139 default passes (8 native skips) and 36 fault passes. Native and real-provider results remain the earlier evidence, without new model execution. Only the scoped tests, fixtures, audit script and reports are collected; local diagnostic drafts and private raw evidence are excluded. The published Beta 2 payload and production code are unchanged. The [next plan](post-beta-2-plan.md) is proposed work, not implemented behavior.

## English summary

The released Beta 2 payload passed two new synthetic real-provider workflows with 10 total Turns (9 completed, 1 interrupted), within a predeclared 13-Turn ceiling. No paid retry or manual model correction was used. Multi-repository coding verified actual failing/passing child tests, inherited read-only review, fixed-base dependency behavior, Lead integration and restart continuity. Interactive control verified same-Turn steering, idempotency, immediate command interruption, a paused Coordinator SIGKILL, preserved bindings and explicit cancellation before replacement work.

Final gates: 139 default passes (8 native skips), 36 fault passes, 8 separately enabled native passes and 2 real workflow passes, plus type/format checks. Independent read-only audit matched all native/business IDs, actual tool calls and file hashes. Existing configurations were unchanged and test-owned services stopped. One interrupted Attempt retains partial usage and unknown final usage/consumption rather than fabricated zero or replay. Observed total usage was 423,938 tokens including cached/partial usage, not a bill.

No new production defect was confirmed. Queued visibility, non-broadcast steering and fixed-base worktrees remain documented limitations. These bounded samples do not establish production certification, arbitrary provider compatibility or a general quality/cost advantage.
