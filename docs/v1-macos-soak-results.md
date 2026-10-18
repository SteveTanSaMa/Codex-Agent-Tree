# Nine-hour soak attempt: early stop / 九小时负载首轮提前停止

运行 ID：`nine-hour-20261018-223204`。正式启动：2026-10-18 22:32:04；停止：23:48:19；watchdog 收尾完成：23:48:21（Asia/Shanghai）。实际运行 **1 小时 16 分 15 秒**，未达到计划九小时。**本轮不通过：runner failed，分析结果 review-required；不据此发布 v1.0.0。** 方案见[测试计划](v1-macos-soak-plan.md)，启动事实见[执行记录](v1-macos-soak-progress.md)。

## 停止条件与只读核查

第 77 轮文件验收发现 Lead 的 `b.txt` 为 `76\n`，预期 `77\n`，触发停止。计数器已到 77，不代表 77 轮均完成验收；之前 76 轮已完成。

现有证据支持 **harness 的空闲判定存在竞态，提前读取了整合结果**，没有确认 Runtime 丢失或未执行该报告：

| 时刻（UTC） | 已保存事实 |
| --- | --- |
| 15:48:16.352 | coderB 第 77 轮报告持久入队；收尾数据库中其状态为 processed |
| 15:48:16.889 | Lead 最后一个业务 Attempt 创建，输入含 reviewer 与 coderB 的第 77 轮报告 |
| 15:48:16.898 | harness 抛出 `Lead failed to integrate coderB`，文件仍是第 76 轮 |
| 15:48:17.126 | 原生 rollout 记录该 Lead Turn 的 terminal 调用，命令明确将 `b.txt` 写为 `77\n` |
| 15:48:17.366 | 同一原生调用的结果收据为 exitCode 0、SOAK_VERIFY_PASS |
| 收尾后只读核查 | Lead 的 `a.txt`、`b.txt` 都是 `77\n`；编码树 389 个 Attempt 全部 completed；231 条 Agent 报告与 231 条人工输入均 processed |

冻结的 `idle()` 先查询活动 Attempt，再用另一连接查询 queued 消息，二者不在同一数据库快照内。如果第一次查询时消息尚未派发、第二次查询前消息转为 delivering 并创建新 Attempt，就可能同时得到“无活动 Attempt”和“无 queued 消息”，在实际执行期间返回空闲。上述原生时间线直接证明，本次断言早于最后一条整合命令。

这不等于宣称所有 Runtime 路径无缺陷，也不能把停止后的最终文件正确改写成本轮通过。后续应为该转换窗口增加确定性反例，并改用一致快照和每轮因果完成屏障，等待预期报告/整合回执与文件结果共同满足；本次监测只读调查，**没有修改冻结 harness、重放工作或启动复跑**。

## 已获得与未获得的证据

- 提供商请求 2,190 次，均为本地合成 Responses；约 572 MB 累计请求正文，不是 token 数或账单。
- 真实静默 16 分钟校准通过：默认 10 分钟无可观测进展、15 分钟自主提醒各出现一次，没有自动暂停。
- 真实持续进展 16 分钟校准通过：有自主提醒，无停滞提醒。它校验提示机制，不证明阈值对所有真实任务都最优。
- 同 Turn 引导、稳定 key 重试和立即暂停/恢复检查通过；5 个增量合成 token 提醒事件覆盖 5 个不重复阈值。
- 153 次资源采样，最大间隔约 30.247 秒。编码 Coordinator/native 峰值 RSS 分别约 116/138 MiB，校准 Coordinator/native 约 121/106 MiB；数字 FD 峰值分别 19/51/19/44。没有触发绝对资源上限；**时长不足，不作九小时资源稳定性结论**。
- 15 次操作者 view：中位数约 336 ms，p95 约 344 ms；只代表本次机器和这段负载。
- 两个业务数据库 integrity_check=ok、FK 无错误。校准树有 4 个 completed 与 1 个计划暂停产生的 interrupted Attempt，保留一条 unknown 消费记录；不是 unknown 执行，也未重投。
- 计划第 2/5/8 小时的三次崩溃窗口均未到达，最终全量原生/业务历史检查未执行；不能挪用缩时测试把这些正式窗口记为通过。

分析 flags 为 runner-failed、cleanup-or-watchdog-review、early-last-sample、缺三次 recovery、缺最终 native history、insufficient-duration。cleanup-or-watchdog-review 由 runner 非零退出触发，**不表示清理已失败**：watchdog 记录 runnerExitCode=1、forcedDeadline=false，两个 Coordinator、两个 native daemon、runner 和 watchdog 的记录 PID 均已退出。采样提前结束由整轮提前停止导致，期间没有发现长采样中断。

## 收尾

本轮证据保留于忽略的运行目录及自有 `/tmp/cat-soak-*` 状态，未写入 ZIP。正常清理机制已执行，没有强行等到原截止时间；heartbeat `codex-agent-tree` 已置为 PAUSED，避免继续检查已结束测试。没有付费模型调用、自动复跑、旧 release 变更或正式版发布。此前约 8,000 万和 1.2 亿 token 的真实长任务证据继续保留，本轮测试器问题不否定那些实际运行事实。

## English

The planned nine-hour run stopped after 1h16m15s, at 23:48 on October 18, Asia/Shanghai. It is **not a pass**: runner failed and analysis requires review. Round 77 observed the previous coderB value before Lead's last integration command executed. Preserved native logs then show that command writing the expected value and completing successfully; final files are correct, all 389 coding Attempts completed, and all 231 Agent reports and 231 operator inputs were processed.

The evidence supports a harness quiescence race: active-Attempt and queued-message queries use separate snapshots, allowing dispatch between them to produce a premature idle result. No Runtime loss is confirmed, and eventual correctness does not convert this interrupted run into nine-hour qualification. No frozen harness was changed and no work was replayed or rerun.

Real-time quiet/progress warnings, live guidance and pause checks passed; 153 samples and five unique synthetic reminder thresholds were collected. The planned 2/5/8-hour crashes and final full native-history audit were not reached. Both business databases passed integrity/FK checks. Watchdog cleanup completed, recorded test PIDs exited, and the heartbeat was paused. Existing large real-model workload evidence remains valid; no paid-model test, old-release change or v1.0.0 publication occurred.
