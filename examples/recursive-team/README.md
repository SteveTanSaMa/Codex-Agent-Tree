# Recursive team

任务源见 [task.ts](task.ts)。它要求 A 实际调用 agent_spawn 创建 B，B 再实际创建 C；C 计算 7×6，发送结果给 B，B 和 A 分别由持久消息唤醒并确认处理。

已初始化并启动团队后，可执行：

```sh
npm run cat -- root --name A --key recursive-demo-1 --task "$(node -e 'import("./examples/recursive-team/task.ts").then(m=>process.stdout.write(m.recursiveTask))')" --wait-for-child
npm run cat -- tree
```

`--wait-for-child` 等实际创建首个子节点后退出 CLI；后台团队继续执行。重复演示请使用新 key；相同 key/内容复用原 root。CLI 返回的根 ID 可用于 status/events。

自动化的真实链路、独立 Thread、消息确认、准确 Turn 数与持久数据库检查：

```sh
CAT_TEST_REAL=1 node --test test/real/recursive-team.test.ts
CAT_TEST_REAL=1 node --test test/real/lifecycle.test.ts
```

第二项验证 Root CLI 退出发生在 B 创建 C 之前，并在 root 单节点暂停时保留消息，分别正常停止和 SIGKILL 业务 Coordinator，以及正常重启和 SIGKILL 专用原生 daemon，再恢复、确认消息、完成最终结果。强杀前核实目标属于本测试的隔离目录；这些测试不代表断电恢复或所有故障窗口覆盖。
