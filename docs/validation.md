# 验证范围

已验证：macOS arm64，Node 26.3.1，`codex-cli 0.162.0-alpha.17.2`，单文件型登录、只读任务。兼容性依赖实验性 App Server API，版本不匹配拒绝连接。

| 命令 | 验证对象 | 模型调用 |
| --- | --- | --- |
| `npm test` | 输入授权、transport、SQLite、预算、消息、fence、CLI、Skill 包 | 无 |
| `npm run test:fault` | 替身 Runtime 的丢回复/恢复/旧 generation；实际存储进程崩溃 | 无 |
| `npm run test:native` | 专用官方 daemon、多 Thread/连接、独立 CLI、空上下文恢复 | 无 |
| `npm run test:real` | 真实递归、消息回报、独立 Session、退出续跑、重启、中断 | 有 |

真实模型用例覆盖 A→B→C→B→A（3 Threads、5 Turns、两条 processed 回执）；B 运行时 Root CLI 退出、B 随后创建 C；Coordinator 与专用原生 daemon 正常重启/SIGKILL 后恢复暂停和待处理消息；真实接纳后注入调用方回复/订阅丢失，采用原 Turn 而不重发；真实 cancel/terminate。

替身故障与真实进程/模型严格区分；明确注入窗口不等于断电或所有故障证明。真实测试输出本轮证据到 `.artifacts/evidence/`；原研究探针、认证、临时日志和历史证据不分发。

首版为 alpha 预发布：可安装并完成限定工作流，仍固定实验性版本。未验证 Linux/Windows、多凭据、工作树写代码或外部副作用恢复。未知用量可能需人工核实，无证据时保留 unknown。没有团队质量/成本优于单 Agent 的对照结论。

分发 ZIP 从文件白名单生成，只含 Skill 指令、运行入口、源码、依赖锁和许可；不含 node_modules、数据库、认证、生成日志。安装后从任意工作目录执行 `setup`、`doctor` 再启动。仓库另保留回归测试、一个递归示例及必要文档。

## 2026-10-15 发布前复验

共 61 项通过：默认 35、故障 18、原生 3、真实模型 5（含独立 Codex 从已解压 ZIP 读取 Skill、创建三节点团队并取回结果）。仅导出 Git 提交文件的干净目录也通过 npm ci、类型检查、默认/故障测试及格式检查。Skill 元数据校验通过，18 文件 ZIP 重复生成的 SHA-256 一致。测试输出与认证均不提交；测试代码可供复验。
