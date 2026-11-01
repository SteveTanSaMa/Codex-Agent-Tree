# Environment preflight and runtime diagnosis / 环境预检与运行诊断

`node scripts/cat.mjs environment --state STATE` reports the configured workspace, registered read-only resources, named-test executable paths, loopback test network grants and synchronous command limits. To check additional tool paths, supply `--tools tools.json` with an array such as `[{"name":"ffmpeg","path":"/opt/homebrew/bin/ffmpeg"}]`. Paths must be absolute, with at most 32 entries. The command does not start executables, connect to services, test a model, or read provider credentials. It does not modify state or migrate the database.

`node scripts/cat.mjs environment --state STATE` 显示已配置的工作区、只读资源、命名测试可执行文件、测试的本地网络授权和同步命令限制。可使用 `--tools tools.json` 指定需要检查的绝对路径，例如 `[{"name":"ffmpeg","path":"/opt/homebrew/bin/ffmpeg"}]`，最多 32 项。该命令不执行程序、不连接服务、不调用模型，也不读取提供商凭据；不会修改状态或迁移数据库。

Path access checks describe the operator process on the host. They do **not** establish access inside the macOS sandbox, correct dynamic libraries, functioning network routes, or authenticated model availability. Existing `doctor` performs CLI protocol qualification; upgrade `preflight` checks backup/migration prerequisites. None of these reports guarantees that an end-to-end task will succeed.

The synchronous command timeout is 30 seconds. Newly created Lead Threads may use sandboxed background terminal commands with a 10-minute maximum; existing Threads retain their original tool catalog. A completed command does not itself wake an idle Lead. See [coding operations](../references/coding.md) for receipts and recovery.

路径权限结果仅反映宿主进程，不能证明沙箱内可访问、动态依赖完整、网络可达或模型认证有效。`doctor` 负责 CLI 协议能力检查，升级 `preflight` 负责备份和迁移条件；均不保证端到端任务成功。

同步命令超时为 30 秒；新建 Lead Thread 可以使用最多运行 10 分钟的沙箱后台命令，已有 Thread 保留原工具目录。命令完成不会自动唤醒空闲 Lead，收据与恢复说明见[编码操作](../references/coding.md)。

`diagnose` additionally lists up to 100 runtime blocks, unknown live-guidance receipts, recent failed/interrupted Attempts and Agents with recorded errors. These additions deliberately omit raw error contents; inspect the indicated database rows and paged audit history locally when needed. Raw historical errors can contain sensitive data. The existing unknown Attempt and command lists remain unchanged. The report does not establish whether a native Turn or external side effect happened and never retries one. Review native history and exact receipts before explicitly resolving uncertainty.

`diagnose` 增补最多各 100 项的 Runtime 阻断、未知引导回执、近期失败或中断的 Attempt 和存在错误记录的 Agent。新增结果不会直接显示原始错误正文；必要时在本机查看指示的数据库记录及分页审计历史，历史错误可能包含敏感数据。既有未知 Attempt 与命令列表保持兼容。诊断不能证明原生 Turn 或外部副作用是否发生，也不会自动重试；显式处理未知状态前应核查原生历史和准确回执。
