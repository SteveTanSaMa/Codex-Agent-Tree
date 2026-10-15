# DeepSeek Agent Teams 实现与可借鉴设计

检查日期：2026-10-15。本项目基线：`f413d5e` / `0.1.0-alpha.2`。本次只研究与小型纯函数验证，不改 Runtime、不安装 DSH 作为依赖。

## 结论

最值得优先引入的是 **独立 Task 状态及 revision/CAS**，其次是 **事件等待和无进展诊断**。三包的领域服务、模型工具、只读 UI 投影分工也适合参考。

DSH 的这些包依赖它自己的 Agent/Session/Subagent Runtime，不是三个可直接挂到 Codex 上的通用编排库。其 Team 是 Lead 加直属 teammates，创建只授权 Lead，不能直接替换本项目的 A→B→C 递归授权。保留本项目的独立业务 Agent ID、binding generation、预算转移和黑盒对账；按需移植纯逻辑及交互协议。

## 版本与证据

从官方 npm registry 查询了三个包的标签，并下载分发包检查 JS；分发包 SHA-512 与 npm metadata 一致。默认安装的 `latest` **不等于最新 alpha**：

| 对象 | 本次固定版本/提交 | 观察 |
| --- | --- | --- |
| 三包 npm `latest` | `0.1.5-alpha.2` | 旧版团队专用持久邮箱；领域服务有 Team Remote |
| 三包 npm `alpha` | `0.2.1-alpha.3` | 本次主要研究版本；复用 Agent inbox；UI 读取 Session projection |
| alpha 源码 tag | `dsh-v0.2.1-alpha.3`，`2fbf4359b82fb94c03dcce0b831660d87f12ea5c` | 以下未特别说明的源码链接全部固定此提交 |
| 检查时 master | `571902028a75c64c1d767f4ae5fd099485f0ddf0` | 核对过的 index/roster 及 UI 文件与 tag 相同；工具 policy 首句已有变化 |

master 工具 policy 已移除发布 alpha 中“只有用户明确要求团队才创建”的首句，所以不能把主干文档、搜索缓存和默认 npm 安装混为同一个版本。本次没有验证用户本机 DSH 具体安装哪个版本。

