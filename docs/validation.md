# 最新：Beta 2 验收

本次发布的验证范围和结果见 [Beta 2 验收](beta-2-validation.md)；下方保留历史记录。

# 历史：Beta 1 验收

Beta 新增的编码、沙箱、命令收据、FIFO、用量回执和实际模型流程见 [Beta 验收记录](beta-validation.md)。以下保留 Alpha 各轮验证的历史事实，不代表 Beta 当前范围。

# 验证范围

已验证：macOS arm64，Node 26.3.1，`codex-cli 0.162.0-alpha.17.2`，文件型登录及下文限定的第三方凭据接入、只读任务。兼容性依赖实验性 App Server API，版本不匹配拒绝连接。

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

推送后另验证了从 GitHub 普通 clone，以及 skill-installer 的 download 安装；两者在仓库外执行 setup/doctor 均通过。测试机 Python 缺失默认 CA 路径，download 复验时为该进程指定系统 CA，保持 TLS 验证。安装器 Git 模式的根目录稀疏检出会遗漏子目录，因此不推荐该组合；普通 git clone 不受影响。

## 首轮审查后复验（0.1.0-alpha.2）

共 67 项通过：默认 38（单元 8、集成 30）、故障 21、原生 3、真实模型 5。新增 6 项测试覆盖消息编码、超限存量行的可查询失败与后续投递、消息消费不等于子任务完成、预算超限、连续空历史重启与完成/恢复并发。类型、格式与 Skill 元数据检查通过。

同一批处理回归在 `1a5c579` 基线对注入的超限历史行失败，在当前实现通过；正常公开输入下仍未复现该 P1。真实安装测试使用了本轮所有已修改生产模块的最终源码。结论、修复及不变量边界见 [首轮审查处理](review-round-1.md)。

## Task 协作与事件等待复验（0.1.0-alpha.3）

共 81 个不同用例通过：默认 50（单元 8、集成 42；另跳过 4 个原生用例）、故障 22、原生 4、真实模型 5。新增 14 个用例覆盖 Task CAS/幂等/依赖/授权、schema 4→5 迁移、已预留 Turn 的预算诊断、事件分页/取消/重启，以及 Task 事务中实际 SIGKILL 后的完整回滚。类型、格式和 Skill 元数据检查通过。

真实模型复验分两次取得最终通过结果：四个既有执行/恢复用例在全量命令中通过；安装用例最初因默认 200000-token 池耗尽而未取得 A 汇总，该次命令为 4 通过、1 失败。随后仅对修改了预算配置的安装用例独立复验通过，没有重跑其他已通过用例或绕过原树预算。

最终安装验收由独立 Codex 读取解压后的 Skill，真实调用 Task create/get/update，创建 A→B→C 的三个独立 Thread；C 领取并完成计算，B 读取结果后领取并完成依赖验证，报告返回 C→B→A 且回执 processed。操作者实际调用 CLI view/wait，A 最后汇总 42。两个 Task 均为 completed，owner 分别为 C、B。预先配置 600000-token 池（B 300000，C 从 B 分配 120000），原生累计用量 367337、预留 0、超额责任 0；累计用量包含缓存输入，不能直接换算成账单。

最终 ZIP 的全部 20 个文件与真实安装验收所用文件逐字节一致。从 Git 暂存区导出的干净源码目录另通过 npm ci、类型、格式、默认和故障测试，生成 ZIP 的 SHA-256 与工作区一致。仓库新增英文 README 并校验相对链接。仍无结果质量/总成本优于单 Agent 的对照结论。

## 执行限制与 token 观测复验（0.1.0-alpha.4）

新团队默认 observe；旧树缺省按 enforce 读取。schema 6 防止旧实现误读新策略。深度、累计成员、并发和每节点 Turn 继续硬限制，另加树级累计 Turn（默认 100）。次数在准备事务中占用，失败、中断和取消不退还，重启不重置。

新增 8 个集成用例与 1 个恢复故障用例，覆盖低阈值继续执行、无子 token 分配、实际用量告警去重、enforce 准入、结构和每节点/树级执行界限、未知执行槽位、未知用量观测、旧 schema 5 树及幂等操作的恢复。既有预算测试显式选择 enforce，继续验证原协议；不会用默认策略变化掩盖旧功能回归。原生 CLI 用例另验证无效策略/次数拒绝，以及重启保留 observe 与自定义上限。

真实安装验收使用 observe 默认值、100-token 告警阈值、最多 3 个 Agent 和 10 个树级 Turn；A/B 省略子 token 分配。累计原生用量超过阈值后，仍完成 calculation → verification 两项 Task，回报 C→B→A 并取回 42。观测总量 310802（含缓存输入，不代表账单），实际 3 个 Thread、5 个 Turn，剩余 5 个树级 Turn。全部 20 个 ZIP 文件与真实安装验收输入和最终源码逐字节一致。

本轮共 90 项通过：默认 58（单元 8、集成 50）、故障 23、原生 4、真实模型 5；真实模型全量命令为 5 通过、0 失败。类型、格式、Skill 元数据及文档相对链接检查通过。Git 暂存区导出的干净目录通过独立 npm ci、类型、格式、默认及故障测试，并生成相同 SHA-256 的 20 文件 Skill ZIP。

## 2026-10-16 架构审查

