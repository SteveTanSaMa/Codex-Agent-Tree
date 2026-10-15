# Codex Agent Tree

简体中文 · [English](README.en.md)

一个可安装的 Codex Skill：把提供的文本分析任务委派给可递归创建子节点的独立 Codex Session，持久保存消息、身份、预算和执行记录。关闭调用 CLI 后团队继续运行；消息能唤醒空闲节点，Coordinator 重启后先对账再调度。

**当前版本 `0.1.0-alpha.4`：仅验证 macOS arm64、Node ≥26.3.1、`codex-cli 0.162.0-alpha.17.2`，单凭据域、只读任务。** 团队内禁用 shell，不支持读取调用者仓库、并发写代码或自动合并。应把相关文本放进任务。Skill 的当前对话负责操作团队；团队 Root 是另一个独立 Session。

## 安装

克隆到 Skill 目录；目标目录应不存在：

```sh
git clone https://github.com/SteveTanSaMa/Codex-Agent-Tree.git "${CODEX_HOME:-$HOME/.codex}/skills/codex-agent-tree"
```

也可在 Codex 中使用内置安装器的下载方式：

```text
$skill-installer 从 SteveTanSaMa/Codex-Agent-Tree 安装根目录 Skill，path 为 .，name 为 codex-agent-tree，method 使用 download。
```

根目录安装不使用安装器的 Git 稀疏检出方式，它可能只复制根文件而遗漏源码子目录。遇到 Python 证书链错误时，可使用上面的普通 `git clone`；无需关闭证书校验。

