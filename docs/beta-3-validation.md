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
- 后续测试与结果在发布前补入。

## English

This round targets Beta 3 rather than a stable release. Gates cover incremental bounded scheduling, execution/recovery regression on both qualified CLIs, upgrading actual Beta 2 ZIP state, clean installed-package execution, six layered OS/Node CI jobs, reproducible archives and matching bilingual release notes. Experimental App Server contracts, trusted-local-workspace boundaries and uncalibrated sustained-load behavior remain explicit limits. No long paid-model research run is required.
