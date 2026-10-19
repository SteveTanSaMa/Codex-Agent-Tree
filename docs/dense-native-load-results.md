# 一小时密集负载结果 / One-hour dense load results

2026-10-19，macOS arm64，真实 Codex CLI `0.163.0-alpha.10.2`、本地合成 Responses 服务，无付费模型。suite：`dense-hour-20261019-102508`；北京时间约 10:25–11:25。候选源提交 `d023e96`，基于 Beta 3 加早到工具绑定修复；原 release 未修改。启动、冻结哈希与 Runtime 文件指纹位于本地 `.artifacts/soak/dense-active.json` 及 suite 的 `launch.json`。

三组均运行满 3,600 秒、完成最终 Native/business 历史对账，watchdog exit=0、forcedDeadline=false，已核验所记录测试进程退出。**本次范围内的正确性检查通过，但三组负载目标均未达成：没有任何一组超过 1,000 轮，也没有达到 200 轮/分钟。** `dense-analysis.py` 对三组均给出 `targets-not-met`、正确性 flags=[]。不将三组合计、请求数、缩时预检或机械结束算作目标通过。

| 组别 | 完成业务轮数 | 实测轮/分钟¹ | 本地请求数 | 已删除完成任务 | 已处理 Agent 消息 | 已处理人工输入 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 正常协作 | 649 | 10.77 | 21,060 | 1,778 | 1,947 | 1,947 |
| 反复恢复 | 654 | 10.86 | 21,222 | 1,768 | 1,962 | 1,962 |
| 工作区冲突 | 617 | 10.26 | 20,262 | 1,720 | 1,851 | 1,851 |

¹ 按完整报告 elapsedMs 计算，含启动、末轮收尾与清理，约 60.1–60.3 分钟。`completedRounds` 是通过本轮因果、文件和任务验证的轮数；一次业务轮包括三成员工作及 Lead 整合，不等于一次 Turn 或 HTTP 请求。批量消息可以减少 Lead Attempt 数，所以任务数不必等于三倍轮数。

- 编码树累计 completed Attempt：3,729 / 3,734 / 3,575；三组 SQLite integrity=ok、外键检查通过、无遗留执行中或 unknown Attempt，所有编码输入和 Agent 消息 processed。任务完成后经正常 CAS API 删除，审计历史仍在；已超越 256 个累计任务，未提高 256 个未删除任务的限制。
- 恢复校准载体完成 **58 次** 活动 Native Turn 期间强杀 Coordinator 后恢复，绑定、原 Attempt/Turn 与最终历史校验通过；另通过进展、静默、执行中引导和暂停检查。校准载体有 62 completed + 1 planned interrupted Attempt；人工输入 62 processed + 1 unknown，后者来自明确的暂停中断，不是 unknown 执行，不曾重放。16 个 pending 校准任务是产生可观测进展的探针，未宣称其业务完成。
- 冲突组精确匹配 **62 次** reviewer `read_file` 的预期 STATE_BLOCKED，并在命令结束后再次读取成功；身份、工具及错误码均检查，其他拒绝仍失败。正常组与恢复组没有预期工具拒绝。
- 单个所采样进程峰值 RSS 约 398 / 394 / 375 MiB。本地服务分别接收约 51.54 / 51.24 / 48.02 GiB 请求正文，**不是 token 或付费使用量**。最初约 15–18 轮/分钟，后期下降；本次未隔离 CLI 上下文增长、重复全历史扫描、工具/控制进程启动与磁盘竞争的贡献，不能直接将其归因于产品调度器或外推真实模型吞吐。

## 预检与修复证据

首套 `dense-smoke-20261019-101155` 正常组第 45 轮失败：Native 首次 agent_ack 早于 turn/start ACK 本地绑定，被 FORBIDDEN 拒绝，未确认消息最终 unknown。保留原证据，不重放。Coordinator 现在等待本进程启动绑定结束再认证，不能根据请求自报 Turn ID 认领；伪造 Turn 和丢失 ACK 的回归仍拒绝工具。未通过增加响应延迟掩盖竞态。

修复后独立预检 `dense-smoke-20261019-101854` 三组分别 83 / 84 / 73 轮，通过 Native 历史对账和清理；正式运行 Runtime 指纹与冻结脚本哈希匹配。默认回归 176 通过、17 条件跳过，故障注入 44 通过。旧九小时测试及更早真实长任务证据保留。没有自动追加时长或重测，没有发布新版本。

**尚缺：每组超过 1,000 完整轮的累计消息验证、200 轮/分钟目标，以及完整九小时运行。** 本次每组数千条累计消息/任务提供了证据，但不能替代这些未达成的验收条件。

## English

Three isolated native CLI environments ran concurrently for one hour on macOS arm64 against a local synthetic Responses provider, without paid models. Suite `dense-hour-20261019-102508` ran approximately 10:25–11:25 Asia/Shanghai on October 19. Candidate source `d023e96` includes the early-tool binding fix; published Beta 3 assets remain unchanged.

| Profile | Completed business rounds | Actual rounds/minute | Local requests | Archived completed tasks | Processed Agent messages / operator inputs |
| --- | ---: | ---: | ---: | ---: | ---: |
| Normal | 649 | 10.77 | 21,060 | 1,778 | 1,947 / 1,947 |
| Recovery | 654 | 10.86 | 21,222 | 1,768 | 1,962 / 1,962 |
| Conflict | 617 | 10.26 | 20,262 | 1,720 | 1,851 / 1,851 |

All three completed their one-hour duration, SQLite integrity/foreign-key checks, final native/business history reconciliation and watchdog cleanup. Recorded test processes exited. Coding trees retained no active or unknown Attempts, and all coding messages/inputs were processed. Completed tasks were archived through the existing CAS API with audit history retained. **Correctness checks within this workload passed, but every profile is targets-not-met: none exceeded 1,000 rounds or achieved 200 rounds/minute.** Rates use total reported elapsed time including startup and cleanup. Requests, aggregate counts and preflights are not substituted for per-profile targets.

The recovery auxiliary completed 58 crash/recovery checks preserving the same Attempt/Turn and bindings, plus guidance, pause and progress checks. Its single unknown input belongs to an intentionally interrupted Turn, not unknown execution; it was never replayed. Sixteen pending calibration tasks are progress probes, not completed business tasks. The conflict profile matched 62 expected reviewer read refusals while a shared workspace was command-locked, then read successfully after release; unexpected refusals still failed validation.

The first preflight exposed a real early-tool/start-ACK race. The fix waits for authoritative host binding before authentication; forged Turn IDs and lost ACKs remain unauthorized. The corrected preflight passed 83/84/73 rounds with matching frozen harness and Runtime fingerprints. Default regression: 176 passed, 17 conditional skips; fault injection: 44 passed.

Peak sampled process RSS was approximately 398/394/375 MiB. Received local HTTP bodies totaled 51.54/51.24/48.02 GiB; these are not tokens or billed usage. Throughput declined from its initial 15–18 rounds/minute. This experiment did not isolate growing native context, repeated history scans, control-process startup and disk contention, so it does not establish the cause or real-model throughput. Per-profile 1,001-round validation, the 200/minute target and a complete nine-hour run remain outstanding. No automatic extension/retry or release publication was performed.
