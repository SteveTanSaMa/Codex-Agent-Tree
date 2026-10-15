# 单 Agent / 多 Agent 可复现对照方案

状态：仅设计，未运行模型对照；不据此宣称团队更好或更省。现有递归算术验收只测控制平面。

## 固定变量

固定本项目 Git SHA、Node、精确 Codex CLI、解析后的模型/推理配置、同一凭据域与输入文件哈希；每次新 Root 使用独立状态与 Thread，初始化/安装排除在任务延迟之外。只读、禁用 shell/原生子 Agent。若无法证明实际模型配置相同，标记该对照不可比较。

三种拓扑：单节点（max-depth 0/max-agents 1）；平面（Root + 两名 worker，depth 1/agents 3）；递归（A→B→C，depth 2/agents 3）。均使用 observe、树级最多 12 Turns、每 Agent 最多 12 Turns、并行上限 3；单节点自然只能一个有效 Turn。相同用户目标、输入、输出 JSON schema 与评分规则，仅改变委派指令。单节点不得从其他实验读取结果。

## 任务集

| 类别 | 确定性构造与目标 | 评分 |
| --- | --- | --- |
| 小任务负对照 | 原文“六架，每架七包”，输出 `{total:42,unit:"packets"}` | 精确值与格式；观察固定编排开销，不预设赢家 |
| 可分区长文本 | Python `random.Random(20261015)` 顺序生成 120 条记录，字段 `id=R0000..R0119`、`region=A/B`（偶/奇）、`amount=randint(1,10000)`、`active=randint(0,1)`。以 JSONL 文件作为同一输入，提取两区 active 总额和各区最大 active 记录 ID；并列按最小 ID | Python 离线计算 gold；4 字段逐项计分及完整正确率。worker 可按区分工，Root 汇总；单节点完成相同字段 |
| 全局约束审查 | 同一组 20 条编号需求，预先固定 4 对显式矛盾与 4 条依赖；加入 100 条无冲突背景段，输出矛盾 ID 对与依赖遗漏 | 固定 gold 的 precision/recall；额外建议按盲评 rubric（证据、可执行性、遗漏）各 0–2，至少两名评分者独立评分 |

第二项生成顺序固定为每条先取 amount，再取 active；输入以 UTF-8、JSON `ensure_ascii=False`、紧凑 separators、每条 LF 保存，并同时保存输入 SHA-256 和 gold。第三项的数据和 gold 固定如下，不得看到结果后修改。所有任务正文加指令必须不超过当前 12000 UTF-16 code units 的输入上限；本方案不模拟项目尚不支持的仓库读取或超长文件导入。

先每种拓扑/任务做 1 次可行性检查，再由用户确认是否扩大到每格 10 次。顺序按固定 seed 随机化并交错，避免缓存、服务负载和模型时间漂移与某种拓扑绑定。超时/失败不删除，也不只统计成功样本。

## 观测与完成条件

- 延迟：从 root 接纳到收到符合要求的最终 Root 输出；另记首 Turn 启动、子节点启动、最后报告抵达与汇总延迟。用单调时钟，保留各阶段事件序列。
- 成功率/质量：外部 gold 校验为主；Task completed、消息 processed、Root idle 都不是评分结果。完成还需无必要子工作未决；若仍 unknown 则记不确定/失败，不强制清状态。
- tokens：按 Thread/binding 的原生累计高水位去重；缓存输入、未缓存输入、输出和推理字段分别记录，不把累计 tokens 换算成金额。实验中禁止人工用量结算；缺失最终数据标 unknown，避免 R3 污染比较。
- 人工成本：记录任务开始后的必要补充输入、重试决策、控制/恢复次数和人工分钟数，正常初始化/停机单列。
- 资源：峰值活 Turn、累计 Agent/Turn、工具调用次数、消息数、Task 操作数、重复读取相同正文的次数。

操作者只用 view/wait 观察，不代替团队推理、不自行解题、不在失败后偷偷改 prompt 或补答案。报告每格样本数、失败类型、成功率、质量分布、延迟中位数/p95、token 各分项及人工介入；样本小则明确不确定性。

## 需要回答的决策

长文本分区可能减少不相关上下文；独立评审可能提高覆盖率，但要用 gold 或盲评验证。强依赖任务和简单算术可能只有委派、回传及额外 Turn 的开销。递归应在子问题确实需要再次分工时使用；同层独立任务优先比较平面拓扑。Task Board 的价值应体现在遗漏/重复/人工恢复减少，不能只以工具调用成功计分。

只有收益落到上述指标后，再调整默认任务粒度、tool 输出或调度。当前没有对照数据，保留“未证明优势”的结论。

## 第三项固定约束材料

每条为 `id/key/value/enabled/requires`，默认 enabled=true、requires=[]。R01/R02 的 key=deadline、value=5/7；R03/R04 为 encrypt、true/false；R05/R06 为 region、CN/EU；R07/R08 为 replicas、2/4。key 的精确不同取值视为冲突，不做隐含逻辑推断。

R09/R10 分别 key=notify/auth；R11/R12 为 deploy/review；R13/R14 为 export/audit；R15/R16 为 backup/restore。它们 value=true；奇数条 requires 紧接的偶数 ID，偶数条 enabled=false。R17..R20 分别 key=metric1..metric4、value=true。背景 B001..B100 的文字固定为“背景编号 Bxxx：本段不新增约束。”。

Gold conflicts 为 `[R01,R02]、[R03,R04]、[R05,R06]、[R07,R08]`；unsatisfiedDependencies 为 `[R09,R10]、[R11,R12]、[R13,R14]、[R15,R16]`。输入明确要求只检查 enabled 需求，对缺少或 disabled 的依赖报未满足。输出 ID 对排序后精确比较；额外建议单列盲评，不用它弥补漏检。

复验数据生成、gold 和正文长度后再提交实验清单；原始输入、拓扑指令与 resolved model 必须各自留哈希。这里没有默认自动触发模型调用的 runner。
