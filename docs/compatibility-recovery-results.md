# Compatibility, recovery and integration results / 跨环境、恢复与整合补验

日期：2026-10-18。计划：[本轮计划与验收](compatibility-recovery-round.md)。代码基线：`eb6cc9b`（能力准入始于 `63e0b56`）。本轮不发布新 tag，也不修改已发布的 Beta 2 安装包。

## 已取消精确 CLI 版本锁

当前 main 的 init、doctor 和 Runtime 不再按固定 CLI 版本或 schema 哈希允许列表放行。遗留配置中的 `expectedVersion` 被忽略；不需要修改旧配置来适配新版本。

启动前以无凭据临时 home 导出实验协议，检查实际使用的方法、输入字段与样例载荷、必填输出、身份字段、Turn/Thread 状态及动态回调。兼容的新增可选字段可通过；缺失能力、变更输入类型或不再接受既有枚举值会给出明确诊断。CLI 版本、协议指纹与 Node/SQLite/OS/CPU 作为审计信息持久化，不作为发行号门槛。探针是适配器所需契约的结构检查，不是完整 JSON Schema 验证器，也不能取代真实运行验证。

仍保留启动器与当前 daemon 的版本一致性检查，防止换二进制后误接旧进程；保留 Node 最低 API、数据库拒绝降级和沙箱要求。这些检查不能通过关闭权限隔离来绕过。未知未来 CLI 不会仅因版本号被拒绝，但也不能预先声称已通过行为验证。

## 验证矩阵

本机 macOS 27.2 / build 26B5091g / arm64，Node 26.3.1、SQLite 3.53.3、Git 2.48.1。

| CLI | 行为范围 | 最终结果 |
| --- | --- | --- |
| `0.162.0-alpha.17.2` | 完整 native 套件：正式 CLI 生命周期、Thread/Turn、steer、动态回调、权限、重启和新增真实故障窗口 | 15 pass / 0 fail / 1 candidate-only skip |
| `0.163.0-alpha.10.2` | 同上；正式 CLI init/start 不再被旧固定版本阻断 | 15 pass / 0 fail / 1 candidate-only skip |

