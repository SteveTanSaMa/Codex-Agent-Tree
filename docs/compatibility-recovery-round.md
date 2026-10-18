# Compatibility, recovery and integration round / 兼容、恢复与整合轮次

基线：`baa8626`，schema 13。状态：已执行，见[结果与剩余限制](compatibility-recovery-results.md)。本轮以**取消精确 Codex CLI 版本锁**为必要交付，不以扩大一个版本白名单代替。

## 交付顺序与验收

| 阶段 | 实施与测试 | 通过条件 |
| --- | --- | --- |
| C1 能力准入 | 移除 init、doctor、adapter 的固定版本比较；旧 expectedVersion 退为忽略的兼容字段；临时无凭据 home 导出实验协议、检查使用到的方法/字段/状态 | 任意版本号、能力相同可通过；缺必需字段或新增无法提供的必填输入明确拒绝；schema 哈希变化不自动拒绝；无 skip/警告旁路 |
| C2 原生跨版本 | `0.162.0-alpha.17.2` 与 `0.163.0-alpha.10.2` 各跑完整正式 CLI、Thread/Turn、动态工具、引导、故障与重启链路 | 版本检查不再导致失败；实际动态工具回调和业务/原生 ID 对账通过。仅启动、仅声明 schema 不算行为验证 |
| C3 跨环境 | GitHub Actions：macOS 15、Ubuntu 24.04 x64/arm64、Windows 2022；Node 最低 26.3.1 与 26.x 跟踪线 | 精确解析后的 Node/OS/CPU 保留在日志；macOS 完整默认/故障套件，Linux 纯协议与存储层，Windows 纯协议层分别计数；后两者不能宣称编码沙箱已支持 |
| R1 传输与执行恢复 | 实际代理丢 turn/start ACK / 断连；迟到/重复通知；真实宿主在命令效果与收据之间退出；多次恢复 | 每 Agent 至多一个有效 Native Turn；已接受工作不自动重放；效果计数、命令收据、scope 与原生历史一致或明确 unknown |
| R2 状态与备份 | 中断范围替换、迁移/WAL 一致备份恢复；已接受工作与恢复副本不得双跑 | 不复制活跃 SQLite 主文件冒充备份；恢复过程保留绑定、累计计数、未知结果和限制；不降级 schema |
| I1 多仓库整合 | 两独立仓库、两个同库 sibling 冲突、第三层只读审核；上游基线改变、陈旧 CAS、部分集成失败、恢复后重试 | 留存 base/head/diff/hash 与实际测试收据；陈旧成果不可覆盖新文件；部分成功不当作整体完成；无自动跨库原子提交承诺 |
| I2 调度与规模 | 慢 RPC 期间新到达任务、3 个预检 worker、20 成员历史与大结果 | 不越过事务准入；新工作等待与波次限制有测量；输出限额保留截断标记和总数量 |
| D 收尾 | 双语使用说明、兼容矩阵、可复现测试入口和结果；提交/推送 | 生产路径无精确版本白名单；所有新失败明确处理或限定；不可用平台不算 pass；不改写 Beta 2 tag/资产 |

## 准入原则

版本号、完整协议指纹与运行环境作为审计信息持久化，不作为固定发行号的门槛。新增可选字段可接受，必需身份/状态/请求关联和权限字段不能猜测。能力探针在独立临时 home 中进行，不使用真实凭据、不创建模型 Turn；原生行为测试使用本地脚本提供商。

启动器与正在运行的 daemon 身份仍须一致，避免对运行中任务静默切换二进制。这是本次连接的一致性检查，不是固定版本锁。遇到旧 daemon 仍工作时，先结算/隔离它，不能杀掉它或重放任务来满足升级。

Node 的最低 API 要求、数据库 schema 拒绝降级和沙箱能力要求仍存在；“无 CLI 版本锁”不等于所有 OS 和所有 Node 版本均支持。Linux/Windows 的通用 terminal 不作为缺少隔离后端的替代。

## 实验边界

默认与故障/协议测试不调用付费模型。不复用或热升级既有真实团队；最多 3 个并行 CI job，每 job 10 分钟截止。每个精确崩溃窗口重复 3 次，重复执行不算新增独立覆盖；超出成本/时间边界先停测试并保留证据，不自动创建真实团队重试。物理断电、恶意仓库全面隔离、任意远程提供商和跨库原子提交不作为本轮承诺。

runner 标签与 Node 安装机制依据 [GitHub runner 文档](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)和 [setup-node](https://github.com/actions/setup-node)。CI action 固定到检查过的提交；Node 跟踪线在日志记录实际解析版本，不把将来的所有 26.x 版本预先列为已验证。

## English summary

This round must remove the exact Codex CLI release pin from production paths. Admission uses required protocol contracts rather than a version/hash allowlist; versions and environment manifests remain audit evidence. Missing capabilities fail with actionable diagnostics, while additive schemas can pass. Launcher/daemon consistency, state schema safety and sandbox requirements remain enforced.

Test both retained CLI binaries through the full CLI path, actual callbacks and recovery. Run layered OS/Node CI, then transport/side-effect/backup fault windows and deterministic multi-repository conflict/integration scenarios. CI skips or portable-only passes do not qualify unsupported coding platforms. No paid model, existing-team hot upgrade or new release is part of this round.
