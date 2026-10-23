# Turbo ON/OFF 性能报告（Phase 3）

**结论：在本次测得的任务集上，Turbo ON 没有带来可重复的端到端加速。两轮对冲测量的符号相反，任务级方差远大于策略差异。本插件不承诺加速倍数，也不把"回复更短"当作加速证据。**

本文件只报告实测数据与局限。原始记录：`benchmark/results-*.json`、`benchmark/run-log*.txt`、
`~/.dsh/storages/dsh-turbo-bench-{turbo,default}/evidence.jsonl`（每步策略证据）。

另有一组用户界面的同题单次对照（见 §4.2）出现明显正向结果。它作为试点证据单独列出，不能推翻上面的
多任务结论，也不能外推成对所有任务的承诺。

---

## 1. 方法

| 项 | 做法 |
|---|---|
| 运行时 | 与 GUI 完全相同的 DSH `0.2.0-rc.2`（桌面版内置 CLI 启动） |
| 接口 | headless one-shot：`dsh --profile turbo-bench --json "<task>"` |
| Profile | `turbo-bench` = `dsh-base` + `dsh-headless` + `dsh-turbo`（无 Web 面，排除 UI 干扰） |
| 模型 | `deepseek-official/deepseek-flash`，`reasoningEffort: high`，两臂一致 |
| 两臂唯一差异 | `dsh-turbo.config.defaultMode` = `turbo` / `default`，由 `--patch` 覆盖层注入 |
| 环境 | `DSH_PERMISSION_MODE=danger-full-access`（避免无人值守时审批阻塞） |
| 隔离 | 每个任务每次运行使用**全新工作目录**，按 `seed` 写入相同初始字节 |
| 交错 | 每个任务两臂交替执行，奇数任务交换先后顺序，抵消预热与时段漂移 |
| 验收 | 每个任务附 Node 断言（`benchmark/tasks.json` 的 `check`），跑不通即失败，不看模型自述 |
| 指标来源 | 运行器事件流（`--json`：`status/step_start`、`tool_call`、`usage`）+ 进程墙钟 |
| 传输故障 | `dsh: TRANSPORT: …` 或 `turn_end.kind === 'error'` 视为网络故障，重试 3 次后标记 `excluded` 并不计入统计 |

指标口径：**Total Latency** = 进程启动到退出的墙钟（含约 1–2 s 的 DSH 启动，对两臂等量稀释）；
**First Token** = 第一条非空 `text/thinking` 事件到达时间（按 stdout 分块时间戳）；
**Steps/Tool Calls** = 事件计数；**Success** = Node 断言通过。

---

## 2. 第一轮（提示词 v1）

执行到第 9 个任务后，模型服务连续返回 `TRANSPORT: DeepSeek Messages transport failed`，
其后的 11 个任务两臂均失败（`steps=1, tools=0, pass=n`），**属于环境故障，已排除**。
有效样本 = 9 个任务 × 2 臂。

| arm | 有效 runs | 通过 | 中位耗时 | 均值 | 平均 steps |
|---|---|---|---|---|---|
| turbo (v1) | 9 | **7/9** | 28 952 ms | 50 772 ms | 13 |
| default | 9 | **9/9** | 44 636 ms | 53 405 ms | 15 |

逐任务（ms）：

| task | turbo | default | turbo 通过 |
|---|---|---|---|
| sum-js | 24 827 | 25 985 | ✓ |
| fizzbuzz-js | 28 952 | 44 106 | ✓ |
| fix-offbyone | 24 971 | 98 228 | ✗ |
| parse-json | 49 225 | 34 703 | ✓ |
| slug-js | 39 705 | 53 872 | ✓ |
| count-lines | 88 858 | 44 636 | ✓ |
| dedupe-js | 14 006 | 29 589 | ✓ |
| clamp-js | 6 449 | 81 734 | ✗ |
| fix-async | 179 957 | 67 795 | ✓ |

**读法**：中位数看 turbo 快 35%，但两处"特别快"的样本正是失败样本
（`fix-offbyone` 24.9 s / 8 步、`clamp-js` 6.4 s / 3 步都没跑必要的验证），
成功率高的是 default。这是"用质量换速度"，不是加速。

