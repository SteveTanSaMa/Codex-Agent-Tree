> 后续更新：本文中的固定 CLI 策略是历史基线，已由[跨环境、恢复与整合测试](compatibility-recovery-round.md)的能力准入策略替代；当前实现不再按版本号或哈希允许列表锁定 CLI。

# Post-Beta-2 plan and acceptance goals / Beta 2 后续计划与验收目标

日期：2026-10-18。状态：**已开始实施，尚未完成全部阶段**。发布基线为 `v0.1.0-beta.2`（`2c9a29f`，schema 12）；开发中的 schema 13 和阶段性验证见[执行记录](post-beta-2-progress.md)。[补验成果](beta-2-gap-test-results.md)单独收录，不改变已发布安装包。本页的目标数值是验收条件，不是所有目标均已实现或兼容性均已通过的声明。

## 1. 目标与顺序

先提高任务变更和恢复的可解释性，再扩大兼容范围，最后依据证据决定下一次发布。当前默认限额、低层权限、单凭据域与固定 CLI 版本均保持不变；不以增加 token 配额代替恢复和调度改进。

| 阶段 | 交付目标 | 依赖与退出条件 |
| --- | --- | --- |
| P0：成果归档 | 收录补验源码、夹具、审计入口与报告，区分发布时/补验/收录复核证据 | 本轮执行；原始私有证据不入库，原 tag/ZIP 不变 |
| P1：范围变更 | 定义可审计的子树任务替换协议和队列内容可见性 | 先完成下述契约评审，再实现和测定点故障；不能以模型回复代替宿主状态 |
| P2：恢复边界 | 验证命令副作用、收据、Native Turn 的组合故障；完善诊断流程 | 与 P1 共用 fence/代际语义；先本地确定性与原生脚本提供商，不默认跑付费模型 |
| P3：兼容性资格 | 建立版本/能力清单、环境分层、升级回退证据 | 能力契约设计可提前；候选环境的完整资格验证须包含 P1/P2 核心不变量 |
| P4：调度与规模 | 测量并减少慢 RPC 阻塞，限制状态查询开销，验证复杂多仓库交接 | 在 P2 基线上引入有界并发；禁止直接全量并行调度 |
| P5：发布评审 | 汇总已支持组合、已知限制、迁移与恢复说明 | 下一 Beta / 正式版分开决策；本计划不承诺发布日期，也不扩大当前支持声明 |

## 2. P1：用户改变目标时可靠停止旧工作

### 2.1 契约设计

保留现有 `steer` 的当前 Turn 引导含义；普通 `pause` 仍保留队列。另行设计显式“替换子树任务范围”的操作，不把给 Lead 一条提示解释成已取消全树任务。具体命令名和表结构待实现设计评审，本页没有提供可执行的新命令。

拟采用持久化范围代际：任务、消息、Attempt 和工作授权记录所属范围。替换请求携带幂等 key 与期望代际，在一个 SQLite 事务中推进范围、封闭旧准入并取消旧范围待投递项；对快照中已有后代和正在创建的后代定义同一线性化边界。已接受的 Native Turn 单独中断/对账，不伪装成数据库事务的一部分。

替换结果须区分“请求已受理”“旧执行仍在排空/未知”“新范围可派发”。旧执行未确认终止时，不能在同一 Agent 启动替代 Turn。旧代际的迟到消息和工具请求拒绝或隔离，并给出可查询原因。代际推进以前已被接受的外部副作用无法撤销；返回尚未结算的命令与 Attempt 清单。

### 2.2 排队可见性

提出新的受管 Agent 状态投影：未正式投递消息默认只返回 ID、发送方、状态和必要元数据，正文仅在交付输入或授权诊断中出现。操作者的诊断权限与 Agent 的模型上下文权限分开。需要评估正文被现有客户端使用的情况，用明确的工具契约/配置版本处理变化；不追溯删除历史 Thread 中已出现的内容。

### 2.3 验收

