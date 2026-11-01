# Reliability and long-command plan / 可靠性与长命令计划

This plan applies to the beta.4 candidate on macOS arm64. The existing SQLite state, native Thread identities, authorization and conservative reconciliation remain authoritative; no schema migration is needed for these changes.

本计划针对 macOS arm64 上的 beta.4 候选版本。沿用现有 SQLite 状态、原生 Thread 身份、授权和保守对账；本轮无需数据库 schema 迁移。

1. **Shutdown and recovery / 关闭与恢复**: concurrent stops must hold the database owner until all registered cleanup barriers settle; failures must be surfaced. Late native completion must be reconciled without duplicate dispatch or invented usage. 验收：并发关闭等待清理、失败可见，迟到完成从原生历史对账，不重复执行或伪造用量。
2. **Diagnostics and environment / 异常诊断与环境**: provide read-only evidence locations and recovery guidance; distinguish unavailable historical schema from an empty result. Preflight reports host metadata and configured policy without claiming sandbox, network or provider success. 验收：只读、不泄漏凭据；旧 schema 缺失明确标记；宿主检查不冒充端到端验证。
3. **Controlled long commands / 受控长命令**: Lead-only start/status/stop with bounded time and output, existing sandbox and workspace locking. Persist acceptance before launch and terminal results after exit; crash or missing evidence stays unknown without replay. 验收：权限、锁、取消、实际进程退出及强杀后收据均有测试；完成不自动唤醒空闲 Lead。
4. **Validation / 验证**: run deterministic unit/integration and fault tests; qualify the explicitly selected provider with a short actual CLI test. Native/model tests and simulated runtime tests are reported separately. 验收：区分真实 CLI 与模拟 Runtime；不安排长时间负载或自动发布。

Existing native Threads retain their original tool catalogs; background tools require newly created Lead Threads. The API provider configuration is operator-owned and credentials stay outside the repository. Linux and Windows coding isolation and 24-hour stability are not claimed.

现有原生 Thread 保留原工具目录；后台工具需新建 Lead Thread。API 配置由操作者管理，凭据保存在仓库外。不扩大 Linux/Windows 编码隔离或 24 小时稳定性承诺。

## Verification on 2026-11-01 / 2026-11-01 验证

- Default unit and integration suites passed (integration: 173 passed, 18 skipped); the fault suite passed 49 tests, including actual host SIGKILL and conservative background-command receipt recovery. Type checking and formatting passed.
- The selected provider returned the requested model as `deepseek-v4.1-flash-1017` and accepted a minimal Responses request. A real isolated Codex CLI two-Agent report passed, and a separate one-Turn native test observed `terminal_start` and the completed `terminal_status` receipt. These short tests do not establish long-duration stability or exactly-once external effects.
- 默认单元与集成测试通过（集成 173 通过、18 跳过）；故障注入 49 项通过，包括实际强杀宿主与后台命令未知收据恢复。类型及格式检查通过。
- 所选提供商返回的实际模型 ID 为 `deepseek-v4.1-flash-1017`，最小 Responses 请求成功。隔离真实 Codex CLI 双 Agent 回报测试通过，另一次单 Turn 原生测试验证 `terminal_start` 和完成后的 `terminal_status`。这些短测不证明长期稳定性或外部副作用严格执行一次。
