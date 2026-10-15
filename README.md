# Codex Agent Tree

一个可安装的 Codex Skill：把提供的文本分析任务委派给可递归创建子节点的独立 Codex Session，持久保存消息、身份、预算和执行记录。关闭调用 CLI 后团队继续运行；消息能唤醒空闲节点，Coordinator 重启后先对账再调度。

**当前版本 `0.1.0-alpha.2`：仅验证 macOS arm64、Node ≥26.3.1、`codex-cli 0.162.0-alpha.17.2`，单凭据域、只读任务。** 团队内禁用 shell，不支持读取调用者仓库、并发写代码或自动合并。应把相关文本放进任务。Skill 的当前对话负责操作团队；团队 Root 是另一个独立 Session。

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

`setup` 在 Skill 内执行锁定的 `npm ci --omit=dev --ignore-scripts`，只安装运行依赖 `ws`；`doctor` 不调用模型。[alpha Release ZIP](https://github.com/SteveTanSaMa/Codex-Agent-Tree/releases/tag/v0.1.0-alpha.2) 提供同一套自包含 Skill，不包含依赖缓存或登录状态，解压后同样运行 `setup`。

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
node "$SKILL_DIR/scripts/cat.mjs" status --target ROOT_ID
```

`init` 把现有登录复制到专用 runtime home（0600），不修改原配置、历史或认证。`--auth-from PATH` 可指定来源。使用短的专用目录，不要把普通 `CODEX_HOME` 当作 runtime home。默认 state 为 `~/.cat/team`，更换后每条命令带 `--state`。

Root 返回稳定 Agent ID，输出在 `status` 的 `attempts[].result` 中。Root 首次委派后空闲不代表完成；检查子节点和消息后，再取 Root 收到结果后的综合输出。请求重试保持 `--key` 和内容一致。任务消耗登录账号模型用量；默认 root 池为 200000 tokens，预算控制准入和核算，不是运行中 Turn 或账号账单的硬上限。

```sh
node "$SKILL_DIR/scripts/cat.mjs" send --target AGENT_ID --key input-001 --message '补充输入'
node "$SKILL_DIR/scripts/cat.mjs" control --target ROOT_ID --action pause
node "$SKILL_DIR/scripts/cat.mjs" control --target ROOT_ID --action resume
node "$SKILL_DIR/scripts/cat.mjs" stop
node "$SKILL_DIR/scripts/cat.mjs" start
```

暂停默认覆盖子树并 drain 活 Turn，消息仍排队；`--scope agent` 仅作用单节点。`cancel` 请求中断，`terminate` 永久终止。`stop` 只关闭 Coordinator，保留专用官方 daemon 与已接受工作。恢复、完整停机、未知执行和结算见 [操作说明](references/operations.md)。

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

[DeepSeek 实现参考](docs/deepseek-agent-team.md) · [首轮审查处理](docs/review-round-1.md) · [架构与设计取舍](docs/architecture.md) · [验证范围](docs/validation.md) · [Skill 入口](SKILL.md)

## 许可

Apache-2.0。复用并修改 Stoneforge JSON-RPC transport，固定来源与声明见 [vendor](src/runtime/codex/vendor/README.md) 和 [NOTICE](NOTICE)。模型执行和原生历史复用 Codex 官方 App Server daemon。本项目不隶属于 OpenAI。