- Root/L2/L3 同时存在排队、运行、spawn 和工具请求时替换范围：旧队列不再唤醒，新范围等待旧执行收敛；显式外部诊断可找到所有隔离项。
- 相同 key 重试返回相同结果，不同内容冲突；事务提交前后 SIGKILL、ACK 丢失、迟到工具请求和恢复重入均不得跨代际重复派发。
- 普通 steer/pause/cancel 的旧行为回归通过；新正文投影不泄露未投递内容，正式交付和 ACK 仍可用。
- 只有模型确认“收到新目标”不能判定全树完成切换；验收查 SQLite、Native 历史和实际工具副作用。

## 3. P2：执行中崩溃与跨状态域恢复

每个故障点明确故障发生前最后可观察事实，以及恢复后允许的状态集合。没有充分证据时维持 unknown 与人工诊断，不把“没找到历史”当作“没执行”。

| 故障族 | 计划注入 | 必须维持的事实 |
| --- | --- | --- |
| 命令副作用 | 命令准入后、实际副作用后、收据落盘前/后杀死宿主或 Coordinator | 同一调用不因重启自动重复副作用；无法确定的结果明确 unknown；人工重新执行须新请求且告知风险 |
| Native Turn | start 已接受但本地未记 ID；历史缺页/延迟；完成事件与 pause/恢复竞争 | 每 Agent 至多一个有效 Native Turn；已接受工作不得因缺证据自动重放 |
| 连接与事件 | 真正的代理断连、丢回复、重复/乱序通知、旧连接迟到回调 | 连接代际不污染新绑定；终态不被旧事件倒退；中断和最终用量可分别对账 |
| 提供商 | 401/403、429、5xx、响应超时、流中断、缺失用量 | 区分 CLI 内部重试与业务 Attempt；有截止、错误类别与已知/未知用量，无隐式业务重试 |
| 存储与恢复 | SQLite busy、磁盘满、写入失败、Coordinator/daemon 组合退出 | 不在持久化失败后继续派发；可明确诊断并恢复，不篡改或自动删除工作树 |

先采用可控本地 HTTP/SSE 提供商、网络代理和实际子进程。每个命名窗口至少重复 3 次并记录 seed/顺序；补充组合状态机测试，不把重复通过数当独立覆盖。断电/文件系统持久化保证须独立验证；进程 SIGKILL 不替代断电测试。

真实远程提供商只在另行安排的有限验证中运行；使用独立配置和证据目录，无自动付费重试。本轮不启动这些测试，也不复用既有长任务。

## 4. P3：跨环境、跨版本兼容性

### 4.1 当前证据与候选顺序

兼容性按具体组合发布，拆成协议/存储、文本团队、受限编码、安装与凭据四层。单个层通过或某个测试跳过，不等于完整支持。

| 维度 | 当前事实 | 计划验证，尚无支持承诺 |
| --- | --- | --- |
| OS / CPU | Beta 2 限 macOS arm64；命令隔离依赖 Seatbelt | 先记录基线机器准确 OS/build；再测仍受维护的两个 macOS 大版本（以执行时实际可用范围为准）及 Intel x64；随后 Linux x64/arm64；Windows 独立评估 |
| Node | 包声明 ≥26.3.1；不能据此声称所有未来版本通过 | 精确最低版本、26.x 一个较新固定版本、一个后续主版本；记录 Node 内置 SQLite 版本和锁文件，不随 CI 浮动更新支持结论 |
| Codex CLI | 精确锁定 `0.162.0-alpha.17.2` | 基线加一个较新、精确固定的候选版本；存在且有明确兼容价值时再测一个相邻旧版；不默认支持整个版本区间 |
| 登录 / 提供商 | 单凭据域；已有文件登录与一条隔离第三方路径证据 | 文件登录、环境变量、macOS Keychain 分开测；真实官方/第三方端点各自注明型号、传输和 CLI 版本；多凭据域不在本阶段 |
| Git / 文件系统 | 当前本地可信仓库与独立 worktree 路径通过 | 记录实际 Git 版本/能力；系统 Git 与另一固定版本；空格、中文、Unicode、大小写、符号链接、长路径、不同卷与权限拒绝 |
| 分发 / 升级 | Beta 2 ZIP 和 setup/doctor 有证据，schema 12 | Git clone/ZIP 洁净安装、路径含空格、隔离环境；旧状态升级与不可逆回退拒绝；runtime home 迁移单独评估 |

