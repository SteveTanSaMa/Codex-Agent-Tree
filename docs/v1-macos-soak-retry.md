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

## 第二轮提前停止 / Second early stop

`nine-hour-20261019-015904` 于北京时间 04:07:22 停止，运行 2 小时 8 分 17 秒、进入第 129 轮、3,640 次本地请求。两小时强杀恢复通过，但未到五/八小时和最终历史对账。watchdog exit=1、forcedDeadline=false，清理结束于 04:07:23。analysis=review-required，不是九小时通过。

只读数据库确认编码树恰有 256 个任务。现有 Runtime 限制最多 256 个未删除任务；测试器每次整合创建新任务且从不删除，达到上限后创建被拒绝，随后查询新任务的断言失败。修复仅在每轮因果屏障和精确文件检查通过后，经 CLI 的 CAS task-update delete 清理 completed 任务，并确认删除已持久化；保留数据库历史与事件，不修改上限，不清理未完成任务。屏障允许历史 deleted 任务，不改变消息及 Attempt 完成要求。回归覆盖 300 次 create→claim→complete→delete 生命周期，超过原失败阈值。

The second full run stopped after 2h 8m 17s with 3,640 local requests while entering round 129. Its two-hour recovery passed; five/eight-hour checkpoints and final history reconciliation were not reached. Watchdog cleanup finished normally with runner exit 1; analysis requires review. The coding tree had exactly 256 tasks: the harness never deleted completed tasks and hit the existing live-task cap. After successful causal and exact file checks, the corrected harness archives only completed tasks using the normal CAS CLI delete action and verifies persistence. The cap and Runtime remain unchanged, with all audit history retained. A 300-lifecycle regression crosses the original failure threshold. A fresh matching smoke is required before another independent full run.


### 修复后的独立复测 / Independent retry after task archival correction

默认回归 172 通过、17 条件跳过，类型和格式检查通过。匹配 smoke `smoke-20261019-041555`：58 轮、1,916 次本地请求，三处恢复与历史对账通过，analysis=passed、flags=[]，watchdog exit=0、forcedDeadline=false。新运行 `nine-hour-20261019-042138` 于北京时间 04:21:38 启动，预计 13:21:39 完成，最晚约 13:36:39 清理；源提交 `c704fca`，冻结哈希匹配，Runtime 仍为原 Beta 3。最终长期结果待定，heartbeat 通过 active.json 跟踪本次运行，09:00 新启动截止保持不变。

Default regression: 172 passed, 17 conditional skips; type and formatting checks passed. Matching smoke `smoke-20261019-041555` passed 58 rounds and 1,916 local requests, three recoveries and history reconciliation, analysis with no flags, and watchdog cleanup with exit zero and no forced deadline. Independent full run `nine-hour-20261019-042138` started at 04:21:38 Asia/Shanghai, expected to finish at 13:21:39 with cleanup by approximately 13:36:39. Source commit is `c704fca`; frozen hashes match and Runtime remains published Beta 3. Final long-run outcome is pending. Monitoring follows active.json; the 09:00 new-start cutoff still applies.


## 第三轮提前停止 / Third early stop

`nine-hour-20261019-042138` 于北京时间 07:13:56 提前停止，约 2 小时 52 分 18 秒，进入第 173 轮、4,880 次本地请求。watchdog exit=1、forcedDeadline=false，analysis=review-required，不计长期通过。一次 reviewer read_file 返回 STATE_BLOCKED：reviewer 继承 coderA 的工作区，在 coder 测试命令持锁期间读取被正常拒绝。固定合成计划不会像模型一样根据拒绝调整行为；不能因此忽略工具拒绝。修复为两名 coder 保持并发，本轮输入 processed 且对应 Attempt completed 后才派发 reviewer。新增确定性测试覆盖运行中、消息未处理、已完成及错误轮次四种条件。旧冻结脚本、工作区锁和 Runtime 均不变。

The third run stopped early after about 2h 52m 18s while entering round 173, with 4,880 local requests. Watchdog cleanup completed without a forced deadline; analysis requires review. A reviewer read correctly received STATE_BLOCKED while its inherited coder workspace was locked by a test command. The scripted provider did not adapt to that rejection. The corrected workload keeps both coders concurrent but dispatches the shared-workspace reviewer only after both exact round inputs and their Attempts complete. Deterministic tests cover running, unprocessed, completed and wrong-round evidence. Unexpected rejections still fail the run; Runtime and workspace locks are unchanged.
