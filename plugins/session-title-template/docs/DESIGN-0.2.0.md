# session-title-template 0.2.0 设计方案

本文是 `session-title-template` 从 `0.1.3` 到 `0.2.0` 的设计方案。目标读者是维护这个插件的自己和审阅者；读完后应能回答三件事：0.2.0 交付什么、为什么是这个形状、按什么顺序做。

**结论先行**：上一轮方案（会话 `8c8e719a` seq 3267 与 seq 4310 两版）把 UI 卡在一个**错的约束**上——它假定 Client 调 Host 必须由插件自己注册 `@Remote`，而 `@Remote` 依赖 `app.asar` 内的 typert。这个前提不成立：框架已提供三条现成通路，**新增 Remote 方法数为零**。

| 方向 | 现成通路 | 适用面 |
|---|---|---|
| 固定标题（写） | `ctx.sessions.using(id, {}, ref => ref.binding.session.rename(title))` | **活会话 + 冷会话**（retain 会 resume 会话，并就地更新标题投影） |
| 重新生成 / 状态查询（写+读） | `ctx.remote.commands.execute()` → `ctx.commands.register()` 的 `/title` 命令 | **仅活会话**（`agent` 是 lookup，只解析活 Agent） |
| 状态展示（读） | `ctx.sessionProjections.register()` 的 wire 单元 | 全部会话（含列表行与冷会话） |

第二条通路有**活会话前提**，只有固定标题与状态展示对冷会话也成立。这不是细节：侧边栏右键点中的往往正是没打开的会话。方案因此按会话状态分流（§3.4.2），而不是把所有操作一股脑丢给命令。

在这个前提下，0.2.0 的范围是：**一次重构（把过载的 `generate()` 拆开）+ 三项 Host 能力（子代理 label 标题已完成，实为两项半）+ 一个 Client 半边**。

---

## 1. 问题

### 1.1 现状

| 事实 | 位置 | 含义 |
|---|---|---|
| `apply()` 187 行，`generate()` 114 行 | `index.js:18-205`、`index.js:71-184` | `apply()` 闭包捕获 14 个变量；`generate()` 经闭包依赖其中 9 个 |
| `generate()` 有 7 条 `return` | `index.js` 内 88、107、114、127、128、161、162 行 | 归为 4 个构造点（`keepCurrent`/委派/回退/模型）、3 种返回形状；每条出口自带一份状态判断 |
| `lib/title.js` 787 行，混四类职责 | `lib/title.js` | 0.2.0 要改 prompt，每次都得读全文件 |
| 18 条 Unreleased 已全部实现但未发版 | `CHANGELOG.md:3-22` | 版本停在 `0.1.3`，代码已是 0.2.0 规模 |
| 254 测试全绿，`npm run check` 通过 | 实测 | 重构有安全网 |
| **没有 `client.js`，没有 `dsh.client` 段** | `package.json:51-55` | UI 从零开始 |

同仓库兄弟插件 `session-video-intake` 已有双端形态（`exports["./client"]`、`dsh.client{platform,immediately,inject}`、`files` 含 `client.js`），可作为模板。

### 1.2 已确认的文档与实现偏差

这些偏差影响 0.2.0 的验收口径，必须一并修：

| # | 问题 | 证据 |
|---|---|---|
| 1 | README 说「两个工具」，实际注册三个 | `README.md:5,109` vs `lib/rename.js:13,52,86` |
| 2 | `maxProvisionalRefinements` 文档描述的「前 N 条消息窗口」不存在 | `README.md:50` vs `lib/refresh-policy.js:179`（无 N 界）；该配置只被解析，全文无读取点 |
| 3 | `docs/VALIDATION.md:26` 称三个工具都做 flush + 读回，实际只读工具不做 | `lib/rename.js:101-111` |
| 4 | `role-probe` 记录不带 `sessionId`，与 CHANGELOG 的「records 都带 sessionId」不符 | `index.js:34` vs `CHANGELOG.md:17` |
| 5 | `docs/VALIDATION.md:57-64` 只列 6 个测试文件，实际 18 个 | 实测 |
| 6 | `planTitle` 返回 10 字段，生产只消费 8 个（`reason`、`source`、`explicitRefresh` 无消费者） | `lib/title-plan.js:107-121` vs `index.js:107-108`（解构 6 个 + `plan.refresh` + `plan.forced`） |

---

## 2. 目标与范围

### 2.1 目标

1. **重构**：让新增能力不再往一个函数里堆。重构后 `generate()` 收缩为串联，每个阶段可独立测试。
2. **UI**：会话右键菜单四项操作、会话行尾状态图标、悬停状态明细，全部在一个包里。
3. **补齐**：子代理 label 标题（已实现，需发版）、历史整理工具入口（当前只在启动时自动跑一次，agent 不可调用）、pin/unpin 的正式入口。
4. **修文档**：§1.2 六项偏差。

### 2.2 不做

