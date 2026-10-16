# 架构与设计取舍

Beta 增补：显式 Git 编码工作区、分层宿主工具、持久命令收据、跨来源 FIFO，以及 pending 人工用量回执。原生 shell 保持关闭，Lead 通过宿主终端执行命令。边界见[编码操作](../references/coding.md)与[Beta 验收](beta-validation.md)。

交付形态为自包含 Skill + TypeScript Coordinator。模型执行与历史复用 Codex 官方 daemon，JSON-RPC transport 复用 Stoneforge 的 Apache-2.0 模块，来源见 [vendor](../src/runtime/codex/vendor/README.md)。不重写模型执行循环。

```text
Codex 对话 → Skill CLI → 本地认证 socket → Coordinator ↔ 业务 SQLite
                                             ↓
                                官方 App Server daemon
                                  Thread A / B / C
```

稳定业务 `agent_id` 独立于 `thread_id`；绑定记录递增 `binding_generation`，连接另有 generation。Agent 是身份，Thread 是上下文，Turn 是调度单位。管理关系是树，通信可跨层；另有轻量 Task 依赖板，采用显式完成、CAS 和幂等操作；依赖就绪不自动派发模型。

选择维护这层 Coordinator，是因为身份、授权、执行配额、可选预算转移、控制 fence、消息消费与派发意图需要共享业务事务和 ownership。候选上层编排器也能完成 nominal 递归，保守 unknown guard 可小幅补齐；最终取舍在这些新增状态的事务与恢复接入成本。不把未测试项当作候选失败，不宣称成本全局最优。若未来已有项目覆盖这些语义，应重评薄扩展。

## 唤醒与恢复

消息持久化后，Coordinator 为可调度 idle Agent 创建 Turn，包括 Root。特定 Codex 版本的 root 唤醒限制是适配问题，不是长期技术壁垒。实际频率取决于工作流；对本 Skill 的逐级异步回报，它是关键路径。

单机 Coordinator 是可重启单写者，不是高可用集群。SQLite WAL/FULL、事务、进程身份与 ownership generation 保护状态；原生 daemon 独立存活。按 Turn ID 或唯一 attempt marker 对账，未证明的执行保留 unknown。业务提交与黑盒执行没有跨系统原子事务，不承诺任意外部效果 exactly-once。

## 成本、追踪与人工介入

- 每棵树始终限制深度、累计 Agent、并行 Turn、单节点及整树累计 Turn。新树默认 observe：token 去重核算并按阈值告警，不要求子分配，也不因未知用量阻断其他工作；未知执行仍占据原节点及并发槽，不自动重放。显式 enforce 才使用 root 池、父子预算转移与未知用量准入门槛。旧树保留 enforce。达到用户选定的硬限制后汇总或报告阻塞，不另建树绕过。
- attempt 保存 Agent、Thread、Turn、父 Turn、binding generation、输入摘要和结果；spawn/消息/控制/工具调用有结构化事件。通过 tree/status/events/native-history 定位委派与执行故障。
- 人工暂停/恢复可作用子树或单节点；cancel/terminate 请求中断并保留审计。模型不能解除人工 fence、伪造身份或结算用量。审批当前安全拒绝，没有交互审批队列。
- 共享 daemon 仅用于同一凭据域。已知多凭据或不同信任配置时，设计阶段就应按域分片；alpha 不提供多域编排。

## 后续决策门槛

限定 MVP 已验证真实递归、消息唤醒、退出续跑和明确故障注入点恢复。并发编码/worktree、自动 DAG 执行、交互审批和多机不在范围。扩展前需对比单 Agent 与团队：固定任务/输入/质量评分，记录时间、总 tokens、成功率、人工介入次数；尚无数据证明团队普遍更好或更便宜。

## 多仓库与 worktree

WorkspaceBroker 将 Repository、Agent 和工作目录所有者分开：原生 Thread 的 cwd 固定到 Agent 主仓库，受限工具通过 repositoryId 选择已授予仓库。schema 9 的 workspace_registry 固定操作者配置，agent_workspaces 在 root/spawn 事务内保存主仓库、授权集合和 isolated/inherit 模式。重复 spawn 的内容指纹包含仓库选择。工作树键是 (owner_agent_id, repository_id)，ready marker 持有双方身份；文件系统不与 SQLite 假装组成同一原子事务，未完成 provisioning 继续保守阻断。命令锁按实际 cwd 和依赖读目录记录。详见[设计与验证](multi-repository-plan.md)。
