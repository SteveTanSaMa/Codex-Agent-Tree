# Existing-team upgrade validation / 既有团队升级验证

## 2026-10-18

本轮补验上一轮未执行的既有团队升级、真实第三方模型执行中引导，以及六项默认跳过的原生集成测试。采用短暂停机备份后原状态重启，不是无停机替换进程。未开展长时间、多轮研究负载，也不评价研究质量。

This run covers the previously deferred existing-team upgrade, live guidance with the configured third-party model, and all six normally skipped native integration tests. The upgrade uses a brief coordinated stop, backup and restart of the same state, rather than a zero-downtime process replacement. No long-running research workload or research-quality evaluation was performed.

| Check / 检查 | Result / 结果 |
| --- | --- |
| Stopped-state backup / 停机备份 | Full state copied before migration; original runtime configuration retained / 迁移前备份完整 state，保留原运行配置 |
| Schema migration / 数据库迁移 | 10 → 12; SQLite integrity check passed / 完整性检查通过 |
| Identity continuity / 身份连续性 | All 5 Agent IDs, native Thread IDs and binding generations preserved / 5 个成员身份与绑定均保持 |
| Historical execution / 历史执行 | All 16 historical Attempts preserved; exactly 2 new test Attempts / 原 16 个 Attempt 保留，仅新增 2 个测试 Attempt |
| Live guidance / 执行中引导 | Existing level-three Agent returned `CAT_UPGRADE_STEER_OK` within the original Turn; both input receipts processed / 既有三级成员在同一 Turn 遵从新指令，两条消息均 processed |
| Same-key replay / 同 key 重试 | Identical steering response; no additional Turn / 返回相同，不增加 Turn |
| Immediate pause / 立即暂停 | Native Turn interrupted in approximately 0.6 seconds; resume did not replay / 约 0.6 秒内中断，恢复不重放 |
| Reminder / 用量提醒 | Tree threshold explicitly changed to 5,000,000; one historical-usage alert; no duplicate after restart or identical configuration / 显式配置 500 万阈值，仅提醒一次，重启与同配置不重报 |
| Restart continuity / 再次重启 | All 18 Attempts and 5 bindings retained; all Agents idle / 18 个 Attempt、5 个绑定保留，全部空闲 |
| Workspace / 工作区 | All managed worktree file contents and readiness markers match the pre-upgrade backup / 受管 worktree 文件与标记同备份一致 |
| Provider and model / 提供商与模型 | Dedicated runtime configuration byte-identical / 独立运行配置逐字节未变 |

### Version compatibility / 版本兼容

原配置指向随 App 更新的可执行文件，实际版本已变为 `0.163.0-alpha.10.2`，因此 doctor 正确拒绝。本轮停机备份后，仅把该团队 `config.json` 的 `executable` 改为隔离 runtime home 内保留的 `0.162.0-alpha.17.2`，doctor 随后通过；未放宽协议版本校验，未改全局 CLI、模型、提供商或权限。

The original executable path followed an App update to `0.163.0-alpha.10.2`, which doctor correctly rejected. After stopping and backing up, only this team's `config.json.executable` was changed to its retained isolated `0.162.0-alpha.17.2` executable. Doctor then passed. The protocol guard, global CLI, model, provider and permissions were unchanged.

### Regression results / 回归结果

- 默认回归：132 passes（8 unit + 124 integration），6 项原生测试默认跳过。
- 故障注入：32 passes。
- 六项原生测试单独启用：初跑 5 pass / 1 fail；修复后该失败项重跑通过。失败原因是公开 root 参数校验把非法 token 策略与合法但已停用的 enforce 混为同一提示，并把非法累计 Turn 上限称为笼统的 limit。现分别保留 `Invalid token policy`、enforce 替代建议与具体上限字段名；新增默认回归断言。不是恢复协议或实际执行失败。
- 修复后默认回归、故障注入、Typecheck 与修改代码格式检查通过。
- Default regression: 132 passes (8 unit + 124 integration), with 6 native tests skipped by default.
- Fault injection: 32 passes.
- All 6 native tests were enabled separately: initially 5 passed and 1 failed; the failing test passed after repair. Public root validation had conflated an invalid token policy with the recognized but retired enforce option, and reported invalid Turn ceilings as a generic limit. It now distinguishes these cases and names the invalid ceiling. Default regression assertions cover this diagnostic regression. It was not an execution/recovery-protocol failure.
- Default regression, fault injection, Typecheck and changed-code formatting passed after the fix.

### Accounting and remaining limits / 核算与验证边界

本轮两次真实 Attempt 新增已观测用量为 **482,602 total tokens**，包括缓存输入，不能视作账单或完整成本。成功引导的 Turn 最终用量已核算；立即中断的 Turn 没有最终用量通知，保留 unknown 用量与消息消费记录，未编造零值或自动重试。原生历史分别确认 completed 与 interrupted，执行状态没有未知；消费 unknown 不等于任务失败，也不应擅自重投。

The two real Attempts added **482,602 observed total tokens**, including cached input; this is neither a bill nor a complete cost measurement. The successful steering Turn has final usage. The immediately interrupted Turn has no final usage notification and retains unknown usage and message-consumption records without fabricating zero usage or replaying work. Native history confirms completed and interrupted execution respectively; execution itself is not unknown. Unknown consumption is not a task-failure assertion or authorization to redeliver.

现有团队显式采用交互模式、全树一次 500 万提醒；每成员与全树累计 Turn 继续不限额，depth 2、累计 16 Agents、并发 3。未自动给旧 native Thread 更换工具目录。15/10 分钟告警与长期停滞阈值仍未做持续负载校准；本次短程通过不代表所有第三方模型、长任务或所有竞态都已验证。

The existing team explicitly uses interactive mode and a one-time tree-wide 5-million-token reminder. Per-Agent and tree lifetime Turn ceilings remain unlimited, with depth 2, 16 lifetime Agents and 3 concurrent Turns. Existing native Thread tool catalogs were not replaced. The 15/10-minute warning defaults and long-running stall thresholds remain uncalibrated under sustained load. These short probes do not qualify every provider, long task or race.

备份与原始证据保存在本机，不包含在发布输入中。本轮没有发布 Release。

Backups and raw evidence remain local and are excluded from distribution inputs. No Release was published in this run.

### Subsequent member-ceiling change / 后续累计成员调整

同日按用户要求将新团队默认累计成员改为 20，并通过受认证的 `limits --max-agents 20` 将既有团队从 16 调至 20，记录 before/after/reason。保持 5 个成员、18 个历史 Turn、depth 2、并发 3 与不限累计 Turn；不扩充成员、不请求模型。27 项相关回归通过，涵盖旧上限阻止 spawn、增加上限后成功、终止成员仍占累计名额、拒绝低于已用成员数、重启保留、同值幂等与 offline CLI 入口。

Later the same day, the user requested a lifetime member ceiling of 20. New-team defaults were updated, and the existing team was explicitly changed from 16 to 20 through authenticated `limits --max-agents 20`, recording before/after/reason. Its 5 members, 18 historical Turns, depth 2, concurrency 3 and unlimited lifetime Turns were preserved. No members or model requests were added. All 27 related regression tests passed, including spawn admission before/after the increase, terminated-member retention, invalid reductions, persistence, idempotency and the offline CLI.
