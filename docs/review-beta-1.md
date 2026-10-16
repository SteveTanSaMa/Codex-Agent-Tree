# Beta 1 架构审查跟进

基线：`ee84ea1` / `0.1.0-beta.1`。本轮是局部源码审计、确定性回归和本机性能测量；未重新调用真实模型，也不是完整安全审计。Beta 1 已发布资产保持不变，以下改进先进入 main。

## 1. Task 投影：确认并修复

原 `rows()` 对每个 Task 重扫依赖、scope，并在每个依赖上查找完整 Task 数组；scope 告警还进行任务对之间的嵌套扫描。现在每次投影单独构造依赖/scope 分组、Task ID 索引，以及活跃任务的 scope 精确/路径前缀索引。查询祖先与后代 scope 后去重，再恢复原任务顺序。没有跨请求缓存，也没有修改 Task 状态、CAS、权限、数据库 schema 或 advisory scope 的含义。

`src/a` 与 `src/a/file` 重叠，与 `src/ab` 不重叠；大小写语义与原实现一致。投影回归用 256 Task、已删除记录、依赖和不同路径边界逐项对照独立的逐对判定。注意：当前限制是每树 256 个**未删除 Task**，与默认 16 Agent 独立；历史 tombstone 不受这个活跃数量上限限制。

本机同进程比较 `ee84ea1` 与新实现，5 次预热、10 次采样，结果 JSON 完全一致：

| 夹具 | Task / scope 数 | 原中位耗时 | 新中位耗时 | 比值 |
| --- | --- | --- | --- | --- |
| 稀疏重叠 | 256 / 4096 | 266.05 ms | 9.86 ms | 26.98× |
| 密集重叠 | 256 / 4096 | 168.99 ms | 21.79 ms | 7.76× |

复验：`node scripts/diagnostics/task-projection.ts`。需要本地 Git 能读到审查基线提交。数字是这两组投影夹具的测量，不是整套 Runtime 的加速幅度；实际速度依赖机器、重叠程度及告警输出数量。密集冲突本身可产生大量告警，不能宣称投影在所有输入上均为线性复杂度。

## 2. 串行 RPC：确认结构性等待，保持现有调度

受控测试分别阻塞第一个 Agent 的 metadata RPC 0 / 40 / 120 ms。第二个已具备调度资格的 Agent 也等待释放；释放后各自仅派发一次。说明队首等待确实存在，但尚未测到真实负载下需要改调度策略的延迟退化。

单次 RPC 默认超时为 30 秒，不代表整轮调度的总等待上限。此处没有改成 `Promise.all`，也没有扩大调度并发。后续若实际延迟值得优化，应先给不同 RPC 分别记录排队与执行耗时，再资格验证有界并发下的预算准入、生命周期变化和唯一派发。

复验：`node --test test/fault/scheduler-latency.test.ts`。这是可控 fixture，不是原生 Runtime 性能基准。

## 3. Worktree：保留拒绝自动认领，补诊断与操作流程

Git checkout、业务状态和 ready marker 无法构成同一事务。marker 缺失/不匹配时仍拒绝复用和自动 reset。现在 `scheduler.error` 会带上受控的业务错误说明；未知 Runtime 异常仍只写通用说明，不暴露原始 RPC 或命令 stderr。

新增集成回归：预置一个未完成工作区和待保留文件，调度时确实记录“provisioning is incomplete”，不绑定子 Thread、不启动子 Turn、不覆盖原文件。

[人工恢复流程](../references/coding.md#incomplete-worktree-runbook) 明确暂停、停止、备份、检查身份和初始化提交、保留未跟踪文件、显式 salvage/替换节点。Beta 当前没有安全自动 adopt 未标记工作树的命令；不建议伪造 marker，也不将 metadata 匹配当作 checkout 已完成的证明。新节点仍受既有 lifetime 限制，清理是另外的操作者决策。

## 4. 三个执行不变量的审计结论

| 关注点 | 实现依据与回归 | 本轮结论 |
| --- | --- | --- |
| 一个 Attempt 对应多个原生 Turn | 仅 prepared 可 markStarting；已知 Turn ID 不可替换；unknown 不自动派发；唯一原生 ID/活跃 Attempt 索引；ACK 丢失、迟到 start/completion、历史缺失/歧义、重复恢复故障测试 | 已检查路径未发现新的 P0/P1；这些测试不是所有 Runtime 时序的形式证明 |
| 一次工具副作用重复执行 | 原生 call ID + Turn/input fingerprint 的持久命令记录；accepted 未结算拒绝重放；completed 返回原结果 | **仅保证相同 call ID 的缓存/拒绝重放。不同 call ID 的相同命令是新工作，会重复产生效果**，不是业务副作用 exactly-once |
| Task / 消息 / Agent 不可恢复矛盾 | Task 变更、依赖、CAS 请求记录和事件共用 SQLite 事务；控制 fence 与消息/Attempt 转换的故障测试；原生跨域未知保持 unknown | 未确认新的事务不一致；Task 完成、消息 processed、Agent idle 是独立事实，不能互相代替 |

命令语义新增宿主集成复验：同一原生 Turn 的同一 call ID 执行计数从 0→1，重发仍为 1；换 call ID 后变为 2。通过真实沙箱命令及文件计数检查，不依赖模型叙述。未来若需要跨模型重试的业务防重，需要显式业务操作键及各外部系统的幂等协议，不能仅靠 call ID 宣称实现。

Task 完成后所属 Agent 仍运行、消息处理后子任务仍未完成、取消 Agent 后其 Task 仍需人工释放/重派，都是当前明确的语义，不直接视为数据损坏。

## 5. 安全边界与验证范围

Seatbelt 允许系统及部分工具链只读路径，以运行 Node/Git；它服务于可信仓库下的工作区权限边界，不是恶意代码、所有 OS IPC 或不可信工具链的完整隔离。本轮没有扩大这些权限，也没有据此新增安全保证。原有路径/符号链接、Git filter 正负对照、网络与外部读写拒绝、取消及父进程死亡测试继续保留。

本轮命令：`npm run typecheck`、`npm run format:check`、`npm test`、`npm run test:fault`，以及上述性能诊断。原生 daemon 与真实模型的历史证据见 [Beta 验收](beta-validation.md)；本轮没有重跑它们，不能把历史 127 次与本轮重复执行简单相加成独立覆盖。

本轮结果：默认回归 **98 通过**（8 unit + 90 integration，另 4 项原生测试跳过），故障注入 **30 通过**；类型检查、格式检查通过。共 128 次通过的离线测试执行。本轮不消耗模型用量，未发布新的 Release。