| 项 | 原因 |
|---|---|
| 自建跨进程通道（文件轮询） | 上一版方案的兜底，现已被框架已有的投影 + 命令两条通路取代，不需要 |
| 引入 `@Remote` / typert 依赖 | 当前安装形态下 asar 内包解析不到（实测 `ERR_MODULE_NOT_FOUND`）；且本方案不需要新增 Remote |
| 自建 HTTP 路由（`ctx.webServer.register`） | 0.2.0 曾以"投影 + 命令已够"为由不引入；0.2.1 因需要在**不写对话**的前提下读冷会话与保存配置而引入，代价是自做认证：`lib/owner-gate.js` 是唯一准入判定。Peer 存在时只信 Peer；Peer 缺席时（Harness 0.2.2 以 `handler(req, res)` 调用）回退到环回信任判定（`127.0.0.1`、`::1` 等文本环回形式才放行），非环回来源一律 403。这条回退由 `test/owner-gate.test.js` 覆盖，新增路由必须复用它而不是另写判定 |
| 改 DSH 核心适配器 | 超出插件边界 |
| 自动写用户 profile | 违反 DSH 配置契约 |
| 探针失败自动切换路由 | 探针只观测 |
| 独立设置页 | 菜单与悬停已够 |

### 2.3 关键约束（决定形状）

| 约束 | 证据 | 影响 |
|---|---|---|
| 第三方插件解析不到 asar 内任何包（当前 `link:` 安装形态） | `node -e "import('@deepseek-ai/dsh-client-ui-slots')"` → `ERR_MODULE_NOT_FOUND`；`zod` 同样失败 | Client 半边不能 import 任何 Harness Client 包，只能用 `require('react')`；Host 侧也不引入 typert |
| `ctx.remote.commands.execute(agent, line, attachments, signal)` 是框架已有的 Remote 方法 | `dsh-commands/src/index.ts:360` 的 `@Remote async execute(...)`；`cordis_inspect` 的 `listService('commands')` 确认 | **Client → Host 写出通路现成**（仅活会话，见下行） |
| **`commands.execute` 的 `agent` 是 lookup，只解析活 Agent** | `dsh-commands/lib/typert.host.js:77-79`（`source:'lookup'`）→ `dsh-agent/src/index.ts:273-278`（`resolve: id => this.get(id)`）→ `:591-593`（只返回活 Agent）→ 查不到抛 `gateway/lookup-not-found`（`dsh-api-gateway/src/index.ts:1085-1091`） | **菜单必须按活/冷分流**；冷会话的重新生成与状态查询不可用 |
| `ctx.remote.session.rename({sessionId,title})` 已存在，且 `resolveAgent` 会 resume 冷会话 | `dsh-api-session-controller/lib/typert.host.js:3255`；`src/agent.ts:152,176-186`；Client 封装 `client/sessions/manager.ts:565-568` 顺带更新 `title` 投影 | **固定标题对冷会话也安全**，是唯一这样的写路径 |
| 插件可注册 `sessionProjections` 单元，框架自动推给 Client | `dsh-session-projection/src/index.ts:334`（运行时接受任意 string key）；`summaryKeys()` 无 allowlist（`:575-584`） | **Host → Client 状态读通路现成** |
| projection 的 schema 只被 `.parse()` 调用，无 `instanceof Zod` 检查 | `dsh-session-projection/src/index.ts:178` 是唯一 `instanceof`（判 Set）；`stateSchema.parse`/`viewSchema.parse` 共 8 处 | 可用鸭子类型 schema，**不需要 zod** |
| `sidebar.session.row.trailing/hover` 与菜单 slot 的 owner props 都只给 `{sessionId}`（菜单多给 `displayTitle`） | `dsh-client-ui-workspace/src/client/contract/slots.ts:94-100,133-142,176,181,214` | UI 只能凭 `sessionId` 自取数据，不能依赖宿主传标题以外的东西 |
| 三个 slot 的 `standardProps` 不含 `useProjection` | `dsh-cordis-client-runner/src/client/slot-catalog.ts` | **状态必须走 `ctx.sessions.list` 的 `projectionValues`，不能走 `useProjection`** |

---

## 3. 方案

### 3.1 整体形状

```text
@redheartsecretman/session-title-template@0.2.0
├── index.js              Host 装配：只做接线，不含决策（冷会话路由经 `resolveColdRoute` 复用 `lib/run.js` 的优先级）
├── client.js             Client：菜单四项 + 行尾图标 + 悬停明细
├── lib/
│   ├── title/            ← 由 787 行 title.js 拆成三块
│   │   ├── text.js       清洗、CJK 空格、字宽、截断
│   │   ├── format.js     模板编译、渲染、解析、canonical 判定
│   │   └── prompt.js     buildSystemPrompt、frameMessages、稳定性规则
│   ├── title-plan.js     （已有）决策，纯函数
│   ├── title-state.js    （已有）状态快照，纯函数
│   ├── title-runtime.js  ← 新增：六个阶段编排，generate 退化成调用它
│   ├── projection.js     ← 新增：向 sessionProjections 注册 wire 单元
│   ├── commands.js       ← 新增：Host 侧命令注册（Client 经 commands.execute 调用）
│   ├── delegation.js     （已有）
│   ├── refresh-policy.js （已有）
│   ├── instructions.js   （已有）
│   ├── role-probe.js     （已有，接口收缩）
│   ├── run.js            （已有）
│   ├── state.js          （已有）
│   ├── rename.js         （已有，改为薄适配器）
│   ├── backfill.js       （已有，拆出预览阶段）
│   └── config.js         （已有）
└── cordis.patch.yml
```

**删除测试判断**：删掉 `title-runtime.js`，六个阶段的编排会分散回 `generate()` 和命令处理器，两处都要重复——它赚到了。删掉 `projection.js`，Client 只能轮询——它赚到了。删掉 `commands.js`，Client 无从调用 Host——它赚到了。

### 3.2 阶段 0：重构（无行为变化）

#### 3.2.1 把 `generate()` 拆成六个阶段

