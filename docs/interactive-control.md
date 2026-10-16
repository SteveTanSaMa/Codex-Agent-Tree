# Interactive execution control / 交互执行控制

## 实施计划与验收

1. **持久化引导**：`auto|queue|steer`、原生 expected-Turn 前置条件、稳定输入 key、明确投递状态；未知结果不重发，人工复核后才能重投。
2. **立即暂停**：保留原有 drain pause，新增 `--immediate`；先持久化子树 fence，再请求原生中断和取消受管命令。重启继续处理尚未完成的中断。
3. **交互默认与保护**：新交互团队取消累计 Turn 上限；保留统计、结构上限。树级自主执行时钟、默认只告警的停滞检测，以及用户可选的任务用量/时间预算。
4. **有限验证**：确定性集成、真实进程 SIGKILL、公开 Skill 命令入口、打包、固定 CLI 的本地回环协议探针。此次不安排长时间多轮真实任务，不调用付费模型。

## 默认值 / Defaults

| Setting / 设置 | Interactive（默认） | Batch |
| --- | --- | --- |
| Lifetime Turns per Agent / 单 Agent 累计 Turn | unlimited | 20 |
| Lifetime tree Turns / 全树累计 Turn | unlimited | 100 |
| Depth / 累计 Agent / Concurrent Turns | 2 / 16 / 3 | 2 / 16 / 3 |
| Token policy / warning threshold | observe / 5000000 | observe / 5000000 |
| Continuous autonomy warning | 900000 ms (15 min) | 900000 ms |
| Automatic autonomy pause | disabled | disabled |
| No observable progress warning | 600000 ms (10 min) | 600000 ms |
| Consecutive identical tool rejection warning | 8 | 8 |
| Optional task token/time budget | disabled | disabled |

15/10 分钟与 8 次是可配置的初始提示值，尚未通过长期负载校准。Batch 仍可显式使用 `unlimited`；交互模式也可显式设置有限 Turn。老团队保留原来的限额和消息排队行为，不会自动获得新策略。升级前停止 Coordinator 并备份完整 state；schema 12 阻止旧源代码误读新状态。升级本身不更换模型、提供商或全局 CLI 配置。

The warning defaults are provisional, configurable hints, not validated performance thresholds. Existing teams retain their limits and queue behavior. Stop and back up the full state before the schema-11 upgrade. Production CLI version pins remain unchanged.

## Send, steer, pause / 输入、引导、暂停

```sh
node "$SKILL_DIR/scripts/cat.mjs" root --state "$STATE" --mode interactive --key task-1 --task-file /absolute/task.txt
node "$SKILL_DIR/scripts/cat.mjs" send --state "$STATE" --target AGENT_ID --key correction-1 --message 'Keep changes in this module'
node "$SKILL_DIR/scripts/cat.mjs" send --state "$STATE" --target AGENT_ID --delivery queue --key next-1 --message 'Review next'
node "$SKILL_DIR/scripts/cat.mjs" steer --state "$STATE" --target AGENT_ID --key correction-2 --message 'Use the other reproduction'
node "$SKILL_DIR/scripts/cat.mjs" control --state "$STATE" --target ROOT_ID --action pause --immediate
node "$SKILL_DIR/scripts/cat.mjs" control --state "$STATE" --target ROOT_ID --action resume
```

`auto` 是 `send` 默认行为：有交互策略且当前 Turn 可引导时投递到当前执行，否则排队。`steer` 显式请求同样的当前执行投递；idle、starting、paused、unknown 或不支持该方法时不会伪造成功。它不会为投递中/未知的执行强行启动第二个 Turn。`queue` 始终等下一轮。用户指定目标 Agent；引导 Lead 不会自动广播到其他成员，修改全树方向由 Lead 协调。需要立即制止全树时使用子树立即暂停。

`auto` steers a running interactive Agent and otherwise queues. Explicit `steer` requests live delivery but reports deferral when no steerable Turn exists. It does not broadcast to descendants or start a second Turn. Use subtree immediate pause to stop the team. Ordinary pause drains; resume permits future work but does not replay interrupted side effects.

`status.interaction` 返回策略、持久化时钟、最近告警和引导记录；`view` 将未知引导标记为 `unknown-guidance`。状态含义：

- `pending`：本地已接受，尚未决定投递。
- `dispatching`：已持久化发送意图，RPC 可能已发出。
- `delivered`：Runtime 确认接受，**不代表模型遵从、任务完成或副作用撤销**。
- `deferred`：进入原有下一轮队列；具体消费状态看同条记录的 `message_status`。
- `unknown`：可能已接受，阻止该 Agent 新 Turn 准入，现有执行仍需独立中断；不自动重投。

Guidance acceptance is not proof of model compliance, task completion, or rollback. RPC timeout/disconnect, unexpected ACK and a completion race retain uncertainty. Explicit method-not-found or confirmed not-sent may safely defer. A lost steering ACK does not mean the underlying Turn failed. During restart an unfinished dispatch becomes unknown without automatic replay.