来源：[领域包 npm metadata](https://registry.npmjs.org/@deepseek-ai%2Fdsh-experimental-agent-team)、[工具包 npm metadata](https://registry.npmjs.org/@deepseek-ai%2Fdsh-experimental-tool-agent-team)、[UI 包 npm metadata](https://registry.npmjs.org/@deepseek-ai%2Fdsh-experimental-client-ui-agent-team)、[固定 alpha tag](https://github.com/deepseek-ai/deepseek-harness/tree/2fbf4359b82fb94c03dcce0b831660d87f12ea5c)。旧版对比实际检查了 `agent-team@0.1.5-alpha.2` 的 `lib/types/mailbox.js`，未对旧版另外两包做完整源码审查。

## 三包怎样分工

| 包 | 实际责任 | 不承担的责任 |
| --- | --- | --- |
| `dsh-experimental-agent-team` | TeamService；roster/provisioning、任务板、Lead 日志与投影、消息路由、生命周期 | 不注册模型工具；本包不是跨进程 daemon |
| `dsh-experimental-tool-agent-team` | 按实际调用 Agent 安装工具、权限入口、协作 policy、必需身份上下文、紧凑结果 schema | 不另存业务状态；不让模型传入 sender 身份 |
| `dsh-experimental-client-ui-agent-team` | 会话标题栏中的成员/任务只读投影、状态展示、切换 teammate 历史 | 新版不做任务修改、不另存 Team 状态、不提供 mailbox timeline |

默认九个工具：spawn、send、list、wait、interrupt，以及 task create/get/list/update。可关闭 interrupt 注册，领域能力仍存在。Tool 安装失败时逆序清理已注册能力；移除工具插件与卸载整个领域 Runtime 的生命周期并不相同。

来源：[TeamService](https://github.com/deepseek-ai/deepseek-harness/blob/2fbf4359b82fb94c03dcce0b831660d87f12ea5c/packages/experimental/agent-team/src/index.ts)、[工具入口](https://github.com/deepseek-ai/deepseek-harness/blob/2fbf4359b82fb94c03dcce0b831660d87f12ea5c/packages/experimental/tool-agent-team/src/index.ts)、[UI mount](https://github.com/deepseek-ai/deepseek-harness/blob/2fbf4359b82fb94c03dcce0b831660d87f12ea5c/packages/experimental/client-ui-agent-team/src/client/mount.ts)。

## 1. 身份、创建与恢复

普通运行根 Session 隐式成为 Lead，Team ID 就是根 Session ID；teammate 的持久身份是它的 Session ID。`tryMembership` 校验注册表里的 **同一个 live Agent 对象**，再检查 durable roster，避免同 ID 的旧实例或未登记子节点获取 Team 权限。模型可见 target 是不可复用的成员名；后台路由使用真实身份。

创建先向 Lead 日志追加并 flush `provisioning`，预留名字与 child Session ID，再调用 Subagent provider。子节点初始输入被确认持久接受后才提交 `active`；失败保留 `failed`，名字与成员配额不归还。恢复检查 child 的真实 parent、continuable descriptor/provider、初始消息或待消费 inbox。并发创建/恢复有 terminal-state 冲突处理，不重新随意创建同名节点。

fresh 不带 Lead 历史；fork 使用完成 Turn 前缀。**只有 Lead 可 spawn/interrupt；teammate 不能再创建第三层 teammate。** Runtime 卸载会停止其拥有的活子节点，因此不能用这些源码声称已经验证“父 CLI 退出后独立进程继续”。实际存活还依赖完整 Harness 宿主生命周期。

对本项目：借鉴创建分阶段、只使用可信调用上下文和恢复证据；不要将 Session ID 直接替代业务 Agent ID，也不要把 DSH provisioning 的 failed 直接套到 Codex 未知 Turn。后者历史缺失时仍必须 unknown。

来源：[roster.ts](https://github.com/deepseek-ai/deepseek-harness/blob/2fbf4359b82fb94c03dcce0b831660d87f12ea5c/packages/experimental/agent-team/src/roster.ts)、[journal.ts](https://github.com/deepseek-ai/deepseek-harness/blob/2fbf4359b82fb94c03dcce0b831660d87f12ea5c/packages/experimental/agent-team/src/journal.ts)。

## 2. 消息：新旧版本为何差异很大

旧 `latest`：TeamMailbox 将 `team/message/queued` flush 到 Lead 日志，再按 target 串行派发。接收方持久记录中存在同 message identity 后，才写 `delivered`；历史不可读则保留 queued。它用 root 事务顺序加 target-local 队列，处理 Lead 日志与接收方日志两处状态。这与本项目持久消息/回执所面对的问题相近，但 delivered 也不等于业务任务完成。

新 alpha：Team 不再维护新发送意图。向 Lead 直接 `root.steer`；向 teammate 通过 `steerHostSubagentPrompt`，由底层 continuation 层负责目标锁、冷恢复与权限。运行中的目标在 step 边界接收，inactive 目标被启动/恢复。消息来源带真正 `senderSessionId`，完整 sender framing 与内容按 **UTF-8 字节数**检查上限，默认 65536。

成功只代表 inbox 接受，不表示模型处理或额外同步 flush 完成；Team 不对失败的新 send 留重试意图，不做显式重发去重。接受后的恢复取决于 Agent 原有持久化策略。旧 `team/message/*` 事件仍可投影读取，但新版不会据此自动重新投递旧邮件。

这次演进说明：当原生 Runtime 已拥有可靠 inbox，就让它拥有投递事实，减少重复记账。**本项目不能据此直接删除业务队列**：DSH 能修改内部 driver/inbox；我们通过 Codex 的外部协议工作，且承诺请求 key 去重、消费回执及预算/控制事务。需先验证 Codex 对应接纳、持久化、唤醒与恢复合同，才能决定下沉哪部分职责。

来源：[新版 sendAdmitted](https://github.com/deepseek-ai/deepseek-harness/blob/2fbf4359b82fb94c03dcce0b831660d87f12ea5c/packages/experimental/agent-team/src/index.ts)、[原生 Agent steer](https://github.com/deepseek-ai/deepseek-harness/blob/2fbf4359b82fb94c03dcce0b831660d87f12ea5c/packages/core/agent-loop/src/agent.ts)、[durable inbox](https://github.com/deepseek-ai/deepseek-harness/blob/2fbf4359b82fb94c03dcce0b831660d87f12ea5c/packages/core/agent-loop/src/inbox.ts)、[历史邮箱兼容测试](https://github.com/deepseek-ai/deepseek-harness/blob/2fbf4359b82fb94c03dcce0b831660d87f12ea5c/packages/experimental/agent-team/tests/persistence.spec.ts)。

## 3. 最值得移植：Task 与 CAS

Task 独立保存 `id / revision / status / ownerId / blockedBy / writeScopes`。状态为 pending、in_progress、completed、deleted；领取、释放、完成、重开、改依赖、重新分配均为明确命令。更新要求 expected revision，先校验当前版本和角色/owner，再产生 revision + 1。两个人依据同一旧版本抢占任务时，不会静默覆盖。

依赖检查包括缺失、删除、自依赖、重复和环。ready 是派生值；依赖任务完成后，pending 任务才可 claim。删除用 tombstone 保留身份，仍有非 deleted 依赖者时不能删 blocker。**ready 不会自动启动 owner，complete 也是受权主体的显式声明，并非输出质量证明。** reopen/修改依赖也不提供自动级联重跑下游的合同，不能把该任务板视作完整工作流引擎。

这正好为本项目 F-02 建立业务层：消息 processed 只提交消费；任务通过独立 complete 提交业务声明。建议后续在现有 SQLite 内加入 tasks/task_dependencies 与 CAS 更新，保留树内权限和原预算门禁，暂不引入第二套日志存储或自动 DAG 执行引擎。

`task-graph`、`task-view` 中的纯校验/派生逻辑最容易提取；需要适配本项目类型和授权。直接引用整个 npm 包会带入 Cordis、Agent、Session、Subagent、投影及 persistence 等 peer 依赖。包为 MIT；本轮未复制第三方生产代码。

来源：[task-board.ts](https://github.com/deepseek-ai/deepseek-harness/blob/2fbf4359b82fb94c03dcce0b831660d87f12ea5c/packages/experimental/agent-team/src/task-board.ts)、[task-graph.ts](https://github.com/deepseek-ai/deepseek-harness/blob/2fbf4359b82fb94c03dcce0b831660d87f12ea5c/packages/experimental/agent-team/src/task-graph.ts)、[task-view.ts](https://github.com/deepseek-ai/deepseek-harness/blob/2fbf4359b82fb94c03dcce0b831660d87f12ea5c/packages/experimental/agent-team/src/task-view.ts)。

## 4. 事件等待比持续问状态更实用

`wait_agent` 是一次性等待后续变化，超时/取消会清理 timer 与 listener；dispose 释放所有等待者。工具先同步读取其他成员活动状态，再注册 waiter，避免两者中间 await 丢失唯一状态边沿。若其他成员全部 inactive，立即返回带操作建议的 `noProgress`，提示先发消息唤醒所需节点。

它本身不是唤醒命令，也不是 durable cursor；返回后需重读状态。对本项目优先增加 **operator CLI 的带事件 sequence 的有界等待**，让 Skill 一次阻塞等待进展并取得下一游标，减少反复 shell 查询和模型轮次。继续让托管 Agent 委派后结束 Turn，不能直接照搬会长期占住活 Turn/并发额度的模型 wait 工具。

来源：[工具 wait_agent](https://github.com/deepseek-ai/deepseek-harness/blob/2fbf4359b82fb94c03dcce0b831660d87f12ea5c/packages/experimental/tool-agent-team/src/index.ts)、[activity.ts](https://github.com/deepseek-ai/deepseek-harness/blob/2fbf4359b82fb94c03dcce0b831660d87f12ea5c/packages/experimental/agent-team/src/activity.ts)。

## 5. UI 和共享工作目录的边界

新版 UI 订阅 Lead Session 的 `agentTeam` projection；成员运行态和模型分别从共享 Session status/modelSelection 派生，切换对话沿用普通 continuable child address。UI 不维护第二份权威 Team 状态，不使用 Team Remote 重新轮询，也不能编辑任务。坏持久事件会在投影中保留 failure，展示最后有效状态及错误，而非悄悄当空团队处理。

这是合适的后续展示层参考：先定义统一只读 Team view，再让 CLI/未来 UI 消费，写操作仍回到同一业务服务。当前 Codex Skill 并没有 DSH 的标题栏插件插槽；本轮没有承诺能直接挂上该 React 面板。

DSH 多人共用同一 cwd，writeScopes 只是按路径前缀生成重叠警告，既不是锁，也不是 worktree。工具 policy 提醒普通文件编辑的版本冲突与 shell/formatter 的覆盖风险。其 Team 包还明确不提供多进程协调或自动释放 task owner。此设计不能作为本项目开放并发写代码的隔离依据；进入编码阶段仍需单独决定 worktree/写权限/合并协议。

来源：[UI mount](https://github.com/deepseek-ai/deepseek-harness/blob/2fbf4359b82fb94c03dcce0b831660d87f12ea5c/packages/experimental/client-ui-agent-team/src/client/mount.ts)、[TeamAction.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/2fbf4359b82fb94c03dcce0b831660d87f12ea5c/packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx)、[任务路径警告](https://github.com/deepseek-ai/deepseek-harness/blob/2fbf4359b82fb94c03dcce0b831660d87f12ea5c/packages/experimental/agent-team/src/task-view.ts)、[领域限制](https://github.com/deepseek-ai/deepseek-harness/blob/2fbf4359b82fb94c03dcce0b831660d87f12ea5c/packages/experimental/agent-team/README.md)。

## 对本项目的建议顺序

| 顺序 | 建议 | 保留的本项目约束 |
| --- | --- | --- |
| 1 | 最小 Task 状态、owner、revision/CAS、依赖校验，独立 complete | 同一个 SQLite 事务域；消息回执不替代任务完成 |
| 2 | operator CLI 事件等待、游标、无进展原因 | 托管 Agent 委派后结束 Turn；不绕过预算/暂停/unknown |
| 3 | 统一 Team 只读投影；未来 UI 展示树、任务、消息和预算 | UI 不持久化权威业务状态，写操作走服务 |
| 4 | 评估 fresh/fork 与上下文成本；编码模式另行资格测试 | 稳定 Agent/Thread 分离、代际授权、凭据域与 worktree 决策 |

三个 Team 包的配置没有本项目的父子 token 预算转移与黑盒 Turn 最终结算合同；未据此审查或否定整个 Harness 的其他预算能力。也不建议为了复用这三个插件，把 Codex Runtime 替换为完整 DSH。

## 验证到什么程度

- 实际下载并校验三个 `0.2.1-alpha.3` 分发包，另下载领域包 `0.1.5-alpha.2` 比较旧邮箱；没有执行安装脚本。
- 阅读固定 tag 下的领域、工具、UI、相关 inbox/steer 源码与关键测试，并比较 master 的工具 policy 差异。
- 对发布 JS 的 DAG 纯函数执行六个探针：合法依赖、环、缺失 blocker、重复 blocker、已删除 blocker、自依赖，全部符合预期。
- 未执行其完整 monorepo 集成测试、真实模型团队、进程故障或端到端 UI 测试。不能用仓库已有测试的存在来声称本机已跑过，也不将这些六个探针混入本项目的 67 项回归计数。

本轮无 Runtime 代码变更，无新增 npm 依赖，不需要新的 Skill Release。