现状是 114 行单函数，闭包捕获 `config, ctx, state, lifetime, forcedRefreshes, activeRetitles, lastEvaluations, readInstructions, roleProbe` 九个变量。拆成：

```js
// lib/title-runtime.js —— 唯一的编排点
export function createTitleRuntime({ config, ctx, state, lifetime, readInstructions, roleProbe }) {
  return {
    // 一个入口替代原来的一个 generate；内部六阶段全部是纯对象进出
    async generate(request) { … },
  };
}
```

六个阶段，每个输入输出都是普通对象：

| 阶段 | 签名 | 职责 | 依赖 |
|---|---|---|---|
| `resolveContext` | `(request, deps) → { messages, current, date, options, sessionId, isSubagent, delegationLabel }` | 合成信号、校验、日期、当前标题、子代理身份 | `ctx.sessionTitle`、`formatDate` |
| `decidePlan` | `(context, flags) → plan` | 委托 `planTitle`，附加 `explicitRefresh`/`targeted` 标志 | `title-plan.js`（纯） |
| `selectInput` | `(context, plan) → { selected, messageSeqs } \| { skip }` | 上下文裁剪、预算 | `title.js`（纯） |
| `resolveTargets` | `(context, plan, deps) → { routes } \| { none }` | 路由解析、fallback 追加、定点重定向 | `run.js`（纯，除 ctx 读取） |
| `composePrompt` | `(context, plan, guidance) → { system, input }` | prompt 构造 | `title/prompt.js`（纯） |
| `callWithRetry` | `(targets, prompt, context, deps) → { title, model } \| throw` | 重试循环、探针触发、诊断记录 | `run.js`、`role-probe.js`、`state.js` |

`generate` 退化成：

```js
async generate(request) {
  const context = await resolveContext(request, deps);
  const plan = decidePlan(context, flags(context.sessionId));
  if (!plan.refresh) return keepCurrent(context);
  // 委派 label 已经命名了会话，精化才需要模型
  if (plan.delegationTitle !== undefined
      && !plan.forced
      && context.current?.source.kind !== 'provider') {
    return { title: plan.delegationTitle, messageSeqs: [context.messages[0].seq] };
  }
  const input = selectInput(context, plan);
  if (input.skip) throw new Error('session-title-template: no input fits the configured byte budget');
  const targets = resolveTargets(context, plan, deps);
  if (targets.none) {
    if (plan.explicitRefresh) throw new Error('Cannot regenerate the title: no model route is available');
    if (context.canonical) return keepCurrent(context);
    return { title: plan.fallback, messageSeqs: input.messageSeqs };
  }
  const guidance = await readGuidance(context, deps);
  const prompt = composePrompt(context, plan, guidance);
  return callWithRetry(targets, prompt, context, deps);
}
```

四种成功出口与三种返回形状（`{title,messageSeqs,model}` / `{title,messageSeqs}`）保持不变——重构只改代码形状，不改接口契约。

**收益**：测试面从「构造完整 ctx 才测一条规则」变成「对 `decidePlan` 传对象」。现有 `test/plugin.test.js`（26 例）和 `test/retry.test.js`（9 例）用完整 fixture，拆分后可保留作端到端回归，新增规则测试直接对阶段函数。

**纪律**：阶段 0 结束时 254 个测试必须全绿，且不改任何截面行为。这条是硬门槛。

#### 3.2.2 把 `title.js` 拆成三块

| 新文件 | 迁入内容（行号按现状 `lib/title.js`） | 消费者 |
|---|---|---|
| `lib/title/text.js` | `cleanTitleText`(62)、`formatCjkSpacing`(77)、`measureTopicWidth`(307)、`truncateTopic`(348)、`normalizeTopic`(416)，以及分词/加权内部函数 `tokenizeTopicUnits`(283)、`sliceByWeight`(325) 等 | `format.js`、`refresh-policy.js` |
| `lib/title/format.js` | `formatDate`(37)、`compileTitlePattern`(153)、`canonicalType`(204)、`renderTitle`(217)、`parseModelTitle`(453)、`isFormattedTitle`(481)、`isSettledTitle`(495)、`buildFallbackTitle`(507) | `title-runtime.js`、`backfill.js` |
| `lib/title/prompt.js` | `describeType`(523)、`titleAnchor`(539)、`stabilityLines`(558)、`buildSystemPrompt`(587)、`frameMessages`(707)、`selectContextMessages`(728) | `title-runtime.js` |

保留 `lib/title.js` 作为 re-export 垫片，让 `test/title.test.js`（67 例）在拆分当次不动。**实际结果（0.2.1）**：垫片保留为对外门面而非过渡物——它已不再只是转发，`provisionalRefinementLimit` 这类共享判定按需下沉到三块之上，新增消费者继续从 `lib/title.js` 取用，`title-plan.js` 也是这么用的。若要删除垫片，得先把这些共享判定放进 `title/` 下的明确归属，再改所有 import；在那之前承诺"0.2.1 删除"是错的。

#### 3.2.3 诊断记录：补 `sessionId`，保持两个 sink 分工

现状：`note(line)` 写人类日志，`record(entry)` 写 `diagnostics.jsonl`。`role-probe` 记录漏了 `sessionId`。

**实现结论（与原设计不同，以本节为准）**：不改动两个 sink 的分工。`note` 是给人看的行，`record` 是给程序读的字段——把它们合并成「`note` 是 `record` 的薄包装」会让人类日志变成从结构化字段重新拼出来的字符串，反而多一层。原设计的这一条是错的，已放弃。

