# v1.0.0 macOS qualification and nine-hour soak / 首个正式版与九小时测试

日期：2026-10-18。**首个正式版命名为 v1.0.0，暂只承诺 macOS。** 当前完整编码隔离证据为 macOS arm64；最低系统版本与其他 Mac 架构仍按实际矩阵声明。Linux/Windows 完整编码支持不再作为首个正式版的门槛；v0.1.0-beta.3 保持已发布状态，本次不提前发布正式版。

此前约 8,000 万与 1.2 亿 token 的真实任务是重要的真实负载证据，不因缺少专项资源采样而作废。本轮补充可测量的资源趋势、真实计时提醒和受控恢复，不再用付费模型重复生成海量上下文。任务质量和模型能力不属于本轮判断。

## 本轮方案

- 时长：**9 小时**；24 小时留待后续。正式启动前必须通过同一 runner/watchdog 哈希的 5 分钟缩时冒烟与清理验收。
- 被测对象：已发布 Beta 3 ZIP 的独立解压副本，32 个文件保持发布内容，CLI `0.163.0-alpha.10.2`，Node 26.3.1，macOS arm64；使用单独 state、runtime home 与合成 Git 仓库。不修改用户现有团队、凭据、原工程或全局 CLI。
- 提供商：仅回环地址的脚本化 Responses/SSE，伪凭据，不调用付费模型。协议和原生执行是真实的，生成内容与 token 用量是合成的；本轮不验证模型质量、真实账单或自动上下文压缩。为避免压缩调用改变脚本协议，测试配置显式提高上下文/压缩阈值；请求正文仍受 16 MiB 上限约束，触及即失败而不放宽。
- 两条独立负载，共 5 个成员、两个隔离 daemon：编码树 Lead → 两个 L2 coder，其中一个 → L3 reviewer；另一个独立 Root 专门校准提醒。编码树最多 3 个并行 Turn，校准树最多 1 个，均不限制累计 Turn。
- 编码树约每分钟一轮：两名 coder 读取、CAS 写入各自独立 worktree、执行白名单测试、ACK、报告；只读 reviewer 读取并报告；Lead 在原仓库整合、执行验证、显式领取和完成任务。重复使用成员，持续积累历史；不无界 spawn。
- 编码树保留默认全树 500 万 token 提醒。校准树使用每 20 个合成 token 的增量提醒，仅检验持久触发机制，不能换算为真实用量或成本。

| 阶段 | 真实时间行为与验收 |
| --- | --- |
| 启动与持续循环 | 独立安装、原生递归创建 4 成员；编码循环覆盖文件权限、工具、报告和整合。对每轮检查文件值、Task 显式完成、无未知执行或重复认领 |
| 校准：无活动 | 保持原生 Turn 16 分钟，用协议心跳保持连接，不产生选定的业务进展；默认 10 分钟停滞、15 分钟自主提醒各出现一次，不自动暂停；检查秒级 guard 容差 |
| 校准：持续进展 | 16 分钟，每分钟创建一个合成 Task 作为已定义的可观测活动；有 15 分钟自主提醒，无停滞提醒。正常静默计算的告警是观测提示，不能解释为业务失败 |
| 交互与暂停 | 对运行中的 Turn 实时 steer，重试同 key 验证稳定消息/Turn 身份；消费状态允许自然前进。立即暂停后验证 interrupted，resume 不重放 |
| 第 2 / 5 / 8 小时 | 仅 SIGKILL 校准树 Coordinator，原生 Turn 和本地提供商保持；新宿主恢复同一业务 Attempt 与 Native Turn，完成后检查状态，无重放 |
| 收尾 | 两树排空，业务/原生历史逐项对照；绑定保持，完整性/FK 无错误；停止测试专属 Coordinator 和 daemon，防休眠进程随 watchdog 退出；保留原始证据 |

## 采样与判定

每 30 秒记录：Coordinator/native RSS、数字文件描述符数量、相关进程数量、队列与执行状态、请求/业务轮次统计；磁盘目录大小每两分钟测量。定期测量操作者 view 延迟。所有时间戳为 UTC，用户进度与预计结束时间按 Asia/Shanghai 展示。

完成时用 `scripts/soak/analyze.py` 比较同一 PID 热身后 30–60 分钟窗口与最后 30 分钟的 RSS/FD 中位数。RSS 增长超过 `初始×1.5 + 64 MiB` 或 FD 增加超过 32，列为需要审查，不直接断言泄漏。正常数据库/日志增长不当作内存泄漏。计划内 Coordinator 更换 PID 分段统计，不能用重启隐藏编码树或 native daemon 的增长。

采样间隔大于 90 秒、时长不足、缺检查点、未完成清理或断言失败均不能记为通过；缩时测试使用单独的短时容差，**不能冒充 9 小时结果**。最终资源旗标只决定需要审查，不强行调整阈值凑通过。绝对资源保护：每个被采样 Coordinator/native RSS 小于 2 GiB，测试目录小于 4 GiB，60,000 次提供商请求、16 MiB 单请求正文上限；启动前至少有 8 GiB 可用磁盘。

独立 Python watchdog 拥有 runner PID 和路径清单，硬截止为正式时长加 15 分钟清理余量。runner 死亡、超时或测试失败后，仅清理清单中的专属 home/state；不自动重跑、不热升级基线、不执行 24 小时任务。`caffeinate -i` 临时防止空闲睡眠，退出后解除；合盖、关机或主动睡眠造成的观测缺口仍会被标记。

## 运行与证据

```sh
python3 scripts/soak/launch.py --smoke --skill /absolute/installed/skill --executable /absolute/codex
# 仅在同一 runner/watchdog 的 smoke 和清理通过后启动：
python3 scripts/soak/launch.py --hours 9 --skill /absolute/installed/skill --executable /absolute/codex
python3 scripts/soak/analyze.py /absolute/run-directory
```

启动清单位于 `.artifacts/soak/active.json`，目录中包含冻结的 harness 副本、启动清单、ownership、status、events、metrics、result 和 watchdog-result。正式 test home/repo 使用随机的短 `/tmp/cat-soak-*` 路径以满足 Unix socket 长度限制。原始状态和请求内容不进入 Git 或发布 ZIP；日志只保留合成工作及必要指标，源代码提交与 harness SHA-256 另行记录。

用户已授权本轮 8–10 小时测试。通过线程 heartbeat 定期只读检查文件；状态正常时不打扰，失败、需要干预或完成时报告。最终以 result + watchdog-result + analysis 为准，不能仅凭进程仍存活宣布通过。

## English

v1.0.0 will initially support macOS only; Linux/Windows coding isolation is not a gate for that release. Existing large real-world runs remain valid evidence. This nine-hour soak supplements them with measured resource trends, real 10/15-minute warning timing, interactive control and three controlled Coordinator crashes. It runs the published Beta 3 payload against synthetic loopback Responses, with four coding members plus an isolated calibration Root, no paid models or existing-team changes. A matching five-minute smoke must pass first. Duration, sampling gaps, native/business identities, task/file outcomes, cleanup and resource-review flags are evaluated separately. This run does not qualify real model quality, compaction, billing, every Mac version or a future 24-hour soak.
