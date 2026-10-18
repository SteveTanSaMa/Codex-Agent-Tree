> 后续更新：本文中的固定 CLI 策略是历史基线，已由[跨环境、恢复与整合测试](compatibility-recovery-round.md)的能力准入策略替代；当前实现不再按版本号或哈希允许列表锁定 CLI。

# Post-Beta-2 execution record / 后续计划执行记录

日期：2026-10-18。发布基线仍为 `v0.1.0-beta.2`，本记录描述其后的开发代码；未创建新 tag、Release 或安装包，没有热升级既有真实团队。方案和完整验收目标见[计划](post-beta-2-plan.md)。**这是阶段性实施，不是全部计划通过。**

## 已实施

### P1：范围替换与模型状态投影

- 新增操作者 `scope-replace`，要求稳定 key、期望工作代际和新任务。一个 SQLite 事务推进现有子树代际、撤销旧队列、取消未派发 Attempt、撤销旧未完成 Task、记录替换收据并排队新输入。正在 spawn 与替换之间通过同步事务和旧 Turn 认证检查确定边界。
- 旧 Turn 后续工具调用拒绝；已接受 Native Turn 与命令仍需真实收敛。范围替换处于 `draining` 时整个受影响子树停止新准入；未知执行、命令、引导和运行隔离均可查询。收敛后 `ready`，保留人类暂停、永久终止、权限、身份和累计计数。
- 子节点不会自动重复旧初始任务；目标收到替代任务，其余成员等待明确新分配。已交付但未确认消费的消息保留 unknown。撤销子树发往其他分支的旧排队报告，保留无关工作。
- 被撤销 Task 带 `withdrawnBy`，不可修改。外部依赖保留为可诊断阻塞，允许显式更换依赖；不会导致整棵任务图无法再编辑。已经完成的 Task 和子树外所有者的工作保留。
- 受管 `agent_status/list/control` 响应采用投影契约 v2，省略消息正文、assignment 和输入预览；操作者仍可诊断。历史 Thread 内容不能追溯删除，旧副作用不能撤销。
- 新增操作者 `command-review`：原生执行已结算、宿主无运行命令后，将已检查但无法恢复结果的命令标为 `reviewed-unknown`。它解除排空阻塞，但不是成功、用量结算或重放授权；同一调用仍不能重试执行。
- schema 12→13 原子迁移为历史工作回填代际 0，保留旧策略、映射和计数。操作示例与恢复限制见 [scope replacement](../references/operations.md#scope-replacement)。

### P2：已增加的故障与负向验证

- 范围替换事务提交前/后实际 SIGKILL；每个窗口 3 次。代际、队列、任务和收据要么全部提交，要么全部回滚；不伪造 Native 终态。
- 命令记录后但副作用前、外部子进程写入文件后但结果收据前、收据后杀死实际存储宿主，各 3 次。恢复保留 accepted/unknown 或读取缓存，不重新执行；这验证存储协议窗口，不冒充完整 Coordinator 在真实工作树命令中的任意崩溃组合。
- SQLite 页数限额产生真实 SQLITE_FULL，以及第二个连接占用写锁导致准入失败，各 3 次；检查输入、事件、Attempt 未半提交。这不是操作系统磁盘耗尽或断电耐久性证明。
- 实际固定 CLI 连接本地 HTTP 提供商的 401/403/429/503，每项一个 failed Attempt，无业务重试。CLI 内部请求次数与业务 Attempt 区分；没有远程凭据或付费模型。
- 原生范围切换验证旧 Turn 先 interrupted、新 Turn 后启动，并覆盖 steer、重启、身份和幂等重试。另有受控用例覆盖等待中的预检 RPC、已接受 start 但 ACK 尚未返回、旧引导不得重新入队。

### P3：兼容性探针与当前结论

新增无模型 `scripts/diagnostics/compatibility.ts`：在临时 runtime home 中导出实验协议 schema，记录按文件排序的哈希指纹、声明方法、准确 Node/SQLite/Git/OS/CPU。它不读取登录、不更改既有配置，也不把声明的能力当成行为资格。

```sh
node scripts/diagnostics/compatibility.ts /absolute/path/to/codex
node scripts/diagnostics/rollback-guard.ts /absolute/path/to/installed/beta2/skill
```

后者用操作者指定的实际 Beta 2 Store 源码打开可丢弃的 schema 13 数据库，确认旧读者明确拒绝，且逻辑状态保持。它不是自动降级或活跃 WAL 备份恢复测试。

| 组合 / 层 | 实际结果 | 支持结论 |
| --- | --- | --- |
| 本机 macOS 27.2 / build 26B5091g / arm64；Node 26.3.1；SQLite 3.53.3；Git 2.48.1 | 默认、故障和沙箱测试通过；固定 CLI `0.162.0-alpha.17.2` 原生套件通过 | 保持原平台与精确 CLI 限定，不据此扩大 Node 版本范围 |
| 同机器，候选 CLI `0.163.0-alpha.10.2` | 独立范围替换/steer/重启用例通过；随后原生套件尝试为 **7 pass / 2 fail / 1 skip** | 7 项核心适配器用例的部分行为证据；2 项完整 CLI 启动因配置仍锁定 0.162 而失败，不是完整兼容通过 |
| schema 12→13 | 历史身份、队列、计数保留；重复打开不重置代际 | 本地迁移路径已测；不代表跨机器搬迁通过 |
| 实际 Beta 2 旧 Store→schema 13 | 明确拒绝；新状态逻辑保持 | 不支持 schema 降级；回退仍需停止状态的一致备份和原生对账 |
| 其他 macOS/Intel、Linux、Windows/WSL、其他 Node/Git、真实远程提供商 | 当前没有对应环境或本轮证据 | 未验证；Linux/Windows 仍无完整编码隔离后端，不改变 doctor/platform/version guard |

两个 CLI schema 指纹不同：基线 `80566ecf4b4149d8c0ba51c38a29bcb7da67d13e628da6431f47b1cc0f5676f4`，候选 `fda4e917d436b3caa1617d303180923affc9464b767fa8b21e9c93a7a5bc4afd`。指纹差异只表示 schema 变化，不单独证明破坏兼容。

候选用例通过 `CAT_TEST_COMPAT=1`、`CAT_COMPAT_CODEX`、`CAT_COMPAT_EXPECTED_VERSION` 显式选择。适配器层 native 用例也允许 `CAT_TEST_EXPECTED_VERSION`，仅用于资格验证，不改变生产 init 的版本锁。完整 CLI 测试仍按生产配置执行，不能用测试覆盖参数绕过它来宣布完整支持。

### P4：已实施的有界预检与历史查询

- 独立 Agent 预检最多 3 个 worker；只有 Runtime RPC 等待重叠，Prepare/markStarting 继续执行事务准入和代际检查，不增加每树 Turn 并发上限。
- 持续挂起一个预检时，同一调度快照中的两个独立可运行成员在 2 秒测试截止内派发。用可控 gate 验证独立性，未实际等待 30 秒，也不是远程首 token SLA。当前调度仍按快照/波次推进，运行中新增成员的等待界限仍需进一步验证。
- status 的 Attempt/消息在 SQL 取最近 20/50 条，view 取最新一条及聚合计数；不先在 JavaScript 中加载全部历史。增加相应索引。
- 受管结果预览上限 2,000 字符，注明 `resultTruncated`，避免父节点一次列出全树时复制大段结果。预算诊断最多展示 100 个未知用量 ID，并提供完整数量与截断标记；完整账本、负债与准入不受展示上限影响。
- 20 成员、1,000 个合计历史 Turn、10,000 条合计消息的本地夹具通过；测试拒绝 status/view 使用无界历史读取。该用例是数据库查询验证，不是真实模型长任务，也没有跨硬件延迟保证。

## 验证与证据

本轮没有真实远程模型调用；仅本地脚本提供商与测试专用 runtime home。原始日志和环境清单保留在 `.artifacts/post-beta2-plan/`，不包含在分发包。

| 检查 | 结果 |
| --- | --- |
| 默认回归 | **152 pass**：8 unit + 144 integration；另有 13 个原生/候选用例默认 skip |
| 故障套件 | **43 pass**，无 skip；新增 7 个用例各 3 个执行窗口，重复次数不当作独立覆盖 |
| 固定 CLI 原生套件 | **12 pass / 1 candidate skip**，本地提供商，无付费模型 |
| 候选 CLI 套件尝试 | **7 pass / 2 fail / 1 skip**；失败保留，原因见兼容表 |
| 候选独立范围切换 | **1 pass / 1 baseline skip**；与上述套件有重叠，不另算独立覆盖 |
| 类型 / 格式 / Skill 校验 | 通过 |
| 真实 Beta 2 Store 回退拒绝 | 通过；逻辑状态保持，不是 schema 降级 |

最终默认/故障日志为 `default-final.log` / `fault-final.log`。原生套件后针对任务图和正式 wrapper 的更改另做 CLI 复核，记录为 `native-scope-cli-final.log`（2 pass / 1 candidate skip）；历史套件结果不冒充所有未来修改均已验证。

## 剩余目标，未标为完成

1. P2：真实传输代理上的断连/重复/乱序，复杂并发状态机、历史缺页与 daemon/命令/存储组合故障；真实命令执行期间 Coordinator SIGKILL 的更多精确窗口；操作系统磁盘满、断电耐久性及一致备份恢复演练。
2. P3：团队运行环境清单的持久化与变更准入、候选 CLI 完整安装/动态工具/提供商资格、额外 Node/Git/macOS 环境。其他 OS 的沙箱、IPC、进程和凭据后端尚未实现，不能以跳过测试视为支持。
3. P4：慢 RPC 期间新到达工作、波次公平性和多树压力；依赖交付物协议、真实代码合并冲突/跨仓库部分集成；更多提醒误报/漏报校准。聚合统计仍可能扫描历史，尚无完整长运行性能保证。
4. P5：完整声明组合、升级回退与打包验收后，才决定下一 Beta 或稳定版。当前不发布，也不改写 Beta 2 资产。

## English summary

Implementation is in progress and unreleased. Schema 13 adds operator-only subtree scope replacement, stale-Turn authorization fences, explicit draining/ready progress, withdrawn Task diagnostics, reviewed-unknown command receipts and managed tool projection v2. Existing pauses, termination, identity and lifetime counts are preserved. Historical context and accepted external effects cannot be undone.

New tests cover transactional SIGKILL windows, command-effect/receipt boundaries, SQLite full/busy admission failures and local-provider HTTP negatives. Bounded preflight workers and SQL history paging are implemented, with controlled independence and 20-member historical fixtures. These do not prove arbitrary crash interleavings, power-loss durability or remote-provider behavior.

The newer CLI has partial adapter-layer evidence; its full-CLI attempts still fail the production version pin. No platform/version guard or sandbox was weakened. Additional operating systems, Node versions, persistent environment admission, full backup recovery and complex integration qualification remain open. Published Beta 2 assets are unchanged.
