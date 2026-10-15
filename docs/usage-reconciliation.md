# 用量证据与核算（schema 8）

本次修复对应架构审查 R3。原生通知记录的是 Thread 累计量，人工收据记录的是某个 Turn 的最终量；两者不能直接相加。

## 核算规则

`usage_evidence` 为每个 Attempt 保存原生累计样本最大值 `native_total`、经人工确认的最终量 `attested` 和直接记录的用量下界 `direct_floor`。`usage_cursors` 只保存原生高水位，人工收据不修改它。原始事件、收据来源和说明继续保留。

同一 Thread/binding generation 内，按 Attempt 创建顺序计算前缀。每个 Attempt 的原生归属量为其累计样本减去前面已有证据覆盖的前缀，且不低于直接记录的下界；实际责任取该归属量与人工收据的较大值。其责任进入下一个 Attempt 的前缀。没有自身样本时不把人工收据伪装成原生 observed。

终态 Attempt 的 charged、Agent spent 和已确认可释放的 reservation 在同一事务中更新。新收据或迟到的旧 Turn 样本可以改变后续 Turn 的归属，因而单个 Attempt 的 observed/charged 可以向下修正；对应的 `usage.attributed` 事件保留修正前后数字和依据。这是去除重叠归属，不是删除原生观测或退还供应商费用。未完成工作的 reservation 保持保守下界，不因归属调整提前释放。

例如：第一 Turn 样本 30、人工最终量 50，第二 Turn 累计样本 75，最终分别归入 50 和 25，合计 75；收据在第二 Turn 结束后补记也得到同一结果。第一 Turn 后续样本若升至 60，则两者调整为 60 和 15，仍合计 75。重复通知和重启不改变结果；同一 Attempt 的更低样本仅记乱序，较旧 Attempt 的迟到样本即使低于 Thread 高水位仍可用于核算。

## 未知与冲突

缺少最终量的 failed/interrupted Attempt 仍未知；缺少自身样本和收据的 completed Attempt 也不会因为其他 Turn 收到通知而自动解除未知责任。observe 可以继续执行，但没有证据覆盖的间隙仍可能使后续归属暂时包含先前用量；提供可靠收据或旧 Turn 样本后再修正。enforce 的原有未知用量准入限制不变。

如果一个累计样本低于此前证据已覆盖的前缀，则输入事实相互矛盾，整个更新事务以 CONFLICT 回滚，不静默截成零或清除未知状态。不得伪造收据来恢复执行。此核算合同假设 Thread 累计量单调且通知的 Turn ID 正确；供应商重置计数或外来执行导致的归属问题仍需调查。

## 旧库迁移

schema 8 为单向升级。先停止 Coordinator，备份完整 state（含存在的 SQLite sidecar），保留专用 runtime home。旧版本会拒绝 schema 8，回退需恢复匹配的备份并对账期间实际执行。

迁移在取得 owner 的同一事务中，从保留的 `usage.observed` 与 `budget.settled` 事件重建证据，再核算。已有 95/75 重复计数可被修正。没有原生事件的旧记录保留既有 observed 下界；缺少收据事件但标记为 human-attested 的记录保留已确认 charged。缺少证据不会猜测最终用量。迁移不可解释的冲突会拒绝升级并回滚，应保留备份调查。迁移不会改写 Agent 身份、binding、消息或 Turn 次数。

## 可复验

- `node scripts/diagnostics/usage-gap.ts`：原失败诊断现应返回 0，第二 Turn 为 25、总量为 75。
- `node --test test/integration/usage-evidence.test.ts`：observe/enforce、收据前后顺序、多个缺口、迟到/重复/乱序、重启、矛盾事务回滚、schema 6 多计记录及缺证据记录迁移。
- `test/integration/store.test.ts`：保留原有原生累计、人工收据和中断未知责任断言。

这不是精确供应商账单接口，也没有改变默认 observe 策略、结构限制或执行次数限制。


## Beta：保留晚到的人工证据

操作者 `settle-usage` 会先将经核实的回执持久保存到 `usage_receipts`。若当前归属仍包含前序缺口，回执可保持 `pending`；这不会减少已观测用量、不会释放 reservation，也不会解除 enforce 的未知责任。补齐前序回执、收到兼容原生样本或重启后自动重新评估，无需重复提交。可在 `status.attempts[].usageReceipts` 查询 pending/applied。

例如三个原生累计样本为 10、50、85，已核实的每轮最终量为 30、45、10。先提交最后的 10 会暂存 pending；前两轮补齐后，三轮自动归入 30、45、10，合计仍为 85，原生 cursor 不变。相互矛盾的回执仍 pending，须调查来源；不能为了清理状态编造新金额。严格内部结算仍拒绝删除观测事实。对应回归：`test/integration/fifo-receipts.test.ts`。
