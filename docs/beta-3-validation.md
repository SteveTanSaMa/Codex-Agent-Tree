# Beta 3 release qualification / Beta 3 发布验收

日期：2026-10-18。开始基线：`b8878ff`。目标版本：`0.1.0-beta.3`。本轮决定采用 Beta 3：实验 App Server 契约、单机可信仓库定位及尚未校准的长负载行为仍不适合宣称稳定版。

## 发布门槛

1. 修复新到达任务被整个慢 RPC 波次阻塞的缺陷；预检最多 3 个，同一 Agent 不能重叠。满槽时只需任一槽释放，新工作即可前进；20 成员和树级事务准入不得退化。
2. 审查本轮修改涉及的执行/恢复边界，默认、故障及两个已资格验证 CLI 的 native 套件通过。不把 skip 计入已验证覆盖，不开展长时间付费模型研究。
3. 使用实际 Beta 2 发布 ZIP 构建隔离状态，验证升级、旧配置兼容、身份/Thread/计数/消息/工作树保留、新能力、重启和旧读者拒绝降级。新版安装包在 checkout 外执行 setup/doctor 和正式 CLI。
4. 六作业跨环境 CI 在最终代码提交上通过；Linux/Windows 只计已实现的协议/存储层，编码 Runtime 仍为 macOS arm64。
5. 同步版本、双语 README 和纯变更双语 release notes；检查 ZIP 内容、校验和、可重复打包和 Skill 引用。推送一致格式 commit、tag，发布 prerelease；不修改旧 release。

## 执行记录

- 调度缺陷先写反例：旧实现因 held preflight 阻塞新任务而失败，日志保留 `.artifacts/beta3/scheduler-before.log`。改为可补充队列与独立 Agent 预检槽位；相同 Agent 的待重检请求合并，保持事务 Prepare/markStarting 准入。
- 新增成员到达、3 槽饱和/释放、20 成员突发与停止期间迟到预检验证。不同成员可使用空闲槽位，同一成员不能重叠预检，Prepare/markStarting 仍执行原事务与代际准入。
- 官方 Beta 2 ZIP SHA-256：`084aa79ec29e76fee4de6e8eaef20244ab9830aa2871dffce5a7210b685793bd`。实际下载并核对校验文件，在 checkout 外执行 setup/init/start；本地合成 Responses 提供商通过原生工具创建第二名成员并在独立 worktree 写入文件。两名成员共两个 completed Turns，暂停后保留排队输入和未完成 Task。
- 用新版实际 ZIP 对同一状态启动：schema 12→13，Agent/Thread/绑定代际、历史 Attempt、策略、排队输入、命令与 worktree 记录逐项保持，配置保持（同时更换二进制的变体仅显式改 executable）。没有重放请求。新版范围替换撤销旧排队任务，完成一次新 Turn；重启后历史仍相同。实际 Beta 2 Store 明确拒绝新版数据库，且不破坏新状态。
- 同时切换 CLI 的初跑发现：即使停止 daemon，原生管理器仍保留旧运行包，触发 launcher/daemon 一致性拒绝。补入负向验证，确认拒绝不产生新请求；全部 native Turns 已终态后，使用官方 `daemon update --from-cli --yes` 显式更新测试专用 home，再迁移/恢复成功。没有关闭身份检查或自动更新用户环境。操作说明已补充该步骤。
- 升级测试第一个运行曾因 fixture 内联 JavaScript 对象缺少括号失败，修正后重跑；它不是生产实现缺陷。所有失败与复跑原始日志保留在忽略的 `.artifacts/beta3/`，不随包分发。

## 最终验证

代码提交：`f493903`。发布收尾提交只同步文档，不改变运行源码或包内容。