实际改动只有一处：`role-probe` 的 `onVerdict` 携带 `sessionId`，`index.js` 写记录时带上它，于是探针结论也能按会话归属，与 `title-call-failed` 一致。

#### 3.2.4 `role-probe` 接口收缩

现状返回 `{ probe, status, detail, idle }`，其中 `status` 生产零引用（仅测试），`idle` 是生命周期细节。

收缩为：

```js
{ ensure(route, request) → void,   // 后台探测，永不阻塞、永不失败
  verdictOf(route) → { verdict, checkedAt } | undefined }
```

卸载排空由 `ctx.effect` 在模块内部自行管理，不外泄 `idle`。删除 `status`。

#### 3.2.5 清理无消费者的导出

盘点确认以下导出既无生产消费者也无测试引用：`title.canonicalType`、`title.titleAnchor`、`refresh-policy.SUBSTANTIVE_MIN_CHARS`、`refresh-policy.LOW_OVERLAP_RATIO`、`role-probe.MAX_UNKNOWN_ATTEMPTS`、`state.STATE_DIR_NAME`。降为非导出（内部常量）。只被测试引用的 15 个导出保留，它们是模块的测试面。

### 3.3 阶段 1：Host 能力

#### 3.3.1 状态投影（Host → Client 读通路）

新增 `lib/projection.js`，向 `ctx.sessionProjections` 注册一个 **wire 单元**：

```js
const definition = {
  key: 'sessionTitleState',          // 插件的键，不与宿主键冲突
  stateVersion: 1,
  stateSchema: plainSchema({ … }),   // 鸭子类型，只需 .parse()
  init: (header) => ({ title: null, source: null, pinned: false }),
  // 失败类别与探针结论留在 Host：它们是进程内观测，不是会话历史。
  apply: (state, event) => event.type === 'session/title'
    ? { ...state, title: event.data.title, source: event.data.source.kind, pinned: event.data.source.kind === 'user' }
    : state,                          // 不关心的事件必须返回同一引用
  wire: {
    viewSchema: plainSchema({ … }),
    view: state => state,
    summary: true,                    // 让 Session 列表行携带该键
  },
};
```

三个关键点，都有代码依据：

1. **运行时接受任意 key**：`register()` 的重载对 `key: Exclude<K, keyof SessionProjectionMap>` 只有一个类型层面的分支，运行时不校验（`dsh-session-projection/src/index.ts:334-340`）。
2. **`summaryKeys()` 无 allowlist**：它遍历所有已注册单元，取 `wire.summary !== false` 的键（`:575-584`）。声明 `summary: true` 后，键会进入每个 Session 列表行的投影块。
3. **schema 不需 zod**：全部 schema 调用点只有 `.parse()`（`:676, :680, :738, :750, :927, :954`），运行时没有 `instanceof Zod` 或 `_zod` 检查（`:178` 的唯一 `instanceof` 判的是 `Set`）。因此可以写一个 20 行的鸭子类型 schema，避免解析不到的 `zod` 依赖。

**Client 侧读取**：三个 slot 的 `standardProps` 不含 `useProjection`，但含 `useSessions`。走列表行：

```js
const state = useSessions(s => s.byId[sessionId]?.projectionValues?.sessionTitleState);
```

这与宿主自己的 `AgentPresetLabel` 读 `projectionValues?.agentPreset` 完全同构（`dsh-client-ui-agent-preset/src/client/AgentPresetLabel.tsx:47`），是框架认可的读取方式。

**完整链路**（每一跳都有代码依据）：

```text
插件 ctx.sessionProjections.register({ key: 'sessionTitleState', wire: { summary: true } })
  ↓
summaryKeys() 遍历已注册单元，取 wire.summary !== false 的键        index.ts:576-583
  ↓
api-session.list 的 projectionsFor() 调 snapshot(session, keys)      list.ts:279-283
  ↓
hintsOf('sequenced', block) → { asOfSeq, values }                    list.ts:306-314
  ↓
Client applyListBlock → projectionStore(sessionId)                   manager.ts:664
  ↓
SessionSummary.projectionValues                                      service.ts:59-62
  ↓
useSessions(s => s.byId[id].projectionValues.sessionTitleState)
```

**降级**：未打开过的会话从持久化缓存读（`cached` 行），水位不可比；打开后由 `sequenced` 行覆盖。读不到就是 `undefined`，UI 不渲染图标，不报错。

#### 3.3.2 Host 命令（Client → Host 写通路）

新增 `lib/commands.js`，注册 `/title` 命令。命令是框架机制，`execute` 本身是 `@Remote` 方法，**插件不需要注册任何 Remote**：

```js
ctx.inject(['commands'], (commandCtx) => {
  commandCtx.commands.register({ name: 'title', input: { hint: '<status|refresh|pin|auto>' }, handler });
});
```

命令清单：

| 命令 | 行为 | 复用的已有实现 |
|---|---|---|
| `/title status` | 返回状态快照（文本） | `describeTitleState` |
| `/title refresh` | 重新生成标题 | `ctx.sessionTitle.refresh` |
| `/title pin <text>` | 以用户身份固定标题 | `ctx.sessionTitle.rename` |
| `/title auto` | 解除固定并重新生成 | `ctx.sessionTitle.refresh`（rename 的 unpin 副作用） |

