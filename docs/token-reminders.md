# Token reminders / Token 用量提醒

新团队不分配单 Agent token 配额。提醒只产生本地持久化事件，不中断、不向 Agent 注入消息、不新增 Turn，也不额外请求模型。任务级 `--task-token-budget` 仍由用户选择，是独立的软暂停机制。

New teams have no per-Agent token allocation. Reminders are local durable events: they neither interrupt execution nor inject messages, start Turns or request a model. Optional task-wide soft budgets remain separate.

## Defaults / 默认值

- 全树累计总 token 达到 **5000000** 提醒一次；单个 Agent 默认不单独提醒。
- 默认不启用周期提醒，不自动调整阈值，不依据 token 换算费用。
- Agent 范围是稳定的受管对话身份，跨 Turn、resume 和替换 Thread 累计；tree 范围包含全树成员。调用者当前聊天的用量不自动归入受管树。
- Default: one tree-wide alert at **5000000 total tokens**; per-Agent and recurring alerts are opt-in. Agent scope follows the stable managed identity across Turns/resume/replacement Threads. Tree scope includes all members. The operator's current chat is outside this ledger.

## Configuration / 配置

```sh
# One alert for this Agent at 500000 total tokens:
node "$SKILL_DIR/scripts/cat.mjs" token-reminder --state "$STATE" --target AGENT_ID --scope agent --threshold 500000
# First tree alert at 1000000, then every additional 1000000, excluding cached input:
node "$SKILL_DIR/scripts/cat.mjs" token-reminder --state "$STATE" --target ROOT_ID --scope tree --metric uncachedInput --threshold 1000000 --every 1000000
# Track output only; stop reminding this Agent without pausing it:
node "$SKILL_DIR/scripts/cat.mjs" token-reminder --state "$STATE" --target AGENT_ID --metric output --threshold 100000 --every 100000
node "$SKILL_DIR/scripts/cat.mjs" token-reminder --state "$STATE" --target AGENT_ID --disable
# New tree, with the tree-wide reminder configured at creation:
node "$SKILL_DIR/scripts/cat.mjs" root --state "$STATE" --key task-1 --task-file /absolute/task.txt \
  --token-alert-at 1000000 --token-alert-every 1000000 --token-alert-metric uncachedInput
```

`--scope` 默认 `agent`，`--metric` 默认 `total`，不指定 `--every` 为一次提醒。达到阈值（包含相等）即触发。初次阈值和增量可不同，例如 `--threshold 200000 --every 100000` 在 200k、300k、400k……提醒。

Scope defaults to `agent`, metric to `total`; omit `--every` for a single alert. Equality triggers the alert. Threshold and interval may differ. Disabling a reminder does not disable task budgets or lifecycle fences.

配置相同策略是幂等操作，不清空游标；修改策略或重新启用会重新武装阈值，若当前累计值已超过新阈值，会立即产生一条合并提醒。根请求同 key 重试不覆盖后来手动修改的策略。用户策略不接受 Agent 工具修改。

Identical configuration retains the cursor. Changing/re-enabling a policy re-arms it against existing cumulative usage, potentially emitting one immediate aggregate alert. Retrying a root key does not overwrite later reminder changes. Only the authenticated operator can configure reminders.

## Measurement / 统计口径

`status.tokenUsage`、`view.tokenUsage`（以及 wait 的 view）分别返回 `agent` 与 `tree`：策略、累计指标、口径是否可用、最近已提醒阈值和下一个阈值。

- `total`：已观测累计总 token，包括缓存输入。
- `uncachedInput`：输入减去缓存输入，**不包括输出**。
- `output`：输出；推理 token 若有单独明细，是输出的组成部分，不重复相加。

Metrics expose total input, cached input, noncached input, output and reasoning output separately. Missing/invalid breakdown remains `null`; a metric-specific reminder waits for usable evidence rather than substituting total tokens. This is not billing data. Native samples are cumulative per Thread and deduplicated; raw notifications are never summed. Verified higher accounting floors are retained; when detailed native coverage is incomplete, details remain unavailable rather than fabricating zeros.

`usage.reminder` 事件包含 `scope`、`targetId`、`metric`、`observedTokens`、`firstThreshold`、`lastThreshold`、`crossedCount` 和 `stopsExecution:false`。一次用量更新跨过多个阈值时合并为一条事件；提醒游标与事件同事务提交。重复通知、旧样本和重启不重复提醒，消费者应按事件 ID/cursor 展示一次。事件记录不等于系统通知已发送；Skill 操作者在 `wait/events` 中读取并向用户转述，不需要给 Agent 发消息。

Each update coalesces all newly crossed thresholds into one `usage.reminder` event. Cursor and event commit atomically. Duplicate/late samples and restart do not repeat the alert; consumers deduplicate by event ID/cursor. Event persistence is not an OS push notification. The Skill operator surfaces the event to the user without sending it back into the team.

## Compatibility / 兼容

`--tokens N` 在新团队只作为全树首次提醒阈值的旧别名，建议改用 `--token-alert-at N`。`--reserve` 仍是核算字段，不是对话预算。公开 root 入口不再接受新建 `--token-policy enforce` 团队；用户可用独立任务级软预算。旧 enforce 团队原有配额与核算保留，升级不暗中解除已有约束。旧状态中的一次阈值告警会迁移为已提醒位置，避免升级后重报。

`--tokens` is a deprecated first-alert alias for new trees. New public root requests no longer enable legacy per-Agent allocation/enforcement. Existing enforce trees retain their policy and ledger; reminders do not relax them. Observe-mode allocation fields are unused and normalized to zero; `budget.availableTokens` is null in observe mode. Use `tokenUsage` for reminder state, not legacy budget fields. Stop and back up state before the one-way schema-12 migration.

Validation is bounded: deterministic threshold/interval/scoping/metric/restart/migration tests, public CLI forwarding, and a SIGKILL test between reminder cursor update and event insertion. No long real-model run is required for these local accounting behaviors.

验证记录（2026-10-16）：默认回归 **132 passes**（8 unit + 124 integration；6 native 项跳过），故障注入 **32 passes**，包括提醒事务中途 SIGKILL。Typecheck、Skill 校验和打包引用检查通过。本轮未调用真实模型，未安排长时间多轮任务，也未升级既有运行团队。

Validation on 2026-10-16: **132 default passes** (8 unit + 124 integration; 6 native skips) and **32 fault passes**, including mid-reminder SIGKILL. Typecheck, Skill validation and packaged-reference checks passed. No real-model requests, long multi-turn task, or hot upgrade of existing teams was performed in this change.
