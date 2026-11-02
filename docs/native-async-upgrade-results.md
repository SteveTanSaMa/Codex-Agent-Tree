# Native asynchronous command and installed-upgrade results / 原生后台命令与安装升级结果

2026-11-02, macOS arm64. The candidate source is based on `aa8d08b`, with the package-documentation fix from this work. Tests use isolated repositories, state directories and daemon homes; no release is created. Real-provider cases use Codex CLI `0.162.0-alpha.17.2` and `deepseek-v4.1-flash-1017`. Published Beta 3 remains unchanged.

2026-11-02，macOS arm64。候选源码基于 `aa8d08b`，另含本轮安装包文档修复。测试使用隔离仓库、状态和 daemon 目录，不创建 release。真实提供商用例使用 Codex CLI `0.162.0-alpha.17.2` 及 `deepseek-v4.1-flash-1017`，已发布 Beta 3 不变。

## Short real-provider tests / 真实提供商短测

- `test/real/async-lifecycle-native.test.ts`: the model called start, stop and status and observed a durable `completed`/`cancelled` receipt. In a separate team, after the original native Turn completed while the command was still running, scope replacement cancelled it, reached `ready` and dispatched one new completed native Turn with one command receipt. This is a real CLI/model integration, not a deterministic forcing of every race ordering.
- `test/real/async-crash-native.test.ts`: after a background command wrote one external effect and the native Turn finished, SIGKILL terminated the Coordinator. The supervised command stopped; reconnect to the same daemon preserved the original Thread, Attempt and Turn, with exactly one Turn in native history. The accepted command receipt remained unresolved, and no duplicate effect or Turn was observed. The test did not cover every crash window or establish exactly-once external effects.
- `test/real/async-lifecycle-native.test.ts`：模型调用后台启动、停止及状态查询，并观察到 `completed`/`cancelled` 收据。另一个独立团队中，原生 Turn 完成但命令仍运行时替换任务，命令被取消、替换到达 `ready` 并完成一个新原生 Turn，收据仅一条。此真实 CLI／模型测试不强制覆盖所有竞态顺序。
- `test/real/async-crash-native.test.ts`：后台命令写入一次副作用、原生 Turn 完成后强杀 Coordinator。受监督命令退出；连接同一 daemon 后保留 Thread、Attempt 和 Turn，原生历史恰有一个 Turn；命令收据仍未结算，观察期间未重复副作用或 Turn。此测试不覆盖所有崩溃窗口，也不证明外部副作用严格执行一次。

## Actual installed ZIP upgrade / 真实安装包升级

`test/integration/upgrade-beta3-native.test.ts` uses the published Beta 3 ZIP (SHA-256 `b686db0a00c2c0febefcfaf100f62707cfc41ec812c5dcfe96d81f7271399ef8`) and the candidate ZIP (SHA-256 `bd93d01c57c631b64b4ef9d54fb4e82a3856ed3b4dd746e7778daf3f4897ab7e`). Both are separately extracted and set up; actual Codex CLI/daemon uses a local scripted Responses provider, not a real model. The upgrade preserved agent and native identities, queued input, tasks and an edited child worktree without replay. A deliberately inserted `accepted` command receipt, simulating a legacy crash remnant, survived migration, stopped backup, verified restore to original fixture paths and restart unchanged; it blocked scope replacement until explicit review as `reviewed-unknown`, never as success. The fixture also verifies database integrity and refusal to downgrade the migrated database.

该测试使用经哈希核对的官方 Beta 3 ZIP 和本轮候选 ZIP，分别解包与安装；真实 Codex CLI／daemon 对接本地脚本 Responses 服务，不调用真实模型。升级保留 Agent 与原生身份、排队输入、任务和已编辑子 worktree，未重复派发。人工插入的 `accepted` 收据用于模拟旧版崩溃遗留：迁移、停机备份、校验、按原路径恢复和重启后仍未结算；任务替换在显式 review 前保持阻断，review 后仍为 `reviewed-unknown`，不伪造成功。测试同时检查数据库完整性及迁移后拒绝旧版降级。

The candidate originally omitted `docs/environment-diagnosis.md`; the archive allowlist now includes it and the installed Skill links to it. The package regression verifies the document and packaged `environment` entry point after supplying the locked production dependency offline.

候选包原先遗漏 `docs/environment-diagnosis.md`；本轮已加入打包清单并从 Skill 入口链接。解包回归在离线提供锁定的生产依赖后验证文档和安装包内的 `environment` 入口。

These are short, bounded tests on one macOS machine, not a nine-hour soak, a comprehensive CLI/provider compatibility matrix, or a guarantee of hostile-process isolation. No old release was modified and no new release was published.

这些是在一台 macOS 设备上的短时测试，不等同于九小时负载、完整 CLI／提供商兼容矩阵或对恶意进程的隔离保证。没有修改旧 release，也没有发布新版本。