**命令的定位**：`/title` 是「在会话里直接操作」的入口，也是 Client 调 Host 的通路。菜单的固定标题项刻意**不走** `/title pin`，改用 `ctx.sessions.using(id, {}, ref => ref.binding.session.rename(title))`（理由见 §3.4.2）——命令的活会话限制让它不适合从侧边栏操作冷会话。两条路径最终都落到同一个 `sessionTitle.rename`，语义一致。

`handler` 收 `{ agent, rawInput }`，`agent` 携带 `session`。返回 `{ kind: 'success'|'error', text }`。

**关键约束：命令只能作用于活会话。** `commands.execute` 的 `agent` 参数在 wire 上是 lookup：

```text
execute(agent, line, …)  →  parameter { source: 'lookup', lookup: 'agent' }   dsh-commands/lib/typert.host.js:77-79
                         →  resolve: sessionId => this.get(sessionId)         dsh-agent/src/index.ts:273-278
                         →  get(): 只返回活着的 Agent                          dsh-agent/src/index.ts:591-593
                         →  查不到 → gateway/lookup-not-found                 dsh-api-gateway/src/index.ts:1085-1091
```

对比 `session.rename`：它走 `resolveAgent()` → `resolve()` → 冷会话会**先 resume**（`dsh-api-session-controller/src/agent.ts:152,176-186`），且 Client 侧封装会在成功后直接更新 `title` 投影、不需要打开历史（`client/sessions/manager.ts:565-568`）。

**这决定了 UI 的分流设计**（见 §3.4.2）：从侧边栏右键点中的会话，很可能正是没打开的冷会话，所以不能一律走命令。

**副作用需知**：命令生命周期会写 `command/run` 与 `command/done` 两条 log-only 事件，并在对话里渲染一行命令记录（`dsh-client-ui-chat/src/client/conversation-nodes/command.ts`）。这是框架既定行为。`recordInput: false` 只省掉 `args` 字段，`command/done` 仍在。本方案接受留痕（它是用户主动操作的可见回执，与 `/plan`、`/goal` 一致）。

#### 3.3.3 历史整理工具

现状 `backfillTitles` 只有一个整体函数：预检和写入在同一循环里，且唯一调用点是启动后 2.5 秒的 `setTimeout`（`index.js:198-202`），agent 无法触发。

拆成两段 + 一个工具：

```js
// lib/backfill.js
export async function planBackfill(ctx, deps) → { candidates: [{ id, title, reason }], skipped: […] }
export async function applyBackfill(ctx, deps, ids) → { updated, failed }
```

新增工具 `backfill_session_titles`，参数 `{ dryRun: boolean }`：

- `dryRun: true` → 只调 `planBackfill`，返回候选清单；
- `dryRun: false` → 调 `applyBackfill`，只处理用户确认过的 id。

**这是「先预览再应用」的两阶段**，符合「不可逆操作先展示」的规则。写操作仍走 `planBackfill` 的同一套跳过判据（user 标题、运行中会话、子代理），不另写一份。

#### 3.3.4 pin / unpin 正式化

现状 pin 是 `source.kind === 'user'` 的推断，无显式 API。0.2.0 不改 DSH 服务，只把已有语义显式化：在 `title-state.js` 快照里保留 `pinned` 字段，并给出两个正式入口——会话内的 `/title pin` / `/title auto` 命令，以及侧边栏菜单的「固定当前标题」（走 `ctx.sessions.using(id, {}, ref => ref.binding.session.rename(title))`）。文档明确写清「固定 = 用户标题，解除固定 = 显式 refresh」。

### 3.4 阶段 2：Client 半边

#### 3.4.1 manifest

照 `session-video-intake` 的双端形态：

```json
"exports": { ".": "./index.js", "./client": "./client.js", … },
"files": ["index.js", "client.js", …],
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-workspace"] }
}
```

`inject` 只为激活排序；实测第三方 Client 产物用 `require()` 取宿主模块（`dshmarket/client/client.js:29` 用 `require("react")`），**不得** import 任何 `@deepseek-ai/dsh-client-ui-primitives` 之类的 Harness 包（`references/practices.md:35` 明确禁止）。

#### 3.4.2 三个 slot

| 扩展点 | 内容 | 数据来源 |
|---|---|---|
| `ctx.contextMenus.register({ target: 'session' })` | 一个「会话标题 ›」二级菜单，内含四项 | 按会话状态分流，见下 |
| `sidebar.session.row.trailing` | 状态图标（自动/锁/回退） | `projectionValues.sessionTitleState` |
| `sidebar.session.row.hover` | 状态明细文本 | 同上 |

**为什么菜单不用 `sidebar.workspaces.session.menu.item`**：那是 legacy slot，渲染的是裸 React 条目，拿不到原生的行高、图标槽、快捷键位、分隔线与二级菜单行为。实测把它放在原生「重命名」「在应用中打开」之间时，四项显示成纯文本按钮，字体与内边距都不对齐。原生通路是 `ctx.contextMenus.register()`，`MenuActionView` 支持 `children`（二级菜单）、`icon`、`disabled`、`separatorBefore`、`commandId`，与「在应用中打开 ›」同一套。

**图标**：复用宿主已有的 `workspace.pin` / `workspace.markRead` / `workspace.rename` key；只有「重新生成」和「查看状态」没有对应原生图标，因此注册两个自有 key，其 path 数据从宿主图标集原样复制（16px 网格、1.2 描边），渲染时用同一套描边几何。不 require `@deepseek-ai/dsh-client-ui-primitives`——官方 `practices.md:35` 明确禁止，profile 安装也解析不到。

