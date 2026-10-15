# 第一轮审查处理

审查基线：`1a5c579` / `0.1.0-alpha.1`。处理日期：2026-10-15。以下分别记录确认事实、修复和验证边界，不把“待验证”当成已确认漏洞。

## F-01：批处理队首边界

**结论：存在潜在阻塞分支，正常公开接口下未复现 P1。** `text()` 限制单条 12000 个 UTF-16 code units，并禁止会被 JSON 编码为六字符转义的控制字符；正常转义最多约两倍，带 UUID 元数据仍低于 44000。基线允许孤立 surrogate，但在实测 Node/SQLite 中落库后会替换为 U+FFFD，不能据此证明持久队列里存在 72000 字符的正常消息。

用隔离业务 DB 注入超限历史行后，同一回归测试在基线失败：队首仍 queued，后续消息无法派发。该注入绕过公开输入校验，是防御测试，不代表普通用户可直接触发。

修复：超限行转为 `rejected`，保留原文和 `message.delivery_rejected` 原因；后续消息继续派发。覆盖 Agent 消息和人工输入两条表，并验证重启后失败记录仍在。没有选择简单“超限单条放行”，因为完整 Turn 输入另有 60000 字符限制。

同时拒绝非 well-formed UTF-16，避免原先 SQLite 替换字符造成接受内容与存储内容不一致。合法 emoji、引号、反斜线和允许的空白仍可使用。

测试：[输入边界](../test/unit/inputs.test.ts)；[批处理及持久失败](../test/fault/reconciliation.test.ts) 中 `message batching` 用例。

## F-02：消息消费与任务完成

**结论：语义边界成立，不把它改成“必须等待所有子任务才可确认消息”。** `acknowledged` 是当前消费者的显式确认；成功 Turn 将该回执置为 `processed`。这只提交消息消费，不证明业务目标或子树任务完成。

新增测试：Root 收到请求、创建仍在运行的子节点、确认并成功结束自身 Turn。重开数据库后，消息 processed 与子节点 running 同时存在，符合合同。已同步工具说明、Skill 和操作文档。完整任务状态/DAG 仍未实现，不能用 processed 作为未来依赖满足条件。

测试：[消息与委派语义](../test/integration/store.test.ts) 中 `processed receipt confirms consumption`。

## F-03：历史缺失与竞态

**结论：本轮未确认新恢复漏洞；新增故障注入通过。** 既有测试已覆盖丢 ACK、不可读/歧义历史、旧连接、完成事件触发历史重查、cancel 与 ACK/完成竞态。

本轮补充：已知 Turn ID 与尚未取得 ID 两种情况下，连续三次重启都只拿到空历史，保持同一 attempt、unknown、预留与 queued 消息，不调用新的 turn/start；唯一原历史恢复后采用原 Turn，未知用量继续阻止新消费。另在 readThread 等待期间注入完成事件，随后返回旧 inProgress 快照，验证不会把终态倒退为 running，也不会重派旧工作；合法后续输入只创建一个新 Turn。

测试：[恢复故障集](../test/fault/reconciliation.test.ts) 中 `repeated recovery with empty history`、`completion during history hydration`。这不证明所有故障组合，也不承诺缺乏历史及后续事件时自动恢复。

## F-04：预算

**结论：准入控制的既定限制，不是运行硬限额。** 文档明确区分 allocation、reservation/liability、observed/charged usage。树级状态增加 `availableTokens`、`excessLiabilityTokens`；原生用量从未超限跨入超限时写入 `budget.tree_overcommitted`，重复通知不重复触发。测试覆盖状态持久化、实际超额如实入账及后续消费被阻止。

`excessLiabilityTokens` 可能包含预留责任，不能等同真实账单超额。预算仍不是供应商硬上限或账号全局预算。

## 三个不变量的实际保证

| 不变量 | 机制与验证 | 边界 |
| --- | --- | --- |
| 单 Agent 单个有效派发 | 事务准入、active attempt 门禁、原生 idle 检查、binding/连接代际；并发恢复测试 | 不保证拥有同用户任意宿主权限的外部客户端不会制造异物；发现后隔离 |
| 接纳后不因崩溃盲目重发 | 唯一 Turn ID/marker 对账；缺失/歧义保持 unknown；真实接纳后注入调用方回复丢失测试 | 不是任意外部副作用 exactly-once 的证明 |
| 接受消息不能静默消失 | 持久 queued/投递/回执；不确定状态保留；超限行明确 rejected 并保留原因 | 暂停、预算或 unknown 可使 queued 长期停留；没有无条件最终完成保证 |

跨业务 SQLite 与 Native Runtime 的恢复协议仍是后续审查重点。不可把 SQLite 本地原子性当成跨系统事务。