---

## 3. 第二轮（提示词 v2：加入"最便宜的一次证明" + `Verified:` 披露行）

第一轮暴露问题后修改策略：把"完成前跑一条最便宜的、能抓住错误结果的命令"写成硬要求，
并要求回复以 `Verified: <命令>` 或 `Verified: none` 结尾。随后对全部 20 个任务重测
（最后 1 次 default 运行因采样进程被中断，缺 1 个样本）。

| arm | runs | 通过 | 中位 | 均值 | P90 | 平均 steps | 平均 tool calls | min–max |
|---|---|---|---|---|---|---|---|---|
| turbo (v2) | 20 | **19/20** | 33 638 ms | 38 287 ms | 56 699 ms | 14 | 13 | 20.7–74.9 s |
| default | 19 | **18/19** | 29 980 ms | 40 560 ms | 83 772 ms | 12 | 13 | 9.4–182.0 s |

逐任务（ms，✓/✗ 为断言结果）：

| task | turbo | default | Δ(turbo−default) | steps t/d | pass t/d |
|---|---|---|---|---|---|
| sum-js | 47 184 | 21 686 | +117.6% | 16/8 | ✓/✓ |
| fizzbuzz-js | 35 478 | 27 283 | +30.0% | 13/9 | **✗**/✓ |
| fix-offbyone | 74 909 | 34 614 | +116.4% | 24/15 | ✓/**✗** |
| parse-json | 39 233 | 181 958 | −78.4% | 15/14 | ✓/✓ |
| slug-js | 32 902 | 34 801 | −5.5% | 11/12 | ✓/✓ |
| count-lines | 56 839 | 23 216 | +144.8% | 21/11 | ✓/✓ |
| dedupe-js | 22 717 | 24 348 | −6.7% | 9/8 | ✓/✓ |
| clamp-js | 23 384 | 27 729 | −15.7% | 9/12 | ✓/✓ |
| fix-async | 56 699 | 83 772 | −32.3% | 24/26 | ✓/✓ |
| word-count | 20 744 | 32 557 | −36.3% | 8/12 | ✓/✓ |
| truncate-js | 38 906 | 28 270 | +37.6% | 13/9 | ✓/✓ |
| group-by | 56 494 | 31 266 | +80.7% | 19/14 | ✓/✓ |
| retry-js | 33 638 | 9 422 | +257.0% | 12/4 | ✓/✓ |
| csv-line | 24 916 | 21 302 | +17.0% | 10/9 | ✓/✓ |
| fix-import | 43 384 | 72 250 | −40.0% | 14/25 | ✓/✓ |
| binary-search | 42 119 | 21 396 | +96.9% | 13/9 | ✓/✓ |
| deep-equal-lite | 31 738 | 29 980 | +5.9% | 9/10 | ✓/✓ |
| format-bytes | 33 112 | 31 929 | +3.7% | 10/9 | ✓/✓ |
| todo-list | 21 777 | 32 867 | −33.7% | 8/11 | ✓/✓ |
| read-and-report | 29 570 | —（缺样本） | n/a | 13/— | ✓/— |

**读法**

1. 成功率回归被修好了：v1 的 2 个 turbo 失败（`fix-offbyone`, `clamp-js`）在 v2 全部通过。
2. 代价是步数：v2 的 turbo 平均 14 步 vs default 12 步——"最便宜的一次证明"确实被执行了。
3. 端到端：中位数 turbo **慢 12%**，均值 turbo 快 6%，**P90 turbo 快 32%**（default 被一个 182 s 的离群样本拖长）。
4. 任务级差异从 −78% 到 +257%，同一策略在不同任务上完全反向 → **方差主导，不能宣称加速**。

---

## 4. 结论（按任务书 §9 的判据）

> 主要成功判据：在可接受的任务成功率下，端到端任务耗时明显下降。

**未达成。** 诚实结论：

| 判据 | 结果 |
|---|---|
| 成功率 | 两轮均与 default 持平（v2：19/20 vs 18/19）；v1 曾更低 |
| 中位耗时 | v1 turbo 快 35%，v2 turbo 慢 12% → 符号不稳定 |
| 尾部延迟（P90） | v2 turbo 快 32%（单样本，不可外推） |
| 步数/工具调用 | v2 turbo 步数更高（14 vs 12），说明"少走弯路"并未稳定发生 |
| 结论 | **没有可重复的加速**；本插件应作为"可切换、可观测的策略开关"交付，而不是"加速器" |

为什么会这样（不是实现缺陷，而是机理）：

- 当前组合**没有可关闭的自动阶段**（见 `compatibility-report.md` §3.3），Turbo 拿不到
  "删掉一个阶段"的确定性收益，只能改变模型的自选步骤。
- 这些任务只有 1 个文件、1–2 个函数，模型本来就只需要 4–15 步；可压缩空间小于采样噪声。
- 提示词本身每次请求多约 200 token；若没能减少步数，就是净增加。
- 真正强的延迟杠杆是 `reasoningEffort`（请求级参数）。0.1.1 起默认在 Turbo ON 时设为
  `minimal`，OFF 时保持上游配置；这个质量/延迟权衡需要单独一轮对照测量，不在本报告范围内。

**给使用者的建议**：默认保持 Turbo OFF；在长任务、多轮返工、明显被"反复确认/过度验证"拖慢的
会话上再打开，并通过 Host 指标或同题 ON/OFF 小测试自己判断。这也是插件默认 OFF 的原因。

---

## 4.1 0.1.3 更新：真正的延迟杠杆现在才被证明有效，但还没测

上面两轮测量中，两臂的 `reasoningEffort` 都是上游默认的 `high`（0.1.0/0.1.2 的覆写被下游监听器吞掉，
或配置值本身非法）。0.1.3 用 `prepend` 修正后，探针实测 `request/header` 已携带 `"reasoningEffort":"low"`
（`~/.dsh/sessions/…/session.v4.jsonl.zstd` 中的 `request/header`）。

这意味着"最直接的加速杠杆"**现在才真正可用**，而 `PERFORMANCE.md` §3 的数据**不包含它**。
要用数据回答"Turbo 到底快多少"，需要补一轮：Turbo ON（`reasoningEffort: low`）× 上游 OFF 的对照。

```powershell
# 生成 low 的覆盖层，然后复用同一 harness
#   - id: dsh-turbo / config: { reasoningEffort: low, defaultMode: turbo }
node scripts/benchmark.mjs --profile turbo-bench --repeat 3 --out PERFORMANCE-bench.md
```

预期与风险：`low` 会减少思考 token（`outputTokens.reasoningTokens` 可直接观测），但可能降低复杂任务的成功率——
必须同时看通过率，不能只看墙钟。这正是本报告 §4 的结论仍然成立的原因：**在没有新数据前，默认保持 OFF**。

## 4.2 用户界面同题对照（单一样本）

2026-10-23，用户用同一类“鹈鹕在海边骑自行车”的单文件 HTML 任务做了一次 Turbo ON / Default 对照。
两次结果都成功生成可打开的页面；Turbo 结果还包含音效和交互，但两份输出并非字节级一致，因此只适合作为
真实使用试点，不是受控实验。

![用户同题对照结果](./assets/benchmark-user-pair.png)

| 指标 | Turbo ON | Default | Turbo 相对变化 |
|---|---:|---:|---:|
| 完成耗时 | 6:55（415 s） | 9:46（586 s） | **−29.2%**；吞吐速度 1.41× |
| 界面显示 Token 用量 | 3.7M | 7.5M | **−50.7%** |
| 模型步骤 | 42 | 72 | **−41.7%** |
| 工具调用 | 41 | 71 | **−42.3%** |

数据文件：[`benchmark/paired-ui-sample.json`](./benchmark/paired-ui-sample.json)。界面显示的 M tok 包含缓存读取，
不能直接当作新增 Token 或账单用量；只有一个配对样本，也没有随机化或多次重复。对外可准确表述为：
**“一次同题实测中，耗时减少 29%、界面 Token 用量减少 51%；效果会因任务、模型和网络而变化。”**

## 4.3 0.2.2 三档校准：Default / Fast low / Max high

2026-10-23 把 Max 从与 Fast 相同的 `low` 改为真正独立的 `high`，并修正基准统计：只有机器
断言通过的运行进入耗时/token 汇总；任务级差值只使用同一轮三档都通过的完整配对；超时即排除。
证据日志确认 Max 每步实际记录 `reasoningEffort: "high"`，但 provider 仍把三档的
`reasoningTokens` 全部报告为 0，因此继续以墙钟、通过率和普通 token 为准。

### 短任务：`sum-js`，3 轮 Latin-square 交错

公开的机器可读记录：`benchmark/validation-2026-10-23.json`；渲染表：
`benchmark/formal-sum-js-3x.md`。三档共 9 次运行，全部通过。本机原始事件汇总仍保存在
gitignored 的 `benchmark/results-2026-10-23T14-02-36-460Z.json`。

| arm | 通过 | 中位耗时 | 相对 Default | 均值耗时 | 平均输入 tok | 平均输出 tok |
|---|---:|---:|---:|---:|---:|---:|
| Default | 3/3 | 31 413 ms | 基线 | 33 270 ms | 2 940 | 3 417 |
| Fast (`low`) | 3/3 | 41 606 ms | **+32.4%（更慢）** | 37 664 ms | 3 421 | 3 422 |
| Max (`high`) | 3/3 | 28 625 ms | **−8.9%** | 38 874 ms | 3 391 | 4 062 |

逐轮 Fast 相对 Default 为 `+11.0% / −23.2% / +52.8%`；Max 为
`+79.0% / −8.9% / −32.4%`。符号在 3 轮内反复变化。Max 的中位数较快，但均值反而慢
16.8%，平均输出 token 多 18.9%，不能解释为稳定加速。

### 多文件任务：2 个任务 × 2 轮

12 次运行中有 1 次达到 180 s 超时（即使落盘文件恰好通过也排除）。剩余结果的通过率：
Default `2/3`、Fast `3/4`、Max `2/4`。只有 `regional-totals` 第 1 轮形成完整有效配对：
Default 65 922 ms、Fast 72 625 ms（`+10.2%`）、Max 80 712 ms（`+22.4%`）。
`dashboard-summary` 的 Max 两轮都未通过机器断言。

另一次独立的 `regional-totals` 冒烟却得到 Fast `−44.4%`、Max `+4.1%`，三档都通过。
同题不同轮次仍然反向，进一步证明采样噪声和模型路径选择大于当前策略的稳定收益。

**当前可发布结论**：Fast 是“低推理、少步骤倾向”，Max 是“高推理、愿意多花预算”的执行偏好；
两者都不是固定倍数加速器。用户界面中的 `约 1.5× / 节省约 20%` 只能写成邀请用户自己做
同题 A/B 的示例目标，不能作为本项目已经复现的性能承诺。

## 5. 局限

1. 样本：20 个任务 × 单次重复（v2）、9 个任务（v1）。这是**试点级**证据，不是产品基准。
2. 任务集偏简单（单文件、可断言），对长任务/多轮返工不具代表性。
3. 单模型、两臂均为 `reasoningEffort: high`；本历史结果未测 0.1.1 默认的 `minimal` 杠杆。
4. Total Latency 含进程启动；任务级墙钟受网络与模型服务状态影响，**跨时间不可直接比较**。
5. 一次 provider 传输故障导致 v1 后 11 个任务作废（已在 harness 中加入重试与 `excluded` 标记）。

## 6. 复现

```powershell
cd C:\path\to\dsh-turbo
node scripts/benchmark.mjs --profile turbo-bench --limit 2      # 冒烟
node scripts/benchmark.mjs --profile turbo-bench --repeat 5 --out PERFORMANCE-bench.md
node scripts/benchmark.mjs --profile turbo-bench --tasks fix-offbyone,clamp-js,retry-js
```

想要统计上站得住的结论，至少需要 `--repeat 5` 与更大的任务集；
现有 harness 已支持重复、任务筛选、超时与故障剔除。