菜单四项与**分流规则**：

| 菜单项 | 活会话（`useSessionRetainInfo` 有引用） | 冷会话 |
|---|---|---|
| 重新生成标题 | `/title refresh`（命令） | 不可用，隐藏该项 |
| 固定当前标题 | `ctx.sessions.using(id, {}, ref => ref.binding.session.rename(title))` | `ctx.sessions.using(id, {}, ref => ref.binding.session.rename(title))` |
| 恢复自动命名 | `/title auto`（命令） | 不可用，隐藏该项 |
| 查看命名状态 | `/title status`（命令） | 读投影快照，只展示轻量字段 |

**为什么这样分流**：

- **固定标题两项都不走命令**，走 `ctx.sessions.using(id, {}, ref => ref.binding.session.rename(title))`。这条写法与宿主自己的 `renameSession` 完全一致：`ctx.sessions` 的对外面**没有** `rename`——它在 `SessionManager` 上，属于私有实现；`reference.binding.session.rename` 才是 Client 面（`SessionFace.rename`），内部调 `remote.session.rename`（Host 侧 `resolveAgent` 会 resume 冷会话）并就地更新 `title` 投影。这是四条操作里唯一对冷会话也安全的写路径。
- **重新生成/恢复自动命名必须活会话**：它们要跑 `sessionTitle.refresh` → 读消息 → 调模型，本质需要一个活 Agent。冷会话点这两项，命令会以 `gateway/lookup-not-found` 失败。与其让用户看到失败，不如判活后隐藏。
- **查看命名状态**：活会话走命令拿完整快照；冷会话只能读投影里的轻量字段（标题、来源、pin、失败类别），规则与补充来源显示为不可用。

判活用的是三个 slot 都带的标准 props `useSessionRetainInfo`（`dsh-client-ui-session/src/client/index.ts:58-70`，接受 selector）：

```js
const live = useSessionRetainInfo(sessionId, info => (info?.referenceCount ?? 0) > 0);
```

**这里要如实说明一个不确定点**：`referenceCount > 0` 表示 Client 侧有消费者持有该会话，通常等价于「打开过/正在看」，但框架文档没有承诺它与 Host 侧 `agents.get(id)` 有活 Agent 完全等价。因为它只用来控制菜单项显隐，误判的代价是「本该可用的项被藏起来」或「点了报 lookup-not-found」，不会损坏数据。阶段 2.1 会实测这两者的对应关系；若不一致，改为直接捕获 `lookup-not-found` 错误码来提示，而不是判活。

**`displayTitle` 从哪来**：菜单 slot 的 owner props 自带 `{ sessionId, displayTitle }`（`SessionRowOwnerProps`，`slots.ts:94-100`）。行尾与悬停两个 slot 的 owner props **只有** `{ sessionId }`（`slots.ts:133-142`），但它们带标准 props 里的 `useSessions`，可读 `byId[id].displayTitle`（`SessionSummary`，`client/sessions/service.ts:28-59`）。

**为什么菜单的固定项不弹输入框**：宿主自己的重命名菜单项也是「点击后进入编辑状态」（`session-actions/context-menus.tsx:52-55` → `requestSessionRename(sessionId, displayTitle)`）。本插件沿用同一交互：点击即用当前 `displayTitle` 固定，用户如需改写先用宿主的重命名。这样不重复造编辑 UI。

#### 3.4.3 图标语义

| 图标 | 条件 | 来源字段 |
|---|---|---|
| 自动 | `source === 'provider'` | `sessionTitleState.source` |
| 锁 | `pinned === true` | `sessionTitleState.pinned` |
| 回退 | `source === 'fallback'` | `sessionTitleState.source` |
| 无 | 投影缺失，或标题不是插件生成的 | `undefined` |

**为什么没有「最近失败」图标**：失败类别是进程内的观测，不是会话历史——重启后的 Harness 没有依据继续声称它，缓存值会活得比产生它的条件更久。所以它留在 Host（`diagnostics.jsonl` + `describeTitleState`），不进投影，也就不进行尾图标。「当前是临时回退标题」是**日志可推导**的事实（`session/title` 事件的 `source.kind === 'fallback'`），所以它可以进投影。

图标用内联 SVG，不依赖宿主图标库（asar 内，不可解析）。颜色只用已验证存在的主题 token（`--dsw-alias-label-tertiary`、`--dsw-alias-state-warn-primary`），不写回落色值：token 改名只会让外观退化，不会让渲染出错；而回落色值会在深色模式下变成固定颜色。

所有可见文案走 Client locale 服务（`ctx.locale.register` + `bind`），不在组件里写死中文——否则英文用户会看到中英混排。

#### 3.4.4 本地化

`locale/zh.json`、`locale/en.json` 现有只有 `meta.title`/`meta.description` 两个键。Client 侧新增文案走 `ctx.locale.register(NS, {zh, en})` + `ctx.locale.bind(NS)`，与宿主 `ui-plan` 同构（`dsh-client-ui-plan/src/client/index.ts:59-62`）。

### 3.5 阶段 3：发版

版本 `0.1.3` → `0.2.0`。语义依据：包含新功能（UI、命令、投影单元、backfill 工具）。

同步更新：`package.json` version、`CHANGELOG.md`（把 18 条 Unreleased 归入 `0.2.0`）、README 版本与安装链接、`docs/VALIDATION.md`。

---

