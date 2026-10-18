# 多仓库与多 Worktree 设计

## 身份与布局

Repository 是操作者登记的独立 Git 仓库，Agent 是持久业务身份，Worktree 是 `(owner_agent_id, repository_id)` 的工作目录；三个身份分开。一个 Agent 可以被授予多个仓库，但只有一个主仓库作为原生 Thread 的 cwd。文件、diff、测试和终端工具通过可选 repositoryId 选择已授权目标。

新多仓库布局：`state/workspaces/<owner_agent_id>/<directory>/`。directory 默认为原仓库目录名，也可由操作者指定；同组目录名称必须唯一。MiPlay 可保留 `MiPlay App`、`MiPlay DXMT`、`MiPlay LSFG` 的相邻关系。多个 Agent 处理同一仓库时，各自拥有独立 worktree；不同仓库各自保留 Git common directory、基准提交和测试白名单。

原有单仓库配置与 `state/workspaces/<agent_id>` 布局继续使用，不移动旧目录或自动重绑 Thread。

## 权限与继承

- Lead 可访问全部登记仓库，默认在选定仓库的原始 checkout 集成改动。
- 子节点有 primary repositoryId 和 repositoryIds 授权集合，必须是父级集合的子集，默认只授权所选主仓库。
- 二级始终使用自己的 isolated worktree；不允许继承 Lead 原始 checkout。
- 三级及以下默认 inherit 父工作树，可显式选择 isolated；权限仍按层级执行，独立目录不赋予 terminal、写入或测试权限。
- 模型只能选择仓库 ID 与工作树模式，不能提交任意本地路径、Git common directory、分支或提交。

## 多仓库构建与一致性

每个独立 worktree 从仓库登记时的提交创建，不隐式复制父级未提交修改。共享父工作树适合审查父级当前修改；独立三级工作树看到固定基线，不能误称已经审查父级补丁。

需要相邻仓库依赖的 Agent 必须得到相应仓库授权。执行测试前为其授权的工作树准备目录；测试只允许写目标仓库，依赖工作树只读。Lead 可只读查看登记仓库和团队工作树，但一次 terminal 调用仅写选定仓库。跨仓库提交不具备原子性；逐仓库审核、测试、记录提交后再形成组合结果。

## 持久化与恢复

仓库配置在 state 中固定，Agent 的主仓库、授权集合与工作树模式随创建事务一并保存，幂等 spawn 必须包含相同选择。目录与 ready marker 按仓库/所有者区分；崩溃后不自动删除、reset 或认领未完成 checkout。不同仓库不得注册为相同 common Git directory 的别名，仓库根目录不得嵌套；state/runtime home 必须在所有仓库之外。

命令锁跟踪实际工作目录，而不再只依赖 Agent 主目录，防止非主仓库测试与共享该目录的三级读操作产生竞态。并发/深度/lifetime 限制仍覆盖整棵树；多仓库不会创建新的预算池。

## 验收

三个独立仓库、同仓库多个二级 worktree、三级 inherit/isolated、跨仓库授权拒绝、相邻依赖测试、非主仓库锁、重启映射/原生 cwd、幂等冲突、旧单仓库迁移和权限边界均需回归。真实 MiPlay 仓库仅作为路径配置示例，不用修改实际项目来验证功能。

## 已实现与验证（2026-10-16 历史快照；现随 Beta 2 发布）

入口为 `init --workspace-config JSON`；完整 MiPlay 示例和委派参数见 [coding operations](../references/coding.md#multiple-repositories)。schema 9 保存固定 registry 与 Agent 授权/模式。文件、搜索、diff、测试和 Lead terminal 接受 repositoryId，workspace_list/status 提供可查询映射；工作树按需创建，命令执行前准备已授权依赖目录。

本轮验证：

| 验证 | 结果 | 范围 |
| --- | --- | --- |
| 默认回归 `npm test` | 109 通过，5 个原生用例默认跳过 | 8 unit + 101 integration；包括 11 个新增多仓库用例和现有安装包抽取/编码检查 |
| 故障注入 `npm run test:fault` | 30 通过 | SQLite/恢复/命令父进程死亡等既有不变量 |
| 原生 Daemon `npm run test:native` | 5 通过 | 新增三仓库 worktree cwd 和工具 schema 注册；含既有重连/退出/恢复回归；零模型调用 |
| `npm run typecheck`、源码/新增测试格式、`git diff --check`、Skill validator | 通过 | 静态与打包说明完整性 |

新增多仓库用例实际使用临时 Git 仓库和 Seatbelt：同仓库多个二级隔离、三级 inherit/isolated、授权缩小、非法 spawn 事务回滚、按仓库测试白名单、相邻依赖可读不可写、非主仓库锁、注册表冻结、marker 错配/丢失保留文件、schema 8 单仓库迁移、CLI 相斥参数和所有仓库路径隔离。原生用例只创建/读取 Thread，不将空 Thread 元数据验证称为完成过业务 Turn 的冷恢复。

故障测试中的命令父进程死亡 fixture 原来使用假 baseCommit 和普通目录；本轮改为真实提交的 Git 仓库，以符合新增根目录/提交身份验证，随后实际 SIGKILL 验证通过。

以上是测试执行结果，不能视为真实 MiPlay 构建、复杂多仓库任务效率或跨仓库原子提交的证明。未修改真实 MiPlay 仓库，未运行新的付费模型任务。暂不新发 Release，既有 v0.1.0-beta.1 标签、安装包和说明保持不变；新增能力由 main 提供，下一次发布前再进行真实多仓库编码验收。

2026-10-18 发布更新：本功能纳入 `v0.1.0-beta.2`。上述计数与“未发布”描述为 10 月 16 日历史快照；本次实际发布验证见 [Beta 2 验收](beta-2-validation.md)。未据此宣称完成真实 MiPlay 或复杂多仓库构建验收。
