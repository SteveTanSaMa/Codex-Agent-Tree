> 最终更新：本轮在约 1 小时 16 分钟时因测试器提前判空闲而停止，未完成九小时；分析为 review-required，自动监测已暂停。详见[失败证据与结果](v1-macos-soak-results.md)。下文保留启动时记录。

# Nine-hour soak execution / 九小时测试执行记录

状态：**已启动，未出最终结论**。正式启动时间：2026-10-18 22:32:04，预计负载结束：2026-10-19 07:32:04，watchdog 清理硬截止：07:47:04（均为 Asia/Shanghai）。方案与判定见[测试计划](v1-macos-soak-plan.md)。24 小时测试未安排，v1.0.0 未发布。

## 基线与准备

- 测试组织代码：`a9e5795`；冻结 runner SHA-256 `f8f9f0b0879a60a91cbfcfabe8a0b14555ffe5da6a62f01afd754c03faf43630`，watchdog `3e4f0e8d53af31896a7bc452aca84714743bafda8e3ce277441751159fc6665e`。
- 被测运行代码：已发布 `v0.1.0-beta.3` ZIP，SHA-256 `b686db0a00c2c0febefcfaf100f62707cfc41ec812c5dcfe96d81f7271399ef8`；正式启动前逐文件比对 32 个发布输入，无改动。
- 同哈希五分钟冒烟与清理通过：308.9 秒（含收尾），58 轮编码、1,760 次回环提供商请求；提醒、进展、引导、暂停、三次 SIGKILL 恢复和原生/业务历史核对均通过，分析 flags 为空。view 延迟中位数约 290ms、p95 约 300ms，只代表本次缩时本机结果。
- 新增 watchdog 早期死亡测试通过；默认回归 **166 pass**（17 unit + 149 integration，另有 17 个原生/候选/升级 skip）。类型、相关 JS/TS 格式、Python 语法检查通过；没有修改 Runtime 代码或旧 release。
- 预演中的失败均保留：修正 harness 对 `--test-commands` 文件参数、CLI guidance 包装层、消费状态随时间推进，以及成功报告可省略 error 字段的处理。另有主动停止的过渡版本预演。它们不计入通过次数，也没有被报告成 Runtime 缺陷。

## 正式运行

运行 ID：`nine-hour-20261018-223204`。实际证据仅在忽略的 `.artifacts/soak/` 中，启动指针为 `active.json`。初始检查确认两个独立 Coordinator/daemon 和五名成员已经启动，第一轮编码完成、原生 16 分钟静默校准正在执行，30 秒资源采样正常。

计划中的三个 Coordinator 故障窗口分别为 10 月 19 日 00:32、03:32、06:32 附近。原生 daemon 与本地提供商不随 Coordinator SIGKILL 停止。所有过程只操作合成仓库和自有短路径测试目录。

已设置本线程 heartbeat，每 30 分钟只读检查；正常状态不重复通知，失败、异常或完成时报告。最终必须同时核对 result、watchdog-result 与 analysis；仅进程存活或达到结束时间不算通过。本文件将在完成后补充最终结果，不因当前冒烟通过而预先宣布九小时通过。

## English

The nine-hour macOS soak started at 22:32:04 on October 18 and is scheduled to finish at 07:32:04 on October 19, Asia/Shanghai, with a 15-minute bounded cleanup allowance. The unchanged published Beta 3 payload runs five managed members across isolated coding and calibration lanes. The matching smoke completed 58 coding rounds and 1,760 synthetic loopback requests with all required checkpoints and no analysis flags. Default regression passed 166 cases. The full run is still in progress; no nine-hour success, 24-hour test or v1.0.0 release is claimed. A quiet heartbeat will report actionable failures or the final measured outcome.
