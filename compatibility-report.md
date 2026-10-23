# DSH Turbo — 兼容性报告（Phase 0）

**目标实例**：本机 `<DSH_HOME>\profiles\desktop` 上运行的 DeepSeek Harness 桌面版
**DSH 版本**：`0.2.0-rc.2`（`dsh/package.json` → `@deepseek-ai/dsh-desktop-runtime`；build commit `04f392c9ddd144fa426da2045178797da6db6c11`）
**GUI**：<http://127.0.0.1:19387>（PID 14308 持有监听）
**Node**：v24.18.0 · **pnpm**：12.4.1 · **平台**：Windows

> 侦察方式：`app.asar` 仅被读取（未解包到安装目录），提取到工作目录
> `<working-directory>\dsh-turbo-work\asar\` 后逐包核对源码与 README。以下每条结论都标注了证据来源。

---

## 0. 结论速览

| 需求 | 能否用公开接口实现 | 实现方式 |
|---|---|---|
| 插件可加载/启用/卸载 | ✅ | Bundle 包：`dsh.bundle.patch` + profile 行 `dsh-turbo`，卸载即行与包一起消失 |
| Web UI 输入区显示 Turbo 开关 | ✅（不是任务书假设的 Slot） | `conversation.input.right`（list）——`conversation.input.activity` 存在但不可占用 |
| 状态按 Session 隔离 | ✅ | 以 SessionId 为键的 Host 存储 + revision 版本号 |
| 状态传到 Host 运行时 | ✅ | 官方 HTTP 桥 `/api/dsh-turbo/*`（`ctx.webServer.register`） |
| 开关实际影响 Agent 策略 | ✅ | `ctx.systemPrompt.section()`（按 agent 动态文本）+ `agent/pre-step` 瀑布 |
| 关闭后完全恢复 | ✅ | 默认模式下该 section 渲染为空字符串，等于未安装 |
| 结果是否经过验证的告知 | ✅（策略 + 观测） | Prompt 强制披露 + 从 `tool/call` 观测"是否真的跑了测试" |
| 所有注册可撤销 | ✅ | 全部注册挂在插件 fiber 上，Cordis 卸载时自动回收 |
| 跳过"可选的自动 Review/测试阶段" | ⚠️ 不适用 | 本组合**没有**任何自动 Review/测试插件（见 §3） |
| 用 Runtime 强制"单次执行" | ❌ 无接口 | 只能通过 Prompt 倾向 + 不新增循环；不伪造开关 |
| 按会话取消工具 | ❌ 且禁止 | 会破坏正常任务（任务书 §2.3 明确禁止） |

---

## 1. 运行时与 Profile 事实

| 事实 | 值 | 证据 |
|---|---|---|
| 桌面版运行时 | `@deepseek-ai/dsh-desktop-runtime@0.2.0-rc.2` | `app.asar → dsh/package.json` |
| 活动 Profile | `<DSH_HOME>\profiles\desktop` | 运行进程命令行第三参数 |
| Bundle 列表 | `dsh-base`、`dsh-web-app`、`dshmarket`、`dsh-whale-widget`、`open-sea-skin`、`@xmanrui/dsh-im`、`dsh-client-liang-intensity-skin`、`@tt-a1i/archify-dsh`、`dsh-free-search`、`@deepseek-ai/dsh-experimental-agent-team-profile` | `profiles/desktop/package.json → dsh.profile.bundles` |
| 另有 CLI | `dsh` 0.1.2-alpha.2（`AppData\Roaming\npm\dsh.ps1`） | `dsh --version` —**版本低于运行中的 Host，不作为安装/验证途径** |
| 配置热更新 | Profile 配置默认热重载（`hmr` 行启用，`profileContext` 存在时） | `dsh-base/cordis.patch.yml` L24–32 注释"Profile configuration reloads by default" |

**推论**：安装必须针对 `desktop` profile（运行中的实例），而不是任务书示例里的 `web` profile；后者是另一套 0.1.2 的 CLI 装机。本插件对两者都可用，但**验收只在 desktop 上进行**。

---

## 2. Web Client 插件机制（已核实）

### 2.1 加载规则

证据：`@deepseek-ai/dsh-client-modules/lib/index.js`

- Host 扫描 Loader entry 里带 `dsh.client` 的包（L104–107）。
- `dsh.client.platform` 必须是字符串，取值 `web` 才会组成 boot graph（L65、L714）。
- Client 入口是 **`exports["./client"]`**（L170–181），可用字符串或 `{ default: ... }`。
- Bundle 是**自注册脚本**，必须是 `window.__ModuleLoader__.load({ id, factory })` 形式；`id` 等于包名（`<id>/client` 与裸包名等价，L91–93）。
- `factory(require)` 的 `require` 只能解析：平台种子表（React、Cordis、少量 UI 库）、已物化模块、boot graph 行。其它任何 `require` 直接抛错（L705）。
- 因此本插件 client bundle 只 `require("react")` / `require("react/jsx-runtime")`，`dsh.client.external` 为空数组。

### 2.2 任务书假设的 Slot 与现实不符

| 项 | 任务书 | 实际（0.2.0-rc.2） |
|---|---|---|
| 输入区扩展 Slot | `conversation.input.activity` | Slot 存在，但 **`kind: 'single'`**，且渲染位置就是"发送/停止按钮"本身 |

证据（`@deepseek-ai/dsh-client-ui-conversation/lib/client.js`）：

```js
"conversation.input.activity": { kind: "single", scope: "session" }   // L18325-18328
```

```js
className: activity ? ...activityExpanded : ...activity,
children: renderSlot("conversation.input.activity", { locked, onActiveChange: setActivity })  // L17534-17539
```

`@deepseek-ai/dsh-client-ui-slots/lib/index.js` L170–172：

```js
case "single": {
  const occupant = rec.entries.find(e => (e.options.priority ?? 0) === priority)
  if (occupant) throw new Error(`single slot "${options.name}" already has a registration ...`)
```

**结论**：注册进 `conversation.input.activity` 只有两种结果——抛错，或**顶掉发送按钮**。两者都不可接受。

**采用的替代**：`conversation.input.right`，声明为 `kind: "list"`（L18318-18320），语义是"提交按钮左侧的紧凑控件"，正是 Turbo 开关应该出现的位置，且允许多个条目、有稳定 `id`、渲染条件为 `input !== undefined && sessionId !== undefined`。

### 2.3 注册 API 与属性（已核实）

```js
ctx.slots.inject(name, factory)        // 等待父条目声明该 Slot
ctx.slots.register({ name, id, locale, inject: (sessionId, actions) => ({...}) }, Component)
```

- `inject(sessionId)` 收到的第一个参数是 **Session 绑定键**（`@deepseek-ai/dsh-client-ui-renderer/lib/client.js` L415–421：`runInject(entry, binding, actions)` → `inject(binding.key, actions)`）。这正是组件拿到当前 Session 的官方途径。
- 组件 props = 业务 `inject` 返回值 + `t`（本地化，`locale: NS` 时注入）+ 标准 Session 工具（`useConversation`/`useInput`/`inputActions`）+ owner props。
- 参照实现：`@deepseek-ai/dsh-client-ui-plan` 的 `PlanChip` 正是"输入区单 Slot + `inject(sessionId)`"的写法，本插件沿用同一形状。

---

## 3. Agent Hook 与提示词机制（已核实）

### 3.1 事件清单（`@deepseek-ai/dsh-agent/lib/index.js`、`dsh-agent-loop/lib/index.js`）

| 事件 | 类型 | 载荷（实测） | 本插件用途 |
|---|---|---|---|
| `agent/created` | serial | `{ agent, source, signal? }` | 可选：按 Agent 作用域挂 reasoning-effort |
| `agent/pre-step` | **waterfall** | `{ agent, turn, step, messages, signal }` → `{ kind: 'enter' \| 'reject', messages }` | 策略证据 + 步数统计 |
| `agent/request` | **waterfall** | `{ turn, step, signal }` → `{ provider, model, reasoningEffort?, maxTokens? }` | Turbo ON 时下调 reasoning effort；OFF 时原样返回 |
| `agent/turn-stopping` | serial | `{ turn, signal }` | 未使用（无需要） |
| `session/event` | emit | `(session, event)`，`event.type ∈ turn/start, turn/end, tool/call, tool/result, assistant/message…` | 轮次耗时、工具调用数、是否跑过验证 |

证据：`dsh-agent-loop/lib/index.js` L954–957（`preStep(target, {turn, step})`）、L911–918（waterfall 形状）、L1179–1183（`agent/request`）、L999–1002（`agent/turn-stopping`）、`dsh-agent/lib/types/index.js` L332–336（`agent/created` 载荷）、`dsh-agent-loop/lib/index.js` L682–700（`tool/call`/`tool/result` 数据形状）。

### 3.2 系统提示词扩展点

`@deepseek-ai/dsh-system-prompt`（`lib/index.js` L239–262、L342）：

```ts
ctx.systemPrompt.section({ name, order, text })   // text 可以是 (context) => string
```

- `text` 支持函数，装配时以 `{ agent, scope, ... }` 调用（L342），因此**一个全局 section 就能按 Session 渲染**，无需为每个 Agent 重复注册。
- `order` 可为任意有限数。官方 `SECTION_ORDERS`（L10–46）留有空隙：`PLAN_POLICY: 500`、`TEAM_POLICY: 600`、工具指南从 `TOOL_BASH: 1000` 开始。本插件取 **700**。
- Section 文本为空字符串时会被丢弃（`renderPrompt` 过滤 `length > 0`），因此默认模式下**提示词与未安装插件时逐字节一致**。
- 参照实现：`@deepseek-ai/dsh-plan-mode` 用同一机制实现"计划模式策略"（`lib/index.js`：`ctx.systemPrompt.section({ name: 'plan:policy', ... })`），本插件与其同构。

### 3.3 是否存在需要"关掉"的自动阶段

**没有需要关闭的自动阶段。** 证据：

- `dsh-base/cordis.patch.yml` 的完整行表（529 行）中不存在任何 `auto-review`、`auto-test`、`reflection` 行。
- 发行物里确实有 `@deepseek-ai/dsh-experimental-auto-review`，但：
  - 它在 bundle 清单中是 **`enabled: false` 的可选 bundle**（`removable: false, optional: true`）；
  - 它的描述是 "Per-tool LLM authorization review for the DeepSeek Harness **Auto permission preset**"——即"给 Auto 权限预设做逐工具授权复核"，属于**审批策略**，不是"对 agent 产出做事后 review"；
  - 它没有被任何激活的 profile 选中。
- 当前组合里"计划/复核/测试"完全由模型自行决定，harness 不会自动插入。

**含义**：Turbo 能做的不是"关闭某个内置阶段"，而是
(a) 用提示词把"不要开启可选复核/测试"作为执行契约，
(b) 不新增任何循环，
(c) 通过 `session/event` **诚实观测**是否真的跑了验证并展示给用户。

任务书 §5.5 的"情况二"正是本机情况；UI 中该能力显示为 `unavailable`（"本组合没有可跳过的自动阶段"），而不是伪造一个"已关闭"。

### 3.4 其它已核实的相关事实

- 会话日志事件类型：`turn/start { turn }`、`turn/end { turn, reason }`、`tool/call { turn, step, callId, name, arguments }`、`tool/result { turn, step, message }`（`dsh-agent-loop/lib/index.js` L682–700、L943、L1027）。
- `agent.id === agent.session.id`（`dsh-agent/lib/index.js` L512 强制校验），所以 SessionId 就是 AgentId。
- 模型路由默认 `deepseek-flash`，上游为 `reasoningEffort: high`（`profiles/desktop/cordis.patch.yml` 的 `agent-default-model`）。DSH Turbo 0.1.1 默认只在 Turbo ON 时通过 `agent/request` 改为 `minimal`，OFF 时原样返回上游配置。

---

## 4. Host 侧接口选择

### 4.1 为什么用 HTTP 桥而不是新增 Remote 命名空间

官方口径（`env` 内 `@deepseek-ai/dsh-api-gateway/README.md`）：

> Business Services extend `TypertRemoteService` and mark methods with `@Remote` / `@RemoteScope` … Strict mode reads generated invocation descriptors from `ctx.typert.local`.

也就是说自定义 Remote face 需要 **build 期生成的 invocation descriptor**（Typert 编译产物）。第三方插件做不到，只能在 DSH 仓库内构建。而 `api-remotes` 明确写死"capability set is fixed by explicit build-time value imports"。

**结论**：外部插件用 `ctx.webServer.register()` 暴露自己的 `/api/<name>/...` 路由，这是已安装第三方插件（`dsh-free-search` 0.4.28，路由 `/api/dsh-free-search-settings/*`）正在使用并被本机验证的路径。

### 4.2 桌面版 Electron 如何转发

证据：`app.asar → lib/main.js` L11542–11553

```js
protocol.handle("dsh-app", (request) => {
  const url = new URL(request.url)
  if (url.hostname === "shell") return serveWebDocument(...)
  if (url.hostname === "app") {
    if (url.pathname === "/" || ... "/assets/" ...) return serveWebDocument(...)
    return forwardWebRequest(request, hostUrl, hostCookie)   // ← 其余全部转发给 Host HTTP
  }
  ...
})
```

**结论**：渲染进程里 `fetch('/api/dsh-turbo/state')`（相对 `dsh-app://app`）会被带 cookie 转发到 Host 的 HTTP 路由表，自定义前缀可达；Web 浏览器场景同源直连。

### 4.3 路由匹配顺序（避免抢 `/api`）

`@deepseek-ai/dsh-host-webserver/README.md`：

> Route matching is fixed: exact over the whole table, then longest prefix, then the fallback handler.

- `connection` 行把 Gateway 绑在 `/api` 下；
- 本插件只注册 **exact** 的 `/api/dsh-turbo/state` 与 `/api/dsh-turbo/health`，先于任何前缀匹配命中，不会遮蔽 `/api` 其它端点。

---

## 5. 无法控制 / 明确不做的部分（写入 UI 与文档，不夸大）

| 能力 | 状态 | 说明 |
|---|---|---|
| 强制"单次执行、禁止重试" | ❌ 不可控 | Agent Loop 无此开关；机械截断会破坏故障恢复（任务书 §5.6 亦禁止） |
| 关闭某个"可选复核阶段" | ➖ 不存在 | 当前组合无此阶段（§3.3），因此在 UI 中不声明"已关闭" |
| 按会话禁用某工具 | ❌ 且禁止 | 只能靠工具库/插件级配置；按字符串过滤会误伤正常任务 |
| 无 HTTP 面时仍执行策略 | ✅ 已实现 | 插件不硬依赖 `webServer`，headless/SDK 只用策略与度量，桥接报告 `unavailable` |
| 降低推理强度 | ✅ 已实现 | `agent/request` 写入 `reasoningEffort: minimal`；仅 Turbo ON 生效，可配置为 `inherit` 关闭 |
| 物理并发调度 | ✅ 原生 | 仍然使用 Harness 原有并行工具调度，不新增调度层 |
| 沙箱/审批/权限 | 🚫 不动 | 任何"加速"都不触碰这些项 |

### 5.1 一个被推翻的初始设计（记录在案）

最初把 `webServer` 写成插件的**硬依赖**（`export const inject = ['webServer']`）。实机在 headless profile 上验证时发现：headless 组合没有 webserver，插件因此**根本不激活**，策略也就完全不生效——即"加速"被错误地绑死在浏览器界面上。

已改为：`inject = []`，HTTP 桥在 `ctx.inject(['webServer'], ...)` 中**可选**注册，能力表里增加 `http-bridge` 条目如实报告。这样 Web/Desktop/headless/SDK 四种形态都能执行策略，只有"能不能用开关切换"这一项不同。

### 5.3 推理强度杠杆的两个陷阱（0.1.2 → 0.1.3 实测）

任务书允许"用更多资源换更短耗时"，请求级 `reasoningEffort` 是最直接的杠杆，但本机实测踩到两件事：

**陷阱一：请求被下游监听器改写。** `@deepseek-ai/dsh-agent` 的模型选择监听器（`lib/index.js` L181-192）会

```js
const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
return { ...withoutInheritedEffort, provider, model, ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort } }
```

即：**剥掉上游写入的 `reasoningEffort`，再写回它自己选择的值**。插件若以默认顺序（下游）注册，覆写会被静默丢弃。
必须 `ctx.on('agent/request', handler, { prepend: true })` 注册到**上游**，先拿到最终 config、再覆写。
实测证据：`request/header` 的 `header.config.reasoningEffort` 在修正前为 `high`、修正后为 `low`。

**陷阱二：厂商适配器有自己的词汇表。** `@deepseek-ai/dsh-llm-deepseek` 只接受 `off | low | high | max`
（`lib/index.js` L1694-1700，否则抛 `UNSUPPORTED_REASONING_EFFORT`）。`minimal`/`medium` 在该路由上非法，
写进配置会让**每个 Turbo 轮次失败**。

因此插件的处理是：默认 `inherit`（不碰请求）；只在真实 `request/header` 携带配置值时才报告 `applied`；
被路由拒绝时撤销该 Agent 的杠杆、返回 `{ kind: 'retry' }` 让本轮继续，并在能力表里写明拒绝原因。
### 5.2 服务可达性（Cordis 作用域）

未在 `inject` 中声明的服务**不能**用属性读取：`ctx.agents` 在插件 fiber 上返回 `undefined`。必须用 `ctx.inject(['agents'], (sctx) => ...)`（官方诊断接口也把 `ctx.get("agents")` 标注为"需判空的可选访问"）。本插件对 `systemPrompt`、`webServer`、`agents` 全部走 `ctx.inject`。

---

## 6. 版本风险与适配层设计

- **锁定**：`package.json` → `dsh.engines.dsh: ">=0.2.0-rc.1"`，`dsh.compatibility.dshReleases["0.2.0-rc.2"]: "tested"`。
- **隔离**：所有 Host 侧 Harness 接触点集中在 `src/host/runtime-adapter.ts` 一个文件（外加 `cordis-surface.ts` 的结构化类型），Slot 名称、路由前缀、locale 命名空间集中在 `src/client/` 与 `src/host/plugin.ts` 常量。
- **启动检查**：`RuntimeAdapter.capabilities()` 在每次读取时报告真实生效情况；缺失服务（无 `systemPrompt`、无 `agent/pre-step`）只会降级为 `unavailable`，不会让 profile 起不来。
- **失败回退**：状态写入失败 → 内存态继续服务；证据日志写失败 → 仅上报告警；HTTP 不可达 → UI 显示 `Turbo unavailable`，绝不显示"已生效"。
- **自动化守卫**：`tests/compatibility.test.mjs` 把本报告的关键事实写成断言（bundle 形状、只 require 基线模块、路由只 exact、禁止关键词过滤、不改权限），DSH 升级若改变这些事实会先让测试失败。

---

## 7. 本机验证环境记录

```
Host:      DeepSeek Harness 0.2.0-rc.2 (Electron 桌面版)
Profile:   <DSH_HOME>\profiles\desktop
GUI:       http://127.0.0.1:19387
Node:      v24.18.0
pnpm:      12.4.1
OS:        Windows
```

安装位置（本机实测）：`C:\path\to\dsh-turbo` → 以本地路径加入 `desktop` profile。

---

## 8. 实机验证记录（Phase 1–2 已完成项）

以下不是设计推演，是在本机运行中的实例上得到的观测值。

### 8.1 安装与加载

```text
plugin_manager.install_bundle  target=C:\path\to\dsh-turbo
→ { stage: "enable", changed: true, application: "applied",
    packageResult: { exitCode: 0, "dependencies: + dsh-turbo link:C:/Users/19128/dsh-turbo" } }
```

- Host 行在**不重启**的情况下热重载生效（profile 配置热重载）。
- `GET /api/dsh-turbo/health` → `200 {"ok":true,"name":"dsh-turbo","version":"0.1.0",...}`。
- 客户端 bundle 由 `client-modules` 增量重组 boot graph；**无需重启**即可出现在 Slot 树中。

### 8.2 客户端 Slot 注册（框架级证据）

用 Cordis Inspect Provider 读取**运行中渲染进程**的 Slot 树：

```json
{ "type": "slot", "name": "conversation.input.right", "kind": "list", "scope": "session",
  "occupants": [
    { "id": "liang-intensity-control", "order": 10, "active": true },
    { "id": "dsh-turbo",              "order": 10, "active": true }
  ] }
```

`active: true` 表示条目已注册且渲染授权有效。同一 Slot 上还有另一个第三方插件的控件，说明 `list` 语义下可以共存（`single` 不可能）。

### 8.3 UI 与状态回写（端到端）

1. 输入区实际出现 `Turbo` 控件（紧邻模型选择器左侧）；
2. 点击后 UI 变为 `⚡ Turbo ON`（主题 business 色相，未使用独立全局 CSS）；
3. 同时刻 Host 权威状态：

```json
{ "state": { "sessionId": "session-234a…", "mode": "turbo", "revision": 1, "updatedAt": 1792653444716 } }
```

4. 磁盘持久化 `~/.dsh/storages/dsh-turbo/state.json` 出现同一记录（刷新/重开会话即恢复）。

### 8.4 运行策略确实生效（日志级证据）

`~/.dsh/storages/dsh-turbo/evidence.jsonl` 中，同一轮对话（turn 3）内的连续两条记录展示了策略切换：

```json
{"event":"pre-step","turn":3,"step":24,"mode":"default","revision":0,
 "policy":{"minimalPlanning":false,...,"preferLowLatency":false,"preserveMandatoryChecks":true},
 "promptSection":"applied","reasoningEffort":"inherit"}

{"event":"mode-change","mode":"turbo","revision":1,"turbo":true}

{"event":"pre-step","turn":3,"step":25,"mode":"turbo","revision":1,
 "policy":{"minimalPlanning":true,"preferSinglePass":true,"skipOptionalReview":true,
           "skipOptionalTests":true,"preferLowLatency":true,"preserveMandatoryChecks":true},
 "promptSection":"applied","reasoningEffort":"inherit"}
```

即：切换后的下一个 `agent/pre-step` 边界上，实际生效的策略集合从"全 false"变为"全 true"，且提示词 section 处于 `applied`。**这是运行时行为的差异，不是回复文本的差异。**

### 8.5 headless（无浏览器）验证

同一份产物在 `turbo-bench` profile（`dsh-base` + `dsh-headless` + `dsh-turbo`，**无 webserver**）下：

```json
{"event":"pre-step","session":"session-4d4e…","mode":"default",
 "policy":{...},"promptSection":"applied"}
{"event":"turn-end","latencyMs":1156,"steps":0,"toolCalls":0,"verificationObserved":false}
```

- 说明策略层与度量层不依赖 Web 面；
- 桥接在该 profile 中如实报告 `http-bridge: unavailable`。

### 8.6 关于"当前进程里跑的是哪一版代码"

§8.1–8.4 的实机证据来自**首次安装的那一版构建**（策略机制与最终版一致：同一个 prompt section、同一个 `agent/pre-step`、同一个存储与桥接）。之后仓库里的实现继续演进（桥接改为可选、增加 `http-bridge` 能力行、`defaultMode`、`live` 兜底、提示词 v2、详情面板键盘关闭），这些改动**需要重启进程**才会进入运行中的实例（原因见 §9 第一行）。

因此：仓库 `HEAD` 是最终交付；运行中的桌面实例在重启后与之完全一致。二者的策略路径相同，差异仅为上述附加项。

---

## 9. 运行期事实（会影响使用者操作）

| 事实 | 影响 | 应对 |
|---|---|---|
| Cordis/Node 的 ESM 模块缓存按解析路径命中 | **重建一个已安装（link）插件的 `lib/` 后，运行中的 Host 仍执行旧代码**；`disabled→enabled` 不会重新 `import` | 改动插件实现后需重启 DSH；或用版本号不同的包重新安装。README 已写明 |
| HMR 的模块根默认 `root: []` | 只有 profile 配置层热重载，**源码文件不监听** | 需要源码热重载时在 profile patch 里给 `hmr.root` 加上插件目录（本插件未擅自修改用户配置） |
| `/plugins/<id>/client.js` 直接访问是 404 | 客户端 bundle 通过 combo URL（`/plugins/??…&rev=…`）分发 | 无需处理；用 Slot 树/页面表现验证 |
| 自定义 `/api/...` 路由不受 host cookie 保护 | 任何本机进程都可达（loopback 边界，与已安装的 `dsh-free-search` 相同） | 本插件要求 `content-type: application/json`，浏览器跨站请求必须先过 preflight 而本插件不响应 OPTIONS，因此 CSRF 不可行；读接口只暴露模式与度量，写接口只改模式 |
| `ctx.agents` 等未声明服务需 `ctx.inject` | 直接属性读会得到 `undefined` | 代码中全部使用 `ctx.inject`（§5.2） |
