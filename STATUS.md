# DSH Turbo — 施工状态与文件清单

> 本文件回答"现在做到哪一步、每个文件是干什么的、还差什么"。
> 任务书的分阶段要求见 §2，逐项状态见 §3。

---

## 1. 一句话状态

插件已经**在运行中的 DeepSeek Harness 桌面版里装上并可用**：输入区有 Turbo 开关、Host 权威状态按会话保存、
切换后 `agent/pre-step` 证据显示策略集合从"全 false"变为"全 true"。
性能部分（Phase 3）测完并给出了**否定的诚实结论**：没有可重复的加速（`PERFORMANCE.md`）。

**0.1.4 把问号弹窗改为面向普通用户的效果说明**：不再公开模式、轮数、工具调用和内部机制，改为展示
“约 20% 减少执行流程”“约 1.5× 提升完成速度”及同题 ON/OFF 小测试邀请。底层诊断数据仍保留在 Host API。

**0.1.3 修掉了 0.1.2 的一个真实缺陷**（由你设置的 `reasoningEffort: minimal` 暴露）：

1. `minimal` 不是本路由的合法值——`dsh-llm-deepseek` 只接受 `off|low|high|max`，所以 0.1.2 的默认值会让每个
   Turbo 轮次直接失败（`UNSUPPORTED_REASONING_EFFORT`）。默认值已回到安全的 `inherit`，示例配置改用 `low`。
2. 0.1.2 的 `agent/request` 监听器注册在**下游**，而 `@deepseek-ai/dsh-agent` 的模型选择监听器会**剥掉**继承的
   `reasoningEffort` 再写回自己选的值——所以即使值合法也会被静默丢弃。改为 `prepend: true` 后实测
   `request/header` 已带上 `"reasoningEffort":"low"`（见 §6 的探针记录）。
3. 现在**以 `request/header` 为准**判定是否生效：只有真实请求带上配置值才显示 `applied`；被路由拒绝则撤销该杠杆、
   让本轮重试，并在能力表里写明原因（不再出现"UI 说生效、实际没生效"）。
4. 新增两条测试覆盖"被拒绝→重试"与"无关错误不拦截"，测试总数 40。

当前运行实例（11:52 启动）仍是 0.1.0 的模块；加载 0.1.4 需要重启 DSH（见 §4）。

---

## 2. 阶段状态

| Phase | 内容 | 状态 | 证据 |
|---|---|---|---|
| 0 | 环境侦察与接口核实 | ✅ 完成 | `compatibility-report.md`（逐条附 DSH 源码行号） |
| 1 | 原生 UI MVP | ✅ 完成 | Slot 树显示 `dsh-turbo` active；点击后 Host 状态 revision 1→持久化；详情面板可用 |
| 2 | 真实执行策略 | ✅ 完成 | `evidence.jsonl` 中 `pre-step` 的 `policy` 从 default 全 false 切到 turbo 全 true；headless 组合同样生效 |
| 3 | 性能验证 | ✅ 完成（结论为否定） | `PERFORMANCE.md`：两轮 20/9 任务对冲，无可重复加速 |
| 4 | 打包发布 | ✅ 完成 | `scripts/install.ps1` / `uninstall.ps1`、README 安装/卸载/排查、`dsh.engines` 版本锁定 |

---

## 3. 文件清单（按职责）

### 3.1 交付物（读者从这里开始）

| 文件 | 作用 |
|---|---|
| `README.md` | 安装 / 使用 / 配置 / 排查 / 卸载 / 开发；§Deliverable map 把任务书 §11 的每项要求映射到文件与验证方式 |
| `CHANGELOG.md` | 首次公开发布说明与版本变化 |
| `assets/benchmark-user-pair.{svg,png}` | 用户同题单次对照的可量化图表（图内带局限说明） |
| `assets/icon.{svg,png}` · `screenshots.json` | GitHub / 社区展示素材与截图声明 |
| `compatibility-report.md` | Phase 0 兼容性报告：DSH 版本、插件加载规则、Slot 真相（`conversation.input.activity` 为何不能用）、Agent Hook 载荷、提示词扩展点、无法实现的能力、实机验证记录、运行期事实 |
| `PERFORMANCE.md` | Phase 3 性能报告：方法、两轮实测表、否定结论、局限、复现命令 |
| `package.json` | 插件清单：`main`、`exports["./client"]`、`dsh.bundle.patch`、`dsh.client.platform`、`dsh.engines.dsh`、版本兼容声明 |
| `cordis.patch.yml` | Bundle 补丁：插入 `dsh-turbo` 行 + 全部可调配置（含注释） |
| `lib/index.js` · `lib/client.js`（+ `.map`） | **构建产物**（Host ESM / 浏览器 ModuleLoader factory），包内自带，使用者无需工具链 |
| `LICENSE` | MIT |

### 3.2 源码

