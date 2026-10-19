# Native CLI dense load / 真实 CLI 密集负载

用户授权：三套独立环境同时运行一小时，取消轮间等待，目标每套 200 轮/分钟，检查超过 1,000 轮后的累计任务与消息。使用真实 Codex CLI、已发布 Beta 3 安装副本及本地合成 Responses 服务；不调用付费模型。轮次表示一次三成员编码、报告、Lead 集成与任务验证的完整业务循环，不等于 HTTP 请求数或模型能力评价。

- normal：两名 coder 并发，继承工作区的 reviewer 等待 coder 完成；Lead 集成并精确核对文件，确认所有输入/报告的 completed Attempt。
- recovery：同时执行编码循环，在校准团队活动 Native Turn 期间约每分钟 SIGKILL Coordinator，校验稳定绑定、原 Attempt/Turn 认领、不重复执行。启动阶段仍检查引导、暂停及进展警告。
- conflict：每十轮安排一次 coderA 的受限测试命令持锁；reviewer 第一次读取应明确 STATE_BLOCKED，等待命令结束后再次读取成功。必须精确匹配预期拒绝次数、工具、身份和错误码；其他拒绝仍失败。两名 coder 保持并发。

每套有独立的 SQLite、CLI 配置目录、Git 主仓库与 worktree、本地随机端口、Coordinator、专属 watchdog 及冻结测试器。每套编码树四成员；恢复校准载体另有独立 Root。三个环境分别位于不同 `/tmp/cat-soak-*`，不共享用户工程。已完成任务只有在本轮验证通过后才通过 CAS API 删除，审计历史保留，不提高 256 个未删除任务的上限。

密集模式取消轮间等待和合成服务的固定响应延迟；CLI 与真实工具耗时仍存在，不用模拟 Runtime 替代，不修改产品调度来制造吞吐。每轮精确核验、每五轮 view、每十轮累计 Attempt 报告；完成第 1,001 轮单独记录。最终核对 SQLite 完整性、消息消费、单 Agent 单 Attempt、未知执行、命令收据以及 Native/business 历史一致性。

先跑匹配哈希的三套五分钟预检，要求全部结束并清理、恢复与冲突路径实际覆盖，才能启动三套 3,600 秒正式运行。启动器：`scripts/soak/dense.py`；证据指针 `.artifacts/soak/dense-active.json`；汇总器 `scripts/soak/dense-analysis.py`。watchdog 允许额外十五分钟清理，不计为业务负载时间。不自动重测，不发布 release。

结果分三维：正确性、超过 1,000 轮、实测每分钟 200 轮。未达到吞吐或轮数标记 targets-not-met；执行异常标记 review-required。不得用请求数、三套合计或机械完成冒充每套目标达成。

## English

Three isolated native CLI environments run concurrently for one hour with no inter-round delay. The per-environment target is 200 completed business rounds/minute and more than 1,000 rounds. A round includes coder work, reports, Lead integration and causal/file/task validation; it is not an HTTP request. Native Codex CLI and the published Beta 3 payload execute against a local synthetic Responses provider with no paid models.

Profiles cover normal coding collaboration, repeated Coordinator crashes during active native execution, and controlled shared-workspace contention followed by successful reads after lock release. Each environment has independent databases, configuration homes, repositories/worktrees, loopback ports and watchdogs. All native bindings, Attempts, messages, command receipts, SQLite integrity and final native histories are checked. Completed tasks are archived through the existing CAS API only after successful verification.

A matching three-profile five-minute preflight must complete and clean up before the one-hour suite starts. Correctness, the 1,001-round milestone and measured throughput are reported separately. Missing load targets is explicitly targets-not-met; execution failures require review. Synthetic requests, aggregate team rates, or mere process completion never establish the per-team target. No automatic retry or release publication is included.


## 预检发现与候选基线 / Preflight finding and candidate baseline

首套三组预检 `dense-smoke-20261019-101155` 的 normal 在第 45 轮发现首次 agent_ack 到达早于 turn/start ACK 本地绑定，Native 输出为 FORBIDDEN: Tool request does not belong to the active Turn；业务 Attempt 最终 completed，但未确认消息转为 unknown。没有自动重放此消息。修复 Coordinator：工具请求等待本进程对应 thread 的 start dispatch 结果，再以权威 ACK/事件形成的绑定认证；不根据工具请求自报 Turn ID 绑定，不放宽伪造 Turn 或失效连接校验。确定性回归在 start ACK 前触发正确与伪造请求，确认 ACK 前都不执行，ACK 后只有正确请求成功。

本次正式负载须使用带此修复的独立候选安装副本，原 Beta 3 安装包与 release 保持不变。启动器同时校验预检与正式运行的 Runtime 源文件指纹和冻结 harness 哈希。首套失败证据保留，不计作预检通过。

The initial three-profile preflight exposed an early-tool race: agent_ack reached the host before the start ACK was locally bound and was rejected; its message became unknown after a completed Attempt. The failed work is retained without replay. The fix waits for this host's dispatch binding before authenticating tool requests, without trusting caller-supplied Turn IDs. A deterministic test checks early valid and forged requests. The full load uses a separate candidate install with this fix; published Beta 3 assets stay unchanged. Matching Runtime payload fingerprints and frozen harness hashes are mandatory between preflight and full load.