下一轮对话使用 `$codex-agent-tree`。Skill 采用 `SKILL.md` 与辅助脚本的官方目录形式，见 [OpenAI Skills 文档](https://learn.chatgpt.com/docs/build-skills)。仓库根目录即完整 Skill，不需要另外安装 MCP Server。

首次使用前准备 Node 和上述精确版本的 Codex CLI，并完成文件型登录（`codex login`）。本项目不会自动替换你的 Codex。检查与安装运行依赖：

```sh
SKILL_DIR="${CODEX_HOME:-$HOME/.codex}/skills/codex-agent-tree"
node "$SKILL_DIR/scripts/cat.mjs" setup
node "$SKILL_DIR/scripts/cat.mjs" doctor
```

`setup` 在 Skill 内执行锁定的 `npm ci --omit=dev --ignore-scripts`，只安装运行依赖 `ws`；`doctor` 不调用模型。[alpha Release ZIP](https://github.com/SteveTanSaMa/Codex-Agent-Tree/releases/tag/v0.1.0-alpha.4) 提供同一套自包含 Skill，不包含依赖缓存或登录状态，解压后同样运行 `setup`。

## 使用

向 Codex 提供任务及相关文本，例如：

```text
$codex-agent-tree 把下面这份方案交给一个小团队评审：Lead 创建风险分析员，风险分析员再创建预算检查员；逐级回报后给出综合建议。只分析以下文本：[粘贴方案]
```

也可直接操作 CLI：

```sh
node "$SKILL_DIR/scripts/cat.mjs" init --state "$HOME/.cat/team" --runtime-home "$HOME/.cat/runtime"
node "$SKILL_DIR/scripts/cat.mjs" start --state "$HOME/.cat/team"
node "$SKILL_DIR/scripts/cat.mjs" root --name Lead --key review-001 --max-agents 3 --task-file /absolute/path/task.txt
node "$SKILL_DIR/scripts/cat.mjs" tree
node "$SKILL_DIR/scripts/cat.mjs" view --target ROOT_ID
node "$SKILL_DIR/scripts/cat.mjs" wait --target ROOT_ID --after CURSOR --timeout-ms 25000
node "$SKILL_DIR/scripts/cat.mjs" status --target ROOT_ID
```

`init` 把现有登录复制到专用 runtime home（0600），不修改原配置、历史或认证。`--auth-from PATH` 可指定来源。使用短的专用目录，不要把普通 `CODEX_HOME` 当作 runtime home。默认 state 为 `~/.cat/team`，更换后每条命令带 `--state`。

Root 返回稳定 Agent ID，输出在 `status` 的 `attempts[].result` 中。Root 首次委派后空闲不代表完成；检查子节点和消息后，再取 Root 收到结果后的综合输出。请求重试保持 `--key` 和内容一致。任务消耗登录账号模型用量。新团队默认只观测 token：200000 是告警阈值，超出不阻断执行；子 Agent 无需分配 token。深度、累计成员、并发和 Turn 次数始终是硬限制。需要 token 准入时显式启用 `--token-policy enforce --tokens N`，它仍不是运行中 Turn 或账号账单的硬上限。

```sh
node "$SKILL_DIR/scripts/cat.mjs" send --target AGENT_ID --key input-001 --message '补充输入'
node "$SKILL_DIR/scripts/cat.mjs" control --target ROOT_ID --action pause
node "$SKILL_DIR/scripts/cat.mjs" control --target ROOT_ID --action resume
node "$SKILL_DIR/scripts/cat.mjs" stop
node "$SKILL_DIR/scripts/cat.mjs" start
```

暂停默认覆盖子树并 drain 活 Turn，消息仍排队；`--scope agent` 仅作用单节点。`cancel` 请求中断，`terminate` 永久终止。`stop` 只关闭 Coordinator，保留专用官方 daemon 与已接受工作。恢复、完整停机、未知执行和结算见 [操作说明](references/operations.md)。

## 执行限制

默认硬限制为深度 2、累计 16 个 Agent、3 个并行 Turn、每 Agent 20 个 Turn、整棵树 100 个 Turn。可用 `--max-depth`、`--max-agents`、`--concurrent`、`--max-turns`、`--max-total-turns` 调整。成员结束不会退还累计数量；失败、中断及已准备后取消的 Turn 仍计数，重启不清零。达到上限不再接纳新工作，已接纳的工作继续收尾。

仅限制深度与并发不能阻止串行创建和反复消息唤醒，因此还保留累计成员与执行次数限制。`view/status` 返回 `executionLimits` 与 token 策略。`--tokens N` 在默认 observe 模式仅设置观测阈值；不会中断模型。未知执行仍按原规则保守对账，不自动重放。详见 [操作说明](references/operations.md)。

## 任务板与等待

新团队可使用 `agent_task_create/get/list/update`：明确记录任务 owner、revision、依赖与结果。修改需当前 `expectedRevision` 和幂等 `requestKey`；`claim` 领取就绪任务，`complete` 显式写入结果。消息 ACK 和 Turn 成功不代表业务 Task 完成，Task 完成也不代表结果已经审核。依赖板校验环与状态；ready 本身不启动模型。多轮 Task 工具会增加累计上下文用量（包含缓存输入），默认记录并告警，不要求为正常委派预估固定 token 配额。

操作者可使用 `task-create/get/list/update`，例如：

```sh
node "$SKILL_DIR/scripts/cat.mjs" task-create --target ROOT_ID --key calc --subject Calculate --description '计算六组、每组七份的总数'
node "$SKILL_DIR/scripts/cat.mjs" task-update --target ROOT_ID --task-id TASK_ID --key claim-calc --revision 1 --action claim
node "$SKILL_DIR/scripts/cat.mjs" task-update --target ROOT_ID --task-id TASK_ID --key finish-calc --revision 2 --action complete --result '42 份'
```

`view` 统一返回 Agent、任务摘要、预算、消息计数和阻塞原因。用其 cursor 调用 `wait`，之后用每次响应的顶层 cursor 续读，`hasMore` 表示还有事件页。`noProgress` 需要检查输入、fence、预算或未知执行，并非团队完成；等待不占用托管 Turn。详细动作、权限和输入文件格式见 [操作说明](references/operations.md)。

升级前先停止 Coordinator 并备份完整 state 目录，再更新源码并重新 `setup/start`。alpha.4 会将数据库迁移到 schema 6，旧版不能直接降级读取。已有团队保持原先的 enforce 策略，新团队才默认 observe。已有原生 Thread 保留旧工具目录，可继续消息流程或由操作者维护任务；新增 Task 工具用于新 Thread，不强制重绑身份。

## 开发与验证

```sh
npm ci
npm run typecheck
npm run format:check
npm test
npm run test:fault
npm run test:native   # 官方隔离 daemon，不调用模型；需要精确 CLI 和登录
npm run test:real     # 调用真实模型，消耗账号用量
npm run package:skill
```

默认测试不消耗模型用量。真实测试使用独立临时目录，清理测试认证副本与自有 daemon；生成证据在 `.artifacts/evidence/`，不纳入 Git。递归示例见 [example](examples/recursive-team/README.md)。

[执行限制计划](docs/execution-limits-plan.md) · [任务板实施计划](docs/task-board-plan.md) · [DeepSeek 实现参考](docs/deepseek-agent-team.md) · [首轮审查处理](docs/review-round-1.md) · [本轮架构审查与未修复项](docs/review-architecture.md) · [架构与设计取舍](docs/architecture.md) · [验证范围](docs/validation.md) · [Skill 入口](SKILL.md)

## 许可

Apache-2.0。复用并修改 Stoneforge JSON-RPC transport，固定来源与声明见 [vendor](src/runtime/codex/vendor/README.md) 和 [NOTICE](NOTICE)。模型执行和原生历史复用 Codex 官方 App Server daemon。本项目不隶属于 OpenAI。