本轮针对当前源码执行默认 59、故障 26、原生 4、真实单 Turn 丢回复 1，共 90 项通过；另外四个真实模型用例未重跑。修复外来 started 事件误认领、控制通道 UTF-8 跨块损坏，并将事件查找改用已有唯一索引。另有一个稳定失败的独立账本诊断：人工收据后缺失最终原生样本，下一 Turn 累计量会重复计入差额（95 != 75）。未清除或隐藏该问题，未发布新 Release。完整边界、复现命令及未实施原因见 [架构审查](review-architecture.md)。

## 2026-10-16 第三方模型小范围真实验证

本机终端的 `codex` 是 shell 函数：配置使用独立的 `~/.codex-cli`，实际执行文件仍来自 ChatGPT.app，版本为 `codex-cli 0.162.0-alpha.17.2`，并非另装的二进制。配置模型为 `deepseek/deepseek-v4.1-flash`，经 Command Code 的 Responses 接口调用；凭据来自 macOS 钥匙串。模型名称来自配置，不构成对供应商底层路由的独立证明。

本轮复制该配置到临时专用 CODEX_HOME，未复制 App 的 auth.json。两项真实测试通过：

- 无工具 CLI 调用：约 8.73 秒返回 `PROVIDER_PROBE_OK 42`；报告 input 6667（其中 cached input 4096）、output 41 tokens。
- 当前源码 Coordinator + 官方专用 daemon：约 46.29 秒完成 A 创建 B、B 发送 `CHILD_RESULT 42`、消息触发 A 的后续 Turn、A 确认并返回 `TREE_PROVIDER_OK 42`。两个独立 Thread、三个 completed Turn，回执 processed，诊断无错误。observe 模式配置最多两名成员、深度 1、并发 2、树级三次 Turn；100-token 告警阈值不会阻断执行。原生观测总量 62630（含缓存输入，不代表账单）。

接入仍有明确缺口：当前 `runtimeEnvironment` 仅传递基础环境与代理/CA 设置，不传递 provider 的 API key 环境变量；现有 init/真实测试夹具也以文件型 auth.json 为前提。本轮通过临时可执行包装器从钥匙串读取凭据并启动 Codex，显式传给 `CodexRuntime.executable`，没有修改生产适配器、放宽环境过滤或把密钥写入配置。因此结论是该配置下的模型调用与父子协作链路可行，尚不能宣称默认 Skill 安装流程已支持这种认证方式。

原隔离配置的 SHA-256 在基础测试前后相同；两个测试均在临时 home 中运行。团队测试的专用 daemon 已停止，临时 home/包装器已删除，脱敏结果和临时验证脚本仅保留于被 Git 忽略的 `.artifacts/`。本轮未验证第三层递归、第三方模型下的故障恢复、Task DAG、代码修改或完整安装验收，也未做单/多 Agent 成本对照。未发布新 Release。


## 2026-10-16 已知问题修复复验（main，尚未发布）

修复 R3：schema 7 分开保存原生累计样本、人工收据和直接下界，按 Turn 顺序核算覆盖关系。原 95/75 诊断现通过；收据晚于后续 Turn、多个缺口、迟到和重复通知均有回归。schema 6 的旧多计记录迁移后为 75，重启保持；缺证据的旧记录保留下界与 unknown，人工收据不会变成伪造的原生观测。矛盾证据事务回滚，另验证旧库迁移失败时 schema、owner 与金额整体回滚。合同和升级边界见[用量证据与核算](usage-reconciliation.md)。

修复第三方接入：`init --config-from --provider-env [--keychain-service] --executable`，`doctor --state` 使用团队选择的二进制；适配器只传递显式指定的凭据，不再依赖临时包装器。默认 App auth.json 复制不再发生于选择自定义 config 的初始化流程；文件型登录原路径继续保留。新增配置复制、禁止覆盖、无密钥持久化、环境过滤及缺凭据拒绝测试。

本轮共 **102 个不同正常用例通过**：默认 70（单元 8、集成 62）、故障 26、原生 4、真实模型 2。类型、格式、Skill 元数据及打包白名单检查通过。原独立 usage-gap 诊断也通过，未计入正常用例数量；未重跑另外四个原有真实模型用例。

真实模型包括原生接纳后丢回复恢复，以及新增可复验的 `test/real/provider-cli.test.ts`。第三方用例经正式 CLI init/doctor/start 创建两个独立 Thread，三个 Turn 全部 completed，父节点返回 `FIXED_PROVIDER_OK 42`、回执 processed、树级 reserved 为 0；不依赖临时凭据包装器。模型仍为配置声明的 `deepseek/deepseek-v4.1-flash` / Command Code。原配置逐字节未变，专用 daemon 已停止、测试目录已删除；测试证据仅在忽略目录 `.artifacts/evidence/`。未做模型质量或成本对照。

可用显式的 CAT_TEST_PROVIDER_REAL=1、CAT_PROVIDER_CONFIG、CAT_PROVIDER_ENV、CAT_PROVIDER_EXECUTABLE 和可选 CAT_PROVIDER_KEYCHAIN_SERVICE 复验该用例；这些变量是配置路径、变量名、二进制路径和服务名，不能填密钥本身。未启用时该第三方用例跳过，不会隐式使用 App 登录。

本轮源码修复尚未发布 Release，alpha.4 ZIP 不包含它们。现有团队升级前停止并备份 state；schema 7 回退需恢复匹配备份。没有修改用户现有团队数据库或 Codex App 配置。
