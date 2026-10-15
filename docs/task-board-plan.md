# Task 协作与事件等待实施计划

基线：`c108ff9` / `0.1.0-alpha.2`。目标：让已安装的 Codex Skill 能区分消息消费与业务任务完成，并有效等待团队进展。

## 阶段一：持久任务板

- 在现有业务 SQLite 中新增 Task、依赖、作用域提示和幂等请求记录；迁移保持旧树、Thread binding、消息及成本记录。
- create/get/list/update 工具及操作者 CLI 共用领域逻辑。创建使用 request key；修改使用 expectedRevision + request key，丢回复后重试不重复修改。
- 明确 pending/in_progress/completed/deleted、owner、结果和显式 complete；不由消息 ACK、Turn 完成或子节点 idle 自动推断 Task 完成。
- 树内可领取就绪任务；已有 owner 的修改受本人/管理祖先授权。重新分配不能越过树或提升子节点权限。检查缺失依赖、自依赖、环、删除中的 blocker，保留 tombstone。
- 验收：CAS 冲突、幂等重试、越权、依赖/状态转换、重启持久化、事务故障回滚。

## 阶段二：操作者事件等待

- 增加基于持久事件 sequence 的有界 CLI wait，支持 tree 过滤、超时、取消和服务停止。
- 检查 cursor 与注册等待之间不引入 await；只在事务提交后通知，不为回滚发布变更。
- 返回 changed/timedOut/noProgress、下一 cursor 和可解释的阻塞原因；不占用托管 Agent 的 Native Turn 并发额度。
- 验收：调用前已经发生的事件、等待期间提交、其他树事件、超时、客户端断开、停止、重启后的 cursor。

## 阶段三：统一只读视图与 Skill

- view 返回同源的树、任务摘要、预算、消息计数、阻塞说明及 cursor；未来 UI 只消费此视图。
- 更新 Skill 的任务委派/显式完成/结果读取/事件等待流程；现有纯消息工作流继续可用。
- 验收：模型真实调用 Task 工具并完成带依赖的委派；安装包从仓库外可运行新 CLI；旧递归、黑盒恢复和预算回归通过。

## 边界与发布

- 任务 ready 只表明可领取，不自动派发；Task complete 是带结果的显式声明，不等于质量审核。
- 沿用独立业务身份、递归授权、预算、pause/cancel/terminate 与 unknown 保守对账。metadata 更新不解除 fence，不额外调用模型。
- 这一轮不新增前端宿主插件、fork provider 或并发编码能力；它们仍需单独资格测试。
- 所有阶段完成后更新验证文档、推送最小必要文件，并根据真实验收结果发布新的 alpha Skill 包。

## 进度

- [x] 阶段一
- [x] 阶段二
- [x] 阶段三

验收结果见 [验证范围](validation.md)：新增 Task/CAS/授权/依赖、事件等待、实际事务进程崩溃与原生 CLI 重启测试；独立 Codex 从最终 ZIP 调用 Task 工具，完成带依赖的三节点协作及事件等待。英文 README 与升级说明已同步。

首次双任务验收在默认 200000-token 池下被预算拦住，Task 已完成但 A 未开始汇总；并未自动提高预算或伪造完成。为该验收预先明确配置 600000-token 池后通过，原生累计用量 367337（含缓存输入），无剩余预留或超额责任。该结果只说明这一固定验收，不是任意任务成本保证。