| 验证 | 结果与范围 |
| --- | --- |
| 默认回归 | **165 pass**：17 单元 + 148 集成，17 native/候选/升级用例默认 skip；不将 skip 算通过 |
| 故障注入 | **44 pass / 0 fail**；包括新调度行为、实际命令宿主 SIGKILL、WAL 快照和事务边界 |
| CLI `0.162.0-alpha.17.2` native | **16 pass / 0 fail / 1 candidate-only skip**，含实际同 CLI ZIP 升级 |
| CLI `0.163.0-alpha.10.2` native | **16 pass / 0 fail / 1 candidate-only skip**，含实际跨 CLI ZIP 升级 |
| 实际 Beta 2→Beta 3 ZIP 升级 | 同 CLI 和显式迁移至新 CLI 两个变体通过；各 2 个历史 Turns 保留、仅新增 1 个授权 Turn；所有成功请求合计 5 次/变体，不含预期拒绝的启动 |
| 跨环境 CI | [6/6 作业通过](https://github.com/SteveTanSaMa/Codex-Agent-Tree/actions/runs/39129005776)，对应 `f493903` |
| 类型 / 格式 / Skill | Typecheck、已跟踪代码及新增测试格式、Skill validator 通过 |
| 生产依赖审计 | 官方 npm registry 的 `npm audit --omit=dev` 报告 0 项；默认镜像不提供 audit API，未将其 404 当作通过 |
| ZIP 验收 | 32 个允许列表文件与 Git 逐字节相同；重复打包 SHA-256 一致；无认证、状态、依赖缓存和测试文件 |

CI 实际解析环境：macOS 15 arm64 的 Node 26.3.1 / 26.12.0；Ubuntu 24.04 x64 的 Node 26.3.1 / 26.12.0；Ubuntu arm64 和 Windows Server 2022 x64 的 Node 26.12.0。最低版本 lane SQLite 3.53.1，跟踪 lane 3.54.0。macOS 跑完整默认/故障套件，Linux 跑协议及选定存储/调度层，Windows 仅类型和协议单元；**不据此宣称 Linux/Windows 编码 Runtime 已支持**。本机 native 运行于 macOS 27.2 arm64、Node 26.3.1、SQLite 3.53.3。

发布包：`codex-agent-tree-0.1.0-beta.3.zip`，SHA-256：`b686db0a00c2c0febefcfaf100f62707cfc41ec812c5dcfe96d81f7271399ef8`。生成时没有包含 `.artifacts`、`test/rigorous/`、凭据或用户团队。运行包内容不受本文件后续补入测试结果影响。

## 可复现入口

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:fault
npm run test:native
npm run package:skill
```

升级用例需要操作者下载并校验实际 Beta 2 ZIP、解压并设置 `CAT_TEST_BETA2_SKILL`（Skill 目录）及 `CAT_TEST_BETA2_CODEX`（Beta 2 已验证 CLI 的绝对路径）。同时设置 `CAT_TEST_NATIVE=1` 后运行 `node --test test/integration/upgrade-native.test.ts`。用 `CAT_TEST_UPGRADE_CODEX` 显式选升级后的二进制；完整套件的 `CAT_TEST_CODEX` 与 PATH 前端也应指向所测二进制。测试只操作自有短路径临时 state/home/repo，用本地脚本提供商，不读真实凭据、不热升级用户团队。

## 仍保留的限制

使用者仍需信任本地仓库和测试命令；目前完整编码隔离只支持 macOS arm64、单凭据域。协议能力准入不保证任意未来 CLI 的行为，也不会替换官方 daemon 包。最多三个预检同时挂起时，其他工作仍需等待任一槽释放或 RPC 截止；这不是无界并发。

本轮没有执行长时间付费模型负载，不能据此校准 15/10 分钟提醒阈值或宣称任意复杂研究质量。此前真实递归编码的证据保留于 Beta 2 记录。本轮不证明物理断电耐久性、完整团队跨机器迁移、跨库原子提交或外部副作用 exactly-once；未知结果仍保留并要求核查。

**发布选择：Beta 3 prerelease。** 保留上述边界，不将通过选定测试夸大为稳定版保证。

## English

This round targets Beta 3 rather than a stable release. Gates cover incremental bounded scheduling, execution/recovery regression on both qualified CLIs, upgrading actual Beta 2 ZIP state, clean installed-package execution, six layered OS/Node CI jobs, reproducible archives and matching bilingual release notes. Experimental App Server contracts, trusted-local-workspace boundaries and uncalibrated sustained-load behavior remain explicit limits. Local default regression passed 165 cases and fault injection passed 44; each qualified CLI passed 16 native tests with one candidate-only skip; all six layered CI jobs passed at f493903. Actual published Beta 2 ZIP state upgraded to the installed Beta 3 ZIP, preserving identities, native history, queued work and edited worktrees. A CLI switch requires an explicit update of the dedicated official daemon package after native reconciliation; mismatch remains fail-closed. The 32-file archive matches Git and is reproducible. No long paid-model research run or existing-team hot upgrade was performed.