当前 `doctor` 限 darwin/arm64，编码沙箱仅有 Seatbelt，控制面依赖 Unix socket，凭据可能依赖 macOS Keychain。Linux/Windows 不是修改平台白名单即可支持；Windows 还需要替代 IPC、进程树终止、权限语义和凭据方案。WSL 与原生 Windows 分列，容器内 Linux 通过不能代替宿主全功能资格验证。离线安装和网络文件系统先保留未支持，除非增加相应证据。

### 4.2 版本与能力策略

设计兼容清单：项目版本、schema、CLI 完整版本、协议指纹、能力集、Node/SQLite、OS/CPU、Git、凭据方式、沙箱后端、验证日期及证据引用。必要能力包括 Thread start/resume/read、Turn start/steer/interrupt、动态工具回调、终态/usage 与历史关联；缺失必需能力应在创建新工作前明确失败。

先维持已资格验证 CLI 的精确允许列表，再依据协议与行为证据决定是否扩大范围；`--version` 相同不能替代能力探测。未知字段可按约定容忍，缺失身份/状态/关联字段不能靠默认值猜测；受控脚本提供商与真实 CLI 验证必须分开。不得为了支持新 CLI 静默关闭隔离、恢复 fence 或工具权限。

每个团队记录创建及最近连接所用运行环境。更换 CLI/Node/沙箱后端时，先做静止状态资格检查；正在运行的 Native Turn 仍由原 daemon 管理，不自动替换二进制或把旧 runtime home 交给新版接管。旧工作未结算时，拒绝自动切换或建立独立候选环境验证。

### 4.3 状态升级与回退

- 保存可重建的历史 schema/config 夹具，至少覆盖 Beta 1→Beta 2 和 Beta 2→下一候选版本；用当前迁移支持范围决定额外旧版，不臆造所有版本都可直升。
- 迁移前停止 Coordinator，确认 Native/命令状态已终结或明确隔离；SQLite 采用完整备份流程，不能在活跃 WAL 上仅复制主文件。备份包含配置与映射所需材料，凭据仍不入库。
- 验证迁移幂等、中途失败不形成半迁移状态、绑定/计数/提醒游标/权限保持、旧 enforce 模式不被自动转换或扩大权限。新建默认值与历史保留值分开断言。
- 旧程序遇到较新 schema 须明确拒绝。回退以停止新环境后恢复一致备份或使用独立环境为准，不承诺 schema 降级；恢复前确认不存在继续执行的旧 Native Turn，不自动重放 unknown。
- 跨机器/OS 搬迁不能直接沿用 PID、socket、绝对路径、Keychain 引用或 Git worktree 管理记录。先做只读诊断和路径映射设计，再决定哪些状态可迁移；复制目录不视为迁移通过。

### 4.4 验证分层与覆盖控制

1. 每次提交：无模型的类型、格式、契约与存储测试；使用当前支持环境作合并门槛。
2. 选定矩阵：精确固定 Node/CLI/OS 镜像与依赖，跑 native/故障/沙箱/安装检查。先逐维变化定位问题，再用成对组合补覆盖；发布声明中的每个完整组合仍须跑完整关键链路，不能用成对覆盖替代。
3. 无相应平台或隔离能力时，结果标为 unavailable/unsupported；不能把 skip 计为通过。不支持的平台不得回退为无沙箱执行。
4. 少量远程提供商验证单独授权和计数，不纳入默认测试。日志脱敏，凭据和原始会话不上传公共 CI。

**退出条件**：至少保住原基线并完整验证一个较新 CLI 候选；至少验证一个新增 macOS 环境或明确记录其阻塞。Linux/Windows 只有协议或单元测试通过时仍是部分验证，不能进入全功能支持列表。后续正式版可以限定已验证平台，不要求先覆盖全部 OS。