```sh
# Inspect native history first. Use the SAME key/content for an uncertain command retry.
node "$SKILL_DIR/scripts/cat.mjs" native-history --state "$STATE" --target AGENT_ID
node "$SKILL_DIR/scripts/cat.mjs" guidance-resolve --state "$STATE" --target AGENT_ID --message-id MESSAGE_ID --outcome delivered --reason 'Confirmed in native history'
# Explicitly authorizes duplicate risk if history cannot establish absence:
node "$SKILL_DIR/scripts/cat.mjs" guidance-resolve --state "$STATE" --target AGENT_ID --message-id MESSAGE_ID --outcome retry-next --reason 'Reviewed absence and approved retry'
```

原生接口为 `turn/steer`，使用 `threadId`、`expectedTurnId`、`clientUserMessageId` 和输入标记。该 ID 用于关联，不假设 Runtime 提供端到端 exactly-once 去重。引导当前 Turn 不增加业务 Turn；下一轮队列准备 Attempt 才增加。输入数量、业务 Turn、模型请求数是不同指标。

Protocol reference: [OpenAI App Server documentation](https://learn.chatgpt.com/docs/app-server). The local versioned schema and loopback probe govern compatibility; no inference is made from newer documentation about third-party provider behavior.

## Protection and task budgets / 自主执行与预算

```sh
node "$SKILL_DIR/scripts/cat.mjs" root --state "$STATE" --key task-2 --task-file /absolute/task.txt \
  --autonomy-warn-ms 900000 --autonomy-pause-ms 1800000 \
  --task-token-budget 2000000 --task-time-budget-ms 7200000
node "$SKILL_DIR/scripts/cat.mjs" check-in --state "$STATE" --target ROOT_ID
# Replace the tree policy using a JSON object with InteractionPolicy fields:
node "$SKILL_DIR/scripts/cat.mjs" interaction --state "$STATE" --target ROOT_ID --input-file /absolute/policy.json
```

策略字段为 `mode`、`autonomyWarnMs`、`autonomyPauseMs`、`stallWarnMs`、`repeatErrorThreshold`、`taskTokenBudget`、`taskTimeBudgetMs`。可选数值字段以 JSON `null` 禁用；修改策略以默认值补齐省略字段，属于替换而非增量 patch。它不改变现有累计 Turn 限额；需要时另用 `limits` 命令。模型工具不能更改策略、预算、时钟或人工 fence。

连续自主执行按整棵树计算，包括子节点工作期间的等待。成功的实时人工引导、显式 `check-in` 或人工 resume 开启新阶段；普通排队消息、agent 消息、重复输入不重置。全树空闲清除自主阶段时钟。任务预算起始时间和总用量不会因 check-in/resume 清空。

Autonomy uses a persistent tree-wide wall-clock epoch. A successful new live human steer, explicit check-in or human resume renews it. Agent messages and idempotent retries do not. Fully idle intervals end the autonomy epoch. The optional task time budget counts wall time since first work, including pauses/downtime; the task token budget uses cumulative observed tokens including cached input, not money. Review/extend the task budget before resuming an exhausted task; check-in alone cannot bypass it.

保护器约每秒检查，启动新轮前也检查。可选预算耗尽或自主暂停时限触发时先加人工子树 fence，再请求中断。用量通知、RPC 和命令取消存在延迟，可能超额；**这些是软停止机制，不是提供商账单硬上限**。不提供未经可靠测量的模型请求数预算。

Stall warnings use absence of selected observable activity and consecutive same-tool/same-code rejections, deduplicated until activity/check-in. Successful reads, logs or tests do not establish semantic progress; long legitimate computations may warn. Stalls only warn by default. No automatic classification of model quality or task success is made.

## Validation scope / 验证范围

Deterministic coverage includes idempotent live steering without new Turns, next-turn batching, unsupported-method fallback, lost ACK quarantine, restart, immediate-pause persistence, durable clocks and soft budgets. SIGKILL tests cover committed steering intent and a protection pause requested before fence application. The public Skill wrapper is exercised. A short loopback test uses the actual pinned `0.162.0-alpha.17.2` CLI, a temporary home and a scripted local SSE stream: correct IDs are accepted and stale IDs rejected. It uses no real API key or paid model. It does not prove that a third-party model obeys guidance mid-request. Long-running real task qualification is deliberately deferred.

本轮验证记录（2026-10-16）：默认回归 **127 passes**（8 unit + 119 integration；6 native 项默认跳过），故障注入 **31 passes**；上述回环原生探针单独 **1 pass**。打包测试另核对安装包内所有 Skill 本地引用，避免文档缺失。Typecheck、修改文件格式检查、Skill 元数据校验通过。没有运行原有长时真实模型测试，也没有对既有团队热升级。

Validation on 2026-10-16: **127 default passes** (8 unit + 119 integration; 6 native skips), **31 fault passes**, and **1 separately executed loopback native pass**. Packaging checks all local Skill references. Typecheck, changed-file formatting and Skill metadata validation passed. Existing teams were not hot-upgraded. If an App update replaces its bundled CLI, select a matching retained binary via `init --executable`; do not bypass the production version check. This probe used a retained matching binary after detecting that the App bundle had moved to 0.163.

Token reminder configuration is now separate from task budgets: see [token reminders](token-reminders.md). New public roots do not create legacy per-Agent token allocations. 提醒不暂停任务，也不清空任务预算。