| 文件 | 作用 |
|---|---|
| `src/index.ts` | Host 入口再导出 |
| `src/version.ts` | 版本常量（`build --check` 会校验与 package.json 一致） |
| `src/host/plugin.ts` | Cordis 插件：配置校验、存储/度量/证据装配、HTTP 桥（可选 `ctx.inject(['webServer'])`）、生命周期 |
| `src/host/runtime-adapter.ts` | 策略引擎与 Harness 适配层：提示词 section、`agent/pre-step` 证据、`session/event` 度量、可选 `agent/request` 降推理 |
| `src/host/session-store.ts` | 按 SessionId 保存模式，revision 版本号防并发覆盖，持久化 + 过期清理 |
| `src/host/metrics.ts` | 从会话事件算轮次耗时/步数/工具调用/是否跑过验证 |
| `src/host/evidence.ts` | JSONL 证据日志（1 MiB 轮转） |
| `src/host/json-file.ts` | 防抖 + 原子写的小型 JSON 文档 |
| `src/host/cordis-surface.ts` | 只用到的 Cordis 表面结构化类型（解释为何零 DSH 依赖） |
| `src/shared/types.ts` · `src/shared/policies.ts` | 线上协议类型；`ExecutionPolicy` 词汇与默认策略 |
| `src/prompts/turbo-policy.ts` | 唯一一段提示词（v2：最便宜的一次证明 + `Verified:` 披露行） |
| `src/client/index.ts` | 客户端插件：注册 `conversation.input.right` slot、locale 词典、作用域 CSS |
| `src/client/turbo-toggle.tsx` | 开关组件 + 用户效果说明（约 20% 流程节省、约 1.5× 加速、小测试邀请）；技术诊断仍保留在 Host API |
| `src/client/turbo-controller.ts` | 无 React 的桥接客户端：read/write/conflict/offline 分支 |

### 3.3 测试与基准

| 文件 | 作用 |
|---|---|
| `tests/session-state.test.mjs` | 状态权威性、revision 冲突、幂等、隔离、持久化、损坏文件恢复、校验 |
| `tests/runtime-policy.test.mjs` | 提示词只在 turbo 会话渲染、配置校验、HTTP 语义、pre-step 证据、度量、卸载撤销、验证识别 |
| `tests/toggle.test.mjs` | 真实执行 `lib/client.js`：ModuleLoader 形状、Slot 选择、locale 完整性、控制器各失败分支 |
| `tests/compatibility.test.mjs` | 把报告里的关键事实写成断言（bundle 形状、只 require 基线、路由只 exact、禁止关键词过滤、不改权限） |
| `tests/helpers/fake-host.mjs` | 假 Cordis Host（路由/事件/waterfall/inject），测试跑的是**构建产物**而非源码 |
| `scripts/build.mjs` | esbuild 双端构建 + `--check` 一致性闸门 |
| `scripts/benchmark.mjs` | ON/OFF 对冲基准：真实 headless 运行、断言验收、交错、故障剔除、超时 |
| `benchmark/tasks.json` | 20 个带机器可校验验收条件的编程任务 |
| `benchmark/run-log.txt` · `run-log-2.txt` | 两轮原始输出 |
| `benchmark/results-*.json` | 两轮原始指标（含 sessionId，可与会话日志交叉核对） |
| `benchmark/prompt-v2-plan.md` | v1→v2 的改动理由（先记录再改） |

### 3.4 运维脚本

| 文件 | 作用 |
|---|---|
| `scripts/install.ps1` | 用桌面版内置 CLI 把包装进指定 profile 并选中 bundle（幂等，打印验证命令） |
| `scripts/uninstall.ps1` | 取消选中、卸载依赖、`-Purge` 清理状态与基准 profile |

---

## 4. 已知未完成 / 需要人工一步

| 事项 | 原因 | 怎么做 |
|---|---|---|
| 运行中的 GUI 仍是 **0.1.0** | Cordis/Node 按解析路径缓存 ESM 模块，`disabled→enabled` 不会重新 import（`compatibility-report.md` §9） | 重启 DeepSeek Harness；`/api/dsh-turbo/health` 应报告 `version: 0.1.4`，且问号弹窗显示效果说明 |
| `reasoningEffort: low` 的真实加速幅度尚未实测 | Phase 3 两轮两臂都是 `high`，不包含这个杠杆；杠杆现在才被证明有效 | 用 `scripts/benchmark.mjs` 以 `reasoningEffort: low` 的 Turbo ON 对照上游 OFF 重跑 |
| 窄屏布局只做了 CSS 层面的适配 | 没有改动用户窗口尺寸去实测 | 在窄窗口打开输入区确认；`@media (max-width:640px)` 会隐藏 ON 状态的文字只留 ⚡ |

---

## 5. 验证命令（当前全部通过）

```powershell
cd C:\path\to\dsh-turbo
pnpm exec tsc --noEmit          # 严格类型检查，无输出
node scripts/build.mjs --check  # build output matches src/
node --test tests/*.test.mjs    # 40 tests / 40 pass
Invoke-RestMethod http://127.0.0.1:19387/api/dsh-turbo/health    # 运行中的 Host
```