## 5. P4：调度、历史与协作交接

先添加可对照的排队/RPC/执行耗时证据，再设计有界并发调度；预算准入、代际校验、每 Agent 单 Turn 和生命周期更新仍需串行化或事务保护。

| 目标 | 拟验收条件 |
| --- | --- |
| 慢 RPC 不拖住无关成员 | 3 并发、一个 Agent 的 RPC 延迟 30 秒时，其余可运行 Agent 在本地受控夹具中 2 秒内出现派发尝试；慢 Agent 不绕过准入且无重复 Turn。目标是调度延迟，不是远程模型首 token SLA |
| 历史查询有界 | 20 成员、合计 1,000 历史 Turn / 10,000 消息，分别测重启、view/status/list；默认返回数量和字节有上限，查询不先装入全部历史。记录机器和分位数，先不编造跨硬件耗时承诺 |
| 明确依赖交接 | 交付物记录 repo ID、base/head、diff/hash、测试收据和依赖；缺测试入口/依赖提前诊断；不自动复制未提交文件或隐式重写子工作树 |
| 冲突与部分集成 | 两成员重叠修改、依赖版本不一致、两个仓库中只完成一个集成时，Lead 可辨认并重新验证；不自动宣告整体成功，也不假装跨仓库原子提交 |
| 停滞与提醒 | 用可控时钟验证重启/交互边界，并用短代表性负载记录误报/漏报线索；15/10 分钟阈值未经更广负载校准前仍标为默认建议值 |

完成以上后再设计单 Agent/多 Agent 的时间、观测用量与质量对比。账单与观测 token 分开；质量结果不能替代 Runtime 正确性，也不在本轮安排长时间测试。

## 6. 发布门槛与非目标

下一 Beta 需要基线回归通过、变更对应的恢复/迁移测试、明确兼容矩阵、可复现安装包和双语仅含变更/修复的 release notes。正式版还要求在声明支持的组合中完成 P1/P2 关键窗口、升级/回退演练及 P4 规模目标；没有已确认且未解决的发布阻断级重复执行、越权或状态丢失缺陷。证据不足保持 Beta，不以测试数量决定稳定性。

本计划不承诺外部副作用 exactly-once、任意第三方提供商、恶意仓库强隔离、多凭据域、自动跨仓库合并或无条件跨机器搬迁。没有这些功能也可以发布限定范围的稳定版，前提是支持边界清楚且核心承诺已验证。

## English summary

**Implementation has started; the full plan is not complete.** See the [execution record](post-beta-2-progress.md) for implemented behavior, bounded evidence and remaining work. The published Beta 2 payload remains unchanged. Collected follow-up evidence is separate from release-time results.

The proposed order is: auditable subtree scope replacement and queued-content projection; execution/receipt/native recovery fault windows; compatibility qualification; bounded scheduling, history queries and multi-repository handoffs; release review. Existing steering and pause semantics remain explicit. Accepted external side effects cannot be rolled back, and ambiguous execution must not be automatically replayed.

Compatibility is qualified per exact combination and capability layer, rather than inferred from a version string or skipped tests. Keep the current macOS arm64 / exact CLI baseline, qualify one newer fixed CLI, then additional macOS environments. Linux and Windows require explicit sandbox, IPC, credential and process-lifecycle work; no unrestricted fallback is allowed. Node, SQLite, Git, filesystem semantics, provider transport/authentication and clean installation each need evidence. Unknown combinations remain unqualified.

Upgrade tests must preserve identity, permissions, counters and uncertainty; older software must reject newer state schemas. Rollback uses consistent stopped-state backups, not assumed schema downgrades. Active Native Turns and old runtime homes cannot be silently taken over by a new binary. Cross-host migration must account for absolute paths, worktree metadata, sockets, PIDs and credential references.

Use deterministic/local-provider tests first, fixed environment matrices next, and separately authorized small real-provider checks last. Future numerical acceptance targets are design goals, not current performance guarantees. A stable release may remain platform-scoped, but all declared configurations must meet the recovery, migration and installation gates.
