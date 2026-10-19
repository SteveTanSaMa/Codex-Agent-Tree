# 三组各 1,000 轮本地 Runtime 测试 / Three local Runtime profiles, 1,000 rounds each

用户要求改用非真实 CLI，三组并行各 1,000 轮。运行目录 `simulated-1000-20261019-133435`。本轮不启动 Codex CLI/daemon，不调用模型或付费 API；使用 `ControlledRuntime` 注入执行、历史及工具请求，真实执行 Coordinator、SQLite、WorkspaceBroker、Git worktree、CAS 文件写入及受限 Node 测试命令。每组独立进程、数据库、配置目录、仓库/worktree及本地状态端口。

每组组织为 Lead → Coder → Reviewer；Reviewer 继承 Coder 的工作区且只读。一轮包含两个成员的输入、文件生成/审查、受限测试、两份报告、Lead 集成及任务 create→claim→complete→delete。重复相同消息请求键验证不重复入队；相同内容的 CAS 写入重试验证幂等。每轮要求消息、输入、Attempt 完成后才计数。

- normal：正常编码、审查、消息交付和集成。
- recovery：每轮模拟 Runtime 接受启动但 ACK 丢失，本地 Attempt 进入 unknown；关闭并重建 Coordinator，从同一数据库和仍保留 Turn 的模拟 Runtime 恢复；要求原 Attempt ID、原 Turn 认领、Runtime starts 数量不增加。这不是操作系统强杀或原生 daemon 恢复测试。
- conflict：每轮真实受限测试命令持锁时，Reviewer read_file 必须 STATE_BLOCKED；命令结束后读取必须成功，且拒绝总数精确等于轮数。

最终检查 SQLite integrity/外键、消息及输入终态、无 unknown 或活动 Attempt、无未结算命令、任务归档、每 Agent 的 Runtime/business Turn ID 集合一致。脚本由 `scripts/soak/simulated.py` 同时启动，30 分钟上限，证据保留。

首次调试运行 `simulated-1000-20261019-133326` 在第 0 轮因测试器误用 spawn 返回字段失败，未计成果；修复后先通过三组各 2 轮的预检，再新建上述正式目录。未修改产品 Runtime 或放宽验收。

三组各 1,000 轮全部通过，合计 3,000 轮；各子进程 exit=0、资源清理完成。独立只读交叉核验已写入 suite 的 `validation.json`。

| 组别 | 完成轮次 | 耗时（分钟） | 额外检查 |
| --- | ---: | ---: | --- |
| normal | 1,000 | 22.00 | 正常协作与幂等重试 |
| recovery | 1,000 | 25.05 | 1,000 次接受后丢 ACK 的恢复 |
| conflict | 1,000 | 24.57 | 1,000 次持锁拒绝与释放后成功读取 |

每组均精确得到：2,000 条 Agent 消息 processed、2,000 条人工输入 processed、2,000 个任务 deleted（完成后归档）、4,003 个 Attempt completed、1,000 条受限命令收据 completed。SQLite integrity=ok、外键检查通过，无活动或 unknown Attempt，无未结算命令。模拟 Runtime 启动数恰为 4,003，和持久化 Attempt/Turn 一一对应；恢复组未因丢 ACK 增加启动。所有进程已退出。

本轮新增测试器和结果文档，产品源码未修改；类型检查与脚本格式检查通过。此前真实 CLI 超过 1,000 轮与九小时验证仍未完成，不能由本轮模拟结果替代。此轮组织为三成员，与此前四成员原生负载不同，耗时不用于直接对比吞吐。运行命令：`python3 scripts/soak/simulated.py`，可用 `python3 scripts/soak/simulated.py 2` 进行预检。

## English

The user requested three parallel non-native-CLI profiles, each running 1,000 rounds. This uses a controlled local Runtime with the real Coordinator, SQLite, workspace broker, worktrees, CAS file writes and restricted Node test commands. No Codex CLI, daemon, model or paid API is used. Each isolated team has Lead → Coder → read-only Reviewer. One round covers two inputs, coding/review, tests, reports, Lead integration and a complete task lifecycle, including message and same-content write retries.

Recovery injects accepted-start/lost-ACK outcomes and rebuilds the Coordinator against retained simulated Turn history; it is not OS process-kill or native daemon validation. Conflict tests real command locks, exact expected read refusals and successful reads after release. Final checks independently cover persistence integrity, message/input counts and terminal states, command settlement, task archival, and per-Agent Runtime/business Turn correspondence. A zero-round harness setup failure is retained separately; a two-round preflight passed before the fresh full run. All three profiles completed 1,000 rounds each (3,000 total), exited zero and cleaned up. Independent read-only validation found exactly 2,000 processed Agent messages, 2,000 processed operator inputs, 2,000 archived completed tasks, 4,003 completed Attempts and 1,000 completed command receipts per profile. SQLite integrity/foreign-key checks passed; no active/unknown execution or unsettled command remained. Simulated starts matched all 4,003 persisted Turns without duplicate dispatch. Recovery covered 1,000 accepted-start/lost-ACK reconciliations; conflict covered 1,000 expected refusals followed by successful reads. Exact durations are in the table above and machine-readable validation.json.

Only test harnesses and documentation changed; type and script-format checks passed. Native CLI 1,001-round and nine-hour qualification remain outstanding. This three-member workload differs from the previous four-member native workload, so elapsed times are not a direct throughput comparison. Reproduce with `python3 scripts/soak/simulated.py`; use argument `2` for the small preflight.
