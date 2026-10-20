# Codex Agent Tree

> main 当前为 Beta 4 候选（schema 15）：活跃查询、自动任务归档、只读诊断、交接预览及限定测试端点。已发布 Beta 3 不变；候选资格见[工程改进记录](docs/engineering-improvements.md)及[维护与持久交接](docs/maintenance-and-handoff.md)。

简体中文 · [English](README.en.md)

一个可安装的 Codex Skill：用独立、可恢复的 Codex Session 组成递归团队，支持消息唤醒、任务依赖、受控编码和故障对账。

**`0.1.0-beta.4` 候选：面向 macOS arm64、Node ≥26.3.1、单凭据域；Codex CLI 按所需协议能力准入，不再锁定精确版本。** `0.162.0-alpha.17.2` 与 `0.163.0-alpha.10.2` 已有原生行为验证。默认仍是文本分析；显式选择 Git 仓库后，Lead 使用有执行收据的终端，二级 Agent 在独立工作树中读写和运行白名单测试，三级及更深节点只读。当前对话是操作者，团队 Root 是独立 Session。

Beta 限定于可信本地仓库；完整编码 Runtime 尚未支持 Linux/Windows、多凭据域或自动合并。见[编码边界](references/coding.md)、[Beta 3 验收](docs/beta-3-validation.md)和[分层兼容证据](docs/compatibility-recovery-results.md)。升级前停止 Coordinator 并备份完整 state；schema 13/14→15 保留身份、计数、队列和工作树，旧版不能读取新版状态。已有团队不自动获得新权限，原生 Thread 保留原工具目录。