跨环境 CI：[首轮 6/6 通过](https://github.com/SteveTanSaMa/Codex-Agent-Tree/actions/runs/39127321032)，[最终代码复验 6/6 通过](https://github.com/SteveTanSaMa/Codex-Agent-Tree/actions/runs/39128093690)。每个作业输出实际解析的 Node、CPU 与 SQLite 版本。

| 环境 | Node | 覆盖层 |
| --- | --- | --- |
| macOS 15 arm64 | 26.3.1、26.12.0 | 类型检查、单元、完整默认和故障套件；没有在 CI 安装 CLI 或执行 native |
| Ubuntu 24.04 x64 | 26.3.1、26.12.0 | 类型、协议单元、scope/task/scheduler、存储准入和 WAL 备份 |
| Ubuntu 24.04 arm64 | 26.12.0 | 同上 |
| Windows Server 2022 x64 | 26.12.0 | 类型与纯协议单元；shebang CLI 探针用例明确 skip |

跟踪线 `26` 本次解析为 26.12.0，不能推论所有未来 Node 版本均已验证。Linux/Windows 的这些结果只证明表中层次，**不扩大完整编码 Runtime 的 macOS arm64 支持范围**。

## 新增恢复与整合证据

- **真实传输代理，3 次重复**：官方 daemon 已接受 turn/start，但代理扣留 started 通知并丢弃 ACK/断连；重启通过历史中唯一标记认领同一 Native Turn。随后注入重复终止及迟到 started，仍只保留一个业务 Attempt 和一次模型请求。
- **真实 Coordinator SIGKILL，3 次重复**：本地脚本提供商触发真实 terminal 动态回调；沙箱命令已递增效果计数、收据仍 accepted 时杀死宿主。监督进程停止孤儿命令；重启保留未知收据、原 Attempt 和计数 1，人工核查结算也不允许自动重放。
- **真实动态工具回调**：CLI 发出带原生身份的 agent_task_create，Coordinator 创建恰好一个 Task；工具结果回送提供商后结束原 Turn。不是直接伪造 Runtime 回调。
- **活跃 WAL 一致备份，3 次重复**：用 SQLite backup API 从仍持有 WAL 的写进程创建快照；源宿主仍活跃时恢复副本拒绝取得所有权。杀死源进程后恢复，保留绑定、消息、Turn 统计、未知用量、暂停和进行中的 scope replacement，完整性/FK 检查通过。Native 身份在此项为存储 fixture，不代表跨机器 Runtime home 迁移验证。
- **多仓库部分集成与恢复**：同库 sibling 独立 worktree，三级继承只读视图；Lead 集成第一个补丁后，陈旧 CAS 与冲突补丁被拒绝。另一个仓库上游 HEAD 前移，子工作树仍保持固定 base。部分集成的真实测试失败，Task 保持 in_progress；重建 Store/Broker 后继续明确审查、解决冲突，最终真实测试通过后才完成 Task。
- **调度与规模**：同波次预检最多 3 路，慢 RPC 不阻塞已有的独立 Agent；20 成员、1000 Turns、10000 消息的分页与截断标志验证保留。新增到达测试确认：波次开始后新来的工作会保留并在下一波执行，但仍须等待当前慢 RPC。用 100ms 控制门测出该等待，不将 fixture 时间当作生产性能基准。

测试入口：`npm test`、`npm run test:fault`、`npm run test:native`。旧二进制 native 运行同时设置 `CAT_TEST_CODEX` 并将其目录置于 PATH 前端，避免正式 CLI 子进程选到另一个版本。新增精确故障窗口各自重复 3 次，重复运行不计为新增独立覆盖。提供商均为回环地址的合成 Responses/SSE，不调用付费模型、不复用真实团队或其凭据。

## 回归记录与边界

本机最终默认回归 **163 pass**（17 单元 + 146 集成，另有 16 native/candidate skip）；故障套件 **44 pass / 0 fail**。两个 CLI 的完整 native 套件各 **15 pass / 0 fail / 1 candidate-only skip**；这个候选专用用例的 skip 不计为资格通过，两个版本实际都经过普通全套路径。类型检查、所改 TypeScript 格式、Skill 校验与自包含打包通过。最终 CI **6/6 作业通过**，对应代码提交 `eb6cc9b`；后续提交仅同步文档。

首次较新 CLI 全套出现过临时目录清理 `ENOTEMPTY`：daemon 停止后的文件清理竞争，已为该测试清理增加有界重试并重新跑全套。WAL fixture 首次比较遇到 SQLite null-prototype 行对象与序列化对象差异，已按序列化逻辑数据比较。新增负向能力测试的首次失败是错误文本断言不匹配，修正断言后重跑。未将这些首次失败删除或当作通过；本机原始日志保留在忽略的 `.artifacts/compatibility-round/`。

本轮不证明：物理断电或磁盘满的耐久性、任意恶意仓库隔离、全团队跨机器迁移、跨库原子提交、任意第三方模型或复杂任务的模型质量。慢 RPC 对新到达任务的波次等待仍是明确限制。命令未知结果要求核查，不能承诺外部副作用 exactly-once。

## English summary

Main no longer pins an exact Codex CLI release or schema hash. Admission checks required experimental protocol capabilities and actual adapter payload shapes; legacy expectedVersion settings are ignored. Launcher/active-daemon consistency, minimum Node APIs, schema downgrade protection and sandbox checks remain. Versions and environment manifests are audit data. Passing a schema probe does not qualify every future CLI behavior.

Final local regression: 163 passes, 44 fault-test passes; each retained CLI: 15 native passes and one candidate-only skip. Final CI: all six jobs passed at eb6cc9b. The round exercises both retained CLI binaries, actual callback transport, dropped acceptance ACKs, duplicate/late events, Coordinator SIGKILL after command effects, live-WAL backups and partial multi-repository integration. Each precise recovery window runs three times without paid models. CI separates macOS regression coverage from portable Linux storage/protocol coverage and Windows protocol-only coverage. Linux/Windows coding isolation remains unsupported. New arrivals still wait for the current bounded preflight wave; they are retained and dispatched once that wave completes. Published Beta 2 assets remain unchanged.