## 4. 实施顺序

```text
阶段 0（重构，无行为变化）      ← 硬门槛：254 测试全绿
  0.1 generate → 六阶段
  0.2 title.js → title/{text,format,prompt}.js
  0.3 state.note → record，补 role-probe sessionId
  0.4 role-probe 接口收缩
  0.5 清理无消费者导出

阶段 1（Host 能力）            ← 每项可独立验证，不涉及浏览器
  1.1 projection.js 注册 wire 单元
  1.2 commands.js 注册 /title 四条
  1.3 backfill 拆预览/应用 + 工具
  1.4 pin/unpin 语义显式化

阶段 2（Client 半边）          ← 先验证最小连通性，再铺功能
  2.1 manifest + client.js 骨架 + 一个菜单项（连通性验证）
  2.2 其余三项菜单
  2.3 行尾图标
  2.4 悬停明细

阶段 3（收尾）
  文档、CHANGELOG、locale 双语
  升版本 0.2.0、打 tag、打 release
```

**2.1 是关键验证点**。它要一次性证明三件事：

1. Client 产物能被 GUI 加载并渲染（用 `dshmarket` 已证明的 `window.__ModuleLoader__.load` 形态）；
2. 菜单项点击能调到 Host（`commands.execute`）；
3. Host → Client 的状态能到位（`projectionValues`）。

三点任一失败，阶段 2 剩余部分立刻停下重估；阶段 0 与 1 的成果不受影响。

---

## 5. 验收

| 验收项 | 判定方式 | 阶段 |
|---|---|---|
| 现有测试全绿 | `npm test` = 254+ | 0 |
| 语法检查 | `npm run check` | 0 |
| 阶段函数可独立测试 | 新增测试直接对 `decidePlan`/`selectInput` 传对象，不构造 ctx | 0 |
| 投影单元被宿主接受 | 启动日志无投影注册错误；`summaryKeys()` 含新键 | 1.1 |
| 命令可执行 | `/title status` 在会话里返回快照文本 | 1.2 |
| backfill 两阶段 | `dryRun:true` 只读不写；`dryRun:false` 只改指定 id | 1.3 |
| Client 产物加载 | 插件页显示无加载失败；菜单出现 | 2.1 |
| **活/冷会话分流正确** | 冷会话右键：固定标题可用且成功；重新生成与状态查询隐藏 | 2.2 |
| **冷会话固定标题生效** | 对未打开的会话执行固定，列表标题与锁图标立即更新，无需打开会话 | 2.2 |
| 菜单四项可用 | 活会话上逐项点击，标题/图标随之变化 | 2.2 |
| 图标三态正确 | 自动/锁/失败各验证一次 | 2.3 |
| 悬停明细正确 | 摘要显示「内置规则 + N 个补充来源」 | 2.4 |
| 打包完整 | 打 tgz 后解包核对含 `client.js`、locale、icon | 3 |
| 文档一致 | README 工具数、`maxProvisionalRefinements` 语义等 §1.2 六项已修 | 3 |

---

## 6. 风险与对策

| 风险 | 依据 | 对策 |
|---|---|---|
| **命令对冷会话失败** | `commands.execute` 的 `agent` 是 lookup，只解析活 Agent（`dsh-agent/src/index.ts:273-278,591-593`）；查不到抛 `gateway/lookup-not-found`（`dsh-api-gateway/src/index.ts:1085-1091`） | 菜单按活/冷分流（§3.4.2）：固定标题走 `SessionFace.rename`（retain 会 resume），另两项判活后隐藏 |
| 判活判据不等价 | `useSessionRetainInfo` 的 `referenceCount` 是 Client 持有数，框架未承诺等同 Host 活 Agent | 只用于控制显隐，代价有界；2.1 实测，不一致则改为捕获错误码提示 |
| 投影键进不了列表行 | `summaryKeys()` 只在注册后重算；`summaryKeySet` 有缓存 | 2.1 实测确认；若失败改走 `useProjection`（需换 slot，代价高）→ 再退到悬停时才请求 |
| `commands.execute` 受 `interactions` 门禁限制 | `dsh-api-gateway/src/client/index.ts:198,229` 只对 `$stream` 与 `$on` 抛错；direct 调用无此判断 | `commands.execute` 是 direct 方法，不受限；2.1 实测确认 |
| 命令副作用污染对话流 | 每条命令写 `command/run`+`command/done` 并渲染一行 | 接受（与 `/plan`、`/goal` 一致）；文档写明 |
| Client 手写无法验证渲染 | 本轮只读源码与 slot 目录，未做渲染验证 | 2.1 用真实 GUI 验证，不做「安装即成功」的宣称 |
| 阶段 0 改变行为 | 114 行拆六段，容易漏 | 254 测试是门槛；阶段 0 单独提交、单独评审 |
| 鸭子类型 schema 被宿主拒绝 | 运行时只调 `.parse()`，无 instanceof | 低风险；2.1 一并验证 |
| `files` 漏打包 | 新增 `client.js` | 打 tgz 后核对实际文件列表 |

**一条已排除的风险**：上一轮担心的「第三方插件解析不到 asar 内包」只对当前 `link:`（symlink）安装形态成立。若将来改成 tgz 安装，`@deepseek-ai/*` 与 `zod` 经 profile 解析可命中。本方案不依赖这条差异——两个通路都只用到框架已有的 Client 服务，不 import 任何 Harness 包，因此两种安装形态都成立。

---

## 7. 按深模块标准自评

