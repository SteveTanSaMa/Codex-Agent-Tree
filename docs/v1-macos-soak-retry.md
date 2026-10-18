# Soak retry authorization and quiescence correction / 复测授权与完成判定修复

2026-10-19。用户授权：北京时间 09:00 前允许失败后重新测试。09:00 作为再次启动的截止时间；已在窗口内启动的完整九小时测试可在其后结束。每次保留独立目录，不拼接运行时长，不重放旧团队，09:00 后不再新开测试。此前失败的完整记录保留在[首轮结果](v1-macos-soak-results.md)。

## 修复

- 将 harness 的两次独立队列/执行读取替换为单个 SQLite 语句，所有子查询处于一致读快照。
- 编码轮次增加因果完成屏障：三名指定成员本轮输入必须 processed 且其 Attempt completed；三份准确报告必须 processed，归属 Lead 的 completed Attempt；没有活动或未知执行、queued 消息、未完成 Task。然后仍严格检查两份集成文件的精确值，不用额外 sleep 掩盖错误。
- 初始组织创建也需明确等到四名编码成员及校准 Root 的 bootstrap Attempt 完成，再记录初始绑定并开始循环。
- 新增 `quiescence.mjs` 与 `fs-metrics.mjs` 随 runner/watchdog 一起冻结和哈希校验；新正式测试必须先通过匹配的五分钟 smoke。
- 启动器新增带时区的 `--retry-before`，过期时在创建任何测试路径前拒绝启动。该约束限制新的启动，不将少于八小时的片段改算为长期通过。

修改只针对测试组织代码，Runtime 与已发布 Beta 3 ZIP 不变；没有修改首轮冻结 harness、旧 release 或用户团队。

另外，缩时验证暴露了磁盘采样与 CLI 临时插件目录删除之间的竞态。采样现在仅跳过 ENOENT，不跟随符号链接；EACCES、EIO 等错误继续失败。两项确定性测试验证删除竞态与错误传播。失败目录 `smoke-20261019-015045` 保留，不计为通过。

## 验证

确定性测试复现旧行为：活动 Attempt 查询之后，队列被派发、消息转为 delivering；第二次 queued 查询为空，于是旧算法错误判断空闲。新快照检查返回 busy。

另一测试验证：表面空闲但少一份本轮报告时不能通过；报告对应的 Lead Attempt 尚在运行、Task 未完成或消费 unknown 时也不能通过。只有全部本轮因果证据齐备后才返回 ready。启动器过期授权测试确认 09:00 边界会被执行。

默认回归：171 通过、17 条件跳过；类型与格式检查通过。五分钟 smoke `smoke-20261019-015327` 完成 58 轮、1,922 次本地合成请求，三处恢复与历史对账通过，analysis=passed，watchdog exit=0、未触发强制截止。缩时结果不作为长期通过。

新的独立九小时运行 `nine-hour-20261019-015904` 于北京时间 2026-10-19 01:59 启动，预计 10:59 完成，watchdog 最晚约 11:14 清理。基线提交 `487bd91`，仍使用原始 Beta 3 安装包，全部四份冻结文件与通过的 smoke 哈希一致。运行状态尚待最终结果；15 分钟 heartbeat 已恢复，09:00 后不再启动新测试。所有失败原样保留，不将缩时测试、合成 token 或重试次数计为九小时通过。

## English

The user authorized corrected retries starting before 09:00 Asia/Shanghai on October 19. That is a new-start cutoff, not a truncation of an already running nine-hour test. Each retry uses a fresh state and retains prior evidence. After the cutoff, failures are analyzed and reported without starting another test.

The harness now checks quiescence in one SQLite snapshot and requires exact round inputs, reports, completed integration Attempts and Tasks before checking final file values. Bootstrap completion is explicit. A matching smoke is mandatory, and a timezone-aware launcher cutoff rejects expired authorization before touching test paths. Deterministic regressions cover the original race and incomplete causal evidence. Runtime and published Beta 3 assets remain unchanged.

The smoke also exposed a disk-sampling race against removal of CLI temporary plugin files. Sampling skips only ENOENT, never follows symlinks, and still fails on permission or I/O errors. Deterministic tests cover deletion and error propagation; the failed smoke evidence is retained.

Regression validation: 171 passed and 17 conditional skips; type and formatting checks passed. Smoke `smoke-20261019-015327` passed analysis with 58 rounds, 1,922 local synthetic requests, all three recovery checkpoints and native history reconciliation; watchdog exited zero without forced cleanup. Fresh nine-hour run `nine-hour-20261019-015904` started at 01:59 Asia/Shanghai, expected to finish at 10:59, with cleanup deadline around 11:14. Its four frozen harness hashes match the passing smoke. Final long-run outcome remains pending. Monitoring is active every 15 minutes; no new starts are authorized after 09:00.