Beta 3 新增子树 `scope-replace` 与未知命令收据的 `command-review`，强化旧工作代际授权检查，限制状态历史输出，并修复慢 RPC 阻塞新到达任务的调度问题。详见[操作说明](references/operations.md#scope-replacement)、[发布变更](docs/releases/v0.1.0-beta.3.md)和[验收记录](docs/beta-3-validation.md)。

多仓库团队使用 `init --workspace-config /absolute/path/workspaces.json`，登记每个独立 Git 根目录；上层目录无需有 `.git`。每个二级 Agent 可获得一个或多个仓库，在 `state/workspaces/AGENT_ID/仓库目录名` 中分别创建独立 worktree，保留 MiPlay App / DXMT / LSFG 的相邻布局。三级默认只读继承父工作树，也可创建独立只读 worktree。仓库授权只能缩小；Lead 按仓库审核和集成。[配置示例和工具用法](references/coding.md#multiple-repositories)。

首个正式版计划为 **v1.0.0，仅承诺 macOS**；现有真实长任务证据继续保留，新增九小时持续负载补验见[正式版测试计划](docs/v1-macos-soak-plan.md)。Linux/Windows 完整编码支持另行推进。

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

首次使用前准备 Node 和通过能力准入的 Codex CLI，并完成文件型登录（`codex login`）。本项目不会自动替换你的 Codex。检查与安装运行依赖：

```sh
SKILL_DIR="${CODEX_HOME:-$HOME/.codex}/skills/codex-agent-tree"
node "$SKILL_DIR/scripts/cat.mjs" setup
node "$SKILL_DIR/scripts/cat.mjs" doctor
```

`setup` 在 Skill 内执行锁定的 `npm ci --omit=dev --ignore-scripts`，只安装运行依赖 `ws`；`doctor` 不调用模型。[已发布 Beta 3 ZIP](https://github.com/SteveTanSaMa/Codex-Agent-Tree/releases/tag/v0.1.0-beta.3) 是旧版本的自包含 Skill；当前 Beta 4 候选用 `npm run package:skill` 构建。二者均不包含依赖缓存或登录状态，解压后运行 `setup`。

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

Root 返回稳定 Agent ID，输出在 `status` 的 `attempts[].result` 中。Root 首次委派后空闲不代表完成；检查子节点和消息后，再取 Root 收到结果后的综合输出。请求重试保持 `--key` 和内容一致。任务消耗登录账号模型用量。新团队默认只观测 token：5000000 是告警阈值，超出不阻断执行；所有 Agent 均不分配对话 token 配额。新团队默认交互模式，累计 Turn 不设硬上限但持续统计；`--mode batch` 保留单 Agent 20 / 全树 100。深度、累计成员和并发仍为硬限制。支持按对话/全树的单次或增量提醒，可选择总量、非缓存输入或输出。任务级软预算由用户单独选择；旧 enforce 状态保留兼容。

```sh
node "$SKILL_DIR/scripts/cat.mjs" send --target AGENT_ID --key input-001 --message '补充输入'
node "$SKILL_DIR/scripts/cat.mjs" control --target ROOT_ID --action pause
node "$SKILL_DIR/scripts/cat.mjs" control --target ROOT_ID --action resume
node "$SKILL_DIR/scripts/cat.mjs" stop
node "$SKILL_DIR/scripts/cat.mjs" start
```

暂停默认覆盖子树并 drain 活 Turn，消息仍排队；`--scope agent` 仅作用单节点。`cancel` 请求中断，`terminate` 永久终止。`stop` 只关闭 Coordinator，保留专用官方 daemon 与已接受工作。恢复、完整停机、未知执行和结算见 [操作说明](references/operations.md)。

## 编码团队

为新团队显式选择干净且已提交的仓库；state 和 runtime home 必须在仓库外：

```sh
node "$SKILL_DIR/scripts/cat.mjs" init --state "$HOME/.cat/code-team" --runtime-home "$HOME/.cat/code-runtime" --workspace /absolute/path/repository --test-commands /absolute/path/tests.json
node "$SKILL_DIR/scripts/cat.mjs" start --state "$HOME/.cat/code-team"
```

`tests.json` 由操作者定义固定的绝对可执行文件和参数，例如 `{"unit":{"executable":"/opt/homebrew/bin/node","args":["--test","test/sum.test.mjs"]}}`。不需要子节点运行测试时可省略 `--test-commands`。

| 层级 | 文件能力 | 命令能力 |
| --- | --- | --- |
| 一级 Lead | 选定仓库读写，审核并集成补丁 | 宿主提供的 `terminal`：命令、测试、本地 Git 操作 |
| 二级 | 独立 detached worktree 读写 | 仅 `run_test` 白名单；没有通用 shell |
| 三级及以下 | 读取父级工作树、搜索、diff | 没有 terminal 或测试执行权限 |

受限工具为 `read_file`、`write_file`（哈希冲突校验）、`search_code`、`git_diff`、`run_test`。层级限制由宿主检查，隐藏工具即使被直接请求也不能越权。命令经过 macOS 沙箱，默认禁止联网（命名测试可显式授权固定本地 TCP 端口），写入限自己的工作区，超时 30 秒，输出上限 64 KiB。Lead 与子节点命令均有持久收据；不确定结果不会自动重放。

每个 coding state 只支持一棵 Lead 树。二级工作树固定从初始化提交创建，不复制依赖、忽略文件或后续父级修改；不要让不同 Coordinator 同时编辑同一个 Lead 仓库。依赖较重的项目可由 Lead 在已有依赖的原仓库运行集成测试。用量不代表供应商账单，Beta 也没有证明多 Agent 比单 Agent 更省 token。完整操作与恢复规则见[编码说明](references/coding.md)。

## 执行限制

交互模式默认硬限制为深度 2、累计 20 个 Agent、3 个并行 Turn；累计 Turn 默认不限。`--mode batch` 默认每 Agent 20、全树 100 个 Turn。可用 `--max-depth`、`--max-agents`、`--concurrent`、`--max-turns`、`--max-total-turns` 调整。成员结束不会退还累计数量；失败、中断及已准备后取消的 Turn 仍计数，重启不清零。达到上限不再接纳新工作，已接纳的工作继续收尾。

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

升级前先停止 Coordinator 并备份完整 state 目录，再更新源码并重新 `setup/start`。Beta 4 候选将数据库迁移到 schema 15，旧版不能直接降级读取。已有团队保留各自的 token 策略，新团队默认 observe。已有原生 Thread 保留旧工具目录，可继续消息流程或由操作者维护任务；新增 Task 工具用于新 Thread，不强制重绑身份。

同时更换 CLI 时，停止进程并不会自动替换 daemon 管理包；按[更换可执行文件](references/operations.md#changing-the-codex-executable)先对账，再显式更新独立运行包。

## 开发与验证

```sh
npm ci
npm run typecheck
npm run format:check
npm test
npm run test:fault
npm run test:native   # 真实 CLI、隔离 daemon 与本地脚本提供商；不调用付费模型，需兼容 CLI 和测试登录配置
npm run test:real     # 调用真实模型，消耗账号用量
npm run package:skill
```

默认测试不消耗模型用量。真实测试使用独立临时目录，清理测试认证副本与自有 daemon；生成证据在 `.artifacts/evidence/`，不纳入 Git。递归示例见 [example](examples/recursive-team/README.md)。

[执行限制计划](docs/execution-limits-plan.md) · [任务板实施计划](docs/task-board-plan.md) · [DeepSeek 实现参考](docs/deepseek-agent-team.md) · [首轮审查处理](docs/review-round-1.md) · [本轮架构审查与未修复项](docs/review-architecture.md) · [架构与设计取舍](docs/architecture.md) · [验证范围](docs/validation.md) · [Skill 入口](SKILL.md)

## 许可

Apache-2.0。复用并修改 Stoneforge JSON-RPC transport，固定来源与声明见 [vendor](src/runtime/codex/vendor/README.md) 和 [NOTICE](NOTICE)。模型执行和原生历史复用 Codex 官方 App Server daemon。本项目不隶属于 OpenAI。

Beta 2 支持在新团队 manifest 中显式登记外部只读资源，供受限成员浏览和读取、供 Lead 命令只读分析；原资源不可写。经用户明确授权，可用 `limits --max-turns unlimited --max-total-turns unlimited --target ROOT_ID --reason TEXT` 取消原树 Turn 上限，保留计数和身份。[资源访问](references/coding.md#external-read-only-resources) · [额度更新](references/operations.md#explicit-turn-limit-changes)。

## 交互执行控制

`send` 对运行中的交互 Agent 默认尝试实时引导；`--delivery queue` 留到下一轮，`steer` 显式请求当前执行投递。`status.interaction` 区分已接收、投递中、Runtime 接受、排队和未知；未知结果不自动重发。`control --action pause --immediate` 持久化子树暂停并请求中断，普通 pause 仍等待当前轮结束。

默认在连续自主执行 15 分钟、缺少可观测活动 10 分钟或连续 8 次相同工具拒绝时告警；自动暂停和任务 token/时间软预算由用户选择。已有团队不自动改变策略和限额。详见[实施计划、默认值与操作说明](docs/interactive-control.md)。本轮仅做短测试和本地原生协议探针，未安排长时间真实任务。

## Token 用量提醒

新团队取消对话 token 配额；默认全树达到 5000000 总 token 提醒一次。`token-reminder --target ID --threshold N [--every N] [--scope agent|tree] [--metric total|uncachedInput|output]` 可配置单次或增量提醒，`--disable` 关闭。提醒不暂停、不新增 Turn、不请求模型；用量缺失时显示未观测。详见[用量提醒与迁移说明](docs/token-reminders.md)。

当前 main 的能力准入、跨环境与恢复补验见[本轮结果](docs/compatibility-recovery-results.md)。已发布 Beta 2 的固定 CLI 说明仅适用于该 tag；main 不再使用精确 CLI 版本锁。

新增操作：`diagnose --state DIR` 只读诊断；`task-history --target ID --after 0 --limit 50` 历史分页；`handoff-record` / `handoff-preview` 交接与整合预览。完成任务自动归档并释放活跃容量，历史与删除分开。详见[操作说明](references/operations.md)与[macOS 配置](references/coding.md)。