用 codebase-design 的词汇（module / interface / seam / adapter / depth）逐项检查本方案，只列需要解释的判断。

### 7.1 每个新模块的深度

| 模块 | 接口 | 背后隐藏什么 | 深度判断 |
|---|---|---|---|
| `title-runtime.js` | 一个 `generate(request)` | 六阶段编排、路由选择、重试、探针触发、诊断写入 | **深**。调用方（`index.js`）只写一行 `ctx.sessionTitle.register({ generate })` |
| `title/{text,format,prompt}.js` | 合计 18 个纯函数，但每个只有一个职责 | 字宽算法、模板编译、prompt 多语言组装 | **中**。函数多，但每个的参数简单、无状态。这里不追求深，追求可定位 |
| `projection.js` | 一个 `registerTitleProjection(ctx)` | schema 鸭子类型、`apply` 折叠、`summary` 声明、降级 | **深**。调用方不知道 projection 协议细节 |
| `commands.js` | 一个 `registerTitleCommands(ctx, deps)` | 四条命令的解析、错误归类、文本渲染 | **深**。Client 只知道 `/title <verb>` |
| `title-state.js` | 一个 `describeTitleState(input)` → 完整快照 | 失败按会话过滤、补充分离、摘要文案 | **深**。这是上一轮方案就对的形状 |

### 7.2 删除测试

- 删 `title-runtime.js`：六阶段编排会分散到 provider 与命令处理器两处，两处都要重复「读上下文 → 决策 → 选输入 → 定路由 → 组 prompt → 重试」。**赚到了。**
- 删 `projection.js`：Client 只能轮询或走命令，每次刷新标题都要一次命令调用并留痕。**赚到了。**
- 删 `commands.js`：Client 无写通路。**赚到了。**
- 删 `title/text.js` 这类纯函数拆分：复杂度不会消失，只是回到 787 行文件。**拆分是 locality，不是 leverage**，要如实说明。

### 7.3 接缝放置

两个外部接缝，都由框架提供，不是自建：

| 接缝 | 在哪 | adapter（生产） | adapter（测试） |
|---|---|---|---|
| Host → Client 状态 | `sessionProjections` | 真实注册 | 纯函数 `apply` 直接测，不需要 adapter |
| Client → Host 动作 | `commands.execute` | `/title` 命令 | 测试直接调命令 handler |

**"一个 adapter 是假设接缝，两个才是真接缝"** 的应用：`projection.js` 只有生产一个 adapter（真实 `sessionProjections`），但 `apply` 是纯函数、测试直接调用它——测试面和 `apply` 的接口一致，因此不存在「为测试造 adapter」的额外接缝。同理命令 handler 是纯函数。

### 7.4 一处不改的判断

`role-probe` 的 `ensure/verdictOf` 收缩后仍然只有两个方法，但**没有进一步合并成一个**。理由：`ensure` 是 fire-and-forget 副作用，`verdictOf` 是纯读；合并会强迫调用方区分返回值的两种含义，接口反而变宽。这是「接口小」不等于「方法少」的例子。

### 7.5 本方案没有引入的东西

- 没有为「未来可能加 Git 分支名推标题」抽 `TitleSource` 列表。上一轮方案建议过，但**当前只有一个新增来源**（委派 label），且已用 `planTitle` 的内部函数实现了。等第二个来源出现再抽。
- 没有为「未来可能换 UI 框架」造抽象层。
- 没有为投影键造配置开关。

---

## 8. 与上一版方案的差异

| 项 | 上一版（seq 4310） | 本版 | 原因 |
|---|---|---|---|
| UI 可行性 | 「typert 依赖可能不可解析，需阶段 0 探针验证」 | 已确认不需要 typert | `commands.execute` + `session.rename` 是框架已有 Remote 方法 |
| Client → Host 通路 | 计划新增 `@Remote` 服务，或退到文件轮询 | 两条已有通路按会话状态分流 | 零依赖、框架原生 |
| 命令适用面 | 未考虑 | 只能是活会话（lookup 限制） | `dsh-agent/src/index.ts:273-278` 的 lookup 只取活 Agent |
| 固定标题的实现 | 计划 `rename` Remote 或命令 | 统一 `SessionFace.rename`（经 `sessions.using`） | 唯一对冷会话安全的写路径；`ctx.sessions.rename` 在 Client 面上并不存在 |
| Host → Client 状态 | 未定（「需要 `wire.view` 或投影」） | `sessionProjections` wire 单元 | 实测运行时接受任意 key，且 schema 不需 zod |
| 新增 Host API | 三个 Remote 方法 | 零个 Remote 方法 | 命令 + 已有服务足够 |
| 阶段 0 | 不存在（直接做功能） | 必需的纯重构 | 不先拆，三项 Host 能力会全堆进 `generate()` |
| 版本号 | 待定（0.1.4 或 0.2.0） | 0.2.0 | 含新功能 |

---

## 9. 待确认

1. **命令留痕可接受吗**：`/title refresh` 会在对话里留一行命令记录（框架行为）。接受，还是改成只在会话面板里操作？
2. **悬停明细的取数**：列表行的投影只带轻量字段。完整快照（规则、补充来源）要不要在悬停时额外发一次 `/title status`？这会带来一次命令调用和一行留痕，且只对活会话可行。
3. **固定标题的交互**：沿用宿主交互（点击即用当前 `displayTitle` 固定，改写请先用宿主的重命名），还是插件自己弹一个输入框？
