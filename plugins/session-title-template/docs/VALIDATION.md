# session-title-template 验证范围与行为边界

当前发布：`0.2.0`。验证环境包括已安装的 DSH `0.2.1-rc.3`、`0.2.2-rc.1`、`0.2.2-rc.2` 与 `0.2.3-alpha.2` 及其真实 Cordis、SessionStore、投影和标题服务。当前安装包为 [session-title-template 0.2.0](https://github.com/RedHeartSecretMan/dsh-plugins/releases/download/session-title-template-v0.2.0/session-title-template-0.2.0.tgz)。

## 已验证的契约

| 范围 | 核对内容 |
|---|---|
| 模型流 | 只接受正常 `stop`；错误、取消、token 截断和工具调用中的部分文本不成为标题；支持最终 text block 和不同备用路由 |
| 标题格式 | 日期取自会话创建时间；已有标题要求规范格式和正确日期；模型输出可宽容处理括号、Markdown 包裹和省略日期 |
| 自动刷新 | 不是每轮调用：短确认/继续跳过；显式刷新/重命名、fallback/recovery、非规范标题、provisional 窗口内新实质消息、明确换题、低词面重合与周期审计触发评估；provisional 超过 `maxProvisionalRefinements` 后平滑交回低词面重合与周期审计；同一消息水位不重复评估 |
| 当前标题稳定性 | currentTitle 始终进入 prompt 与 JSON 输入，带 canonical 标志；模型按稳定性规则原样返回仍准确的标题；仅主任务实质变化时改写；显式 refresh/retitle 优先；同标题返回保留 provenance |
| 模板与字符 | 占位符恰好一次且可辨识；字段重排、后缀和字面美元文本可往返；截断按中文等效字宽与分词/分句边界计算 |
| 重试与失败归类 | 每轮按顺序遍历全部候选路由，健康备用路由立即接管；解析失败或输出截断不会在同一轮向同一模型重复请求；轮间指数退避，`retryAttempts`（1–5）与 `retryDelayMs`（0–10000）有界；输入预算不足属确定性失败只试一次；取消立即中止且不写失败日志；失败类别按 Harness 错误码归类（`SESSION_TITLE_TIMEOUT` / `TITLE_TOOL_OUTPUT` / `max-tokens`），不依赖 provider 报错文本 |
| 子代理命名 | 仅当会话自身 origin 为 subagent 时读取 `subagent/descriptor` 的 label；fork 种子里继承的 descriptor 被忽略；label 按与模型输出相同的规范化规则渲染；label 缺失回落到消息来源 |
| 标题状态快照 | 一次查询返回内置规则、补充来源数量与清单、当前标题来源与固定状态、未恢复的最近失败类别（含 `timeout`、`output-truncated` 等全部 7 类建议与时间）、探针结论；内置与补充分离，不包含 provider 原文，且在更晚的成功生成后自动消除过时告警 |
| 角色能力探测 | 每个候选路由（含 fallbackRoute）各探测；每个 provider/model 至多一次成功判定；传输失败最多尝试 3 次后保持未判定；精确 token 匹配判为 supported，答非所问判为 unsupported；超时、取消和传输失败保持未判定；只写诊断日志，不改路由、不改 profile；卸载等待有界宽限期 |
| HTTP 状态与刷新路由 | owner 鉴权的 `GET /session-title-template/status`（同时支持活会话与经 `sessionQuery` 只读的冷会话）与 `POST /session-title-template/refresh`（活会话无痕刷新），不向对话流追加命令块，错误分类返回且不泄漏异常正文 |
| 失败诊断 | `title-call-failed` 只记录 `route`、`attempt n/总数`、provider 错误码和本地失败类别；不写标题、提示词、响应或原始错误文本 |
| 输入预算 | 按最终 JSON 框架的 UTF-8 字节计算，包含 currentTitle anchor、转义和包装；优先保留首条和最新消息 |
| 配置 | 字段、路由成对、词表和占位符校验；拒绝未知字段和已移除的旧别名 `maxExploreRefinements` / 顶层 `retitle`；`agentsInstructions` 仅接受 boolean `enabled` 和 `256` 至 `65536` 整数 `maxBytes`，解析结果独立冻结 |
| AGENTS 发现 | 插件自带发现；读取适用的 `AGENTS.md`，范围包括全局目录与从 `.git` 根逐层到当前工作目录；按 realpath 去重 |
| AGENTS 提取 | 中文“会话/对话”与“命名/标题”组合或英文 session/conversation 与 naming/title 组合标题；忽略围栏代码块标题；支持显式 `session-title-template:start/end` 注释标记 |
| AGENTS 预算与失败 | 仅命名片段进入最终 UTF-8 补充预算，优先保留更具体作用域；源读取有界、软超时；无规则、发现或读取失败沿用原有命名行为，并记录有界诊断类别 |
| 命名归属 | 插件负责自动命名；补充指导不覆盖模板、创建日期、类型、长度和手动固定；主代理协调允许用户明确改名，`enabled: false` 同时关闭指导与协调 |
| 辅助请求记录 | `session/title-llm-request` 的消息来源固定为 `dsh-session-title-llm`，与会话格式 v4 的 `titleSources` 校验一致；插件不迁移历史错误事件 |
| 工具 | `rename_current_session` 只接收 title，`refresh_current_session_title` 与只读的 `describe_current_session_title` 不接收参数；拒绝跨会话目标、无 agent、失效会话与取消调用；两个写工具确认 flush 与读回，只读工具不写盘 |
| 历史维护 | 预览与应用分离：`planBackfill` 只读列出候选，`applyBackfill` 只处理确认过的 id，并在应用时重新检查资格；跳过手动标题、子代理、运行中及未结束轮次；只释放本次创建的句柄。`backfill_session_titles` 工具默认只预览，缺 ids 时拒绝写入 |
| 持久化 | 标题被接受并 flush 成功后才记完成；失败保留重试机会；跨进程并发更新不丢标记 |
| 状态与卸载 | 结构化诊断写入 `diagnostics.jsonl`（有界、逐字段截断）； 按 profile 隔离；原子写入和有界锁等待；错误后队列可恢复；卸载取消定时器并等待维护退出 |
| 命名与资源 | 包名为 `@redheartsecretman/session-title-template`，插件 id 与包名一致；显示名称由 locale 提供为“会话标题模板”；发布包包含全部运行资源 |

单元与回归测试共 336 项，另加 20 项 Client 检查，使用隔离临时目录，覆盖 AGENTS 指令片段、配置边界、标题解析与截断边界、工具参数、命令语法、只读状态与无痕刷新路由、投影折叠、历史维护两阶段和状态并发；状态测试包含两个真实子进程并发写入。运行 `npm test` 获取当前结果（它同时运行 `scripts/verify-client.mjs`），`npm run check` 对所有入口和脚本执行语法检查。

`scripts/verify-client.mjs` 按 Web carrier 的方式加载 `client.js`：用 React 替身执行模块注册，然后检查插件导出的 `inject`、行尾/悬浮/弹窗三个 UI slot 与四个自有图标 key 的注册、原生 `contextMenus` 贡献（含 `observe` 响应订阅、`target: 'session'` 与「会话标题 ›」三子项结构）、中英词典键集一致、固定标题走 Session 引用而非不存在的 `sessions.rename` 且在已固定或尚无标题时禁用、固定当前与行尾已固定图标共用四角框定星芒图标而非复用置顶会话的图钉、悬浮窗使用 hovercard 语义色 token 且空状态不渲染、点击查看状态优先走只读 HTTP 路由直接消费结构化 `snapshot`（支持冷会话与英文全量本地化，结构化错误不误回落，切页或关闭时中止在飞请求，回落文本解析器不误判以 `来源：` 开头的标题）、点击自动生成优先走无痕 `POST` 刷新路由并直接提示详细结果与错误，以及每个组件的一次渲染。它验证形状与注册，不验证视觉呈现；真实 GUI 渲染仍需在本机核对。

`scripts/verify-runtime.mjs` 进一步接入实际安装的 DSH 服务，核对被接受的标题、provider 来源、辅助请求事件和消息来源标记、AGENTS 补充指导与命名协调、定稿保留、手动标题以及卸载。该契约检查使用 LLM 适配器替身，不验证外部模型的实时网络、凭据或配额。使用正式 profile resolver 加载自包含的 linked package，不依赖未声明的 Harness SDK peer。使用真实工具注册器、标题服务与文件 durability listener 检查显式刷新、当前会话改名、取消在飞生成、flush/read-back 和卸载；该 listener 不是生产 writer，未验证其重启恢复。

本项在 DSH `0.2.3-alpha.2` 上实测通过（退出码 0）。为让它跟上该版本，脚本修正了两处过时假设：`working-directory/change` 已更名为 `workspace-root/change`（`workingDirectory` 现在是 `workspace-root/change` 投影）；角色探针是独立的纯指令请求，不携带命名指导，因此调用计数与 AGENTS 标记断言只针对标题请求。运行方式：`npm run verify:runtime`。

`test/verify-gateway.mjs` 是可选的真实网关检查，默认关闭；它需要 `RUN_SESSION_TITLE_LIVE=1`、网关地址和凭证，使用真实 `LlmRuntime`、`pi-ai` 适配器和真实标题服务生成一次标题，只校验格式、provider 和模型来源。2026-11-05 已对本地 Magpie 网关的 `auto/deepseek-flash` 实测通过；工具注册与提示词协调仍由 `verify-runtime.mjs` 覆盖，该 live 检查不进入 CI。

实际启用状态应从当前 Host 的插件清单核对；安装命令成功本身不等于当前进程已经切换。

## 行为边界

- `maxProvisionalRefinements` 是已总结暂定标题的前 N 条合格用户消息阈值，不是成功改写次数计数器；可识别的首句回退不受此窗口限制。
- AGENTS 规则仅作为主题措辞和暂定细化的补充，不能覆盖模板、创建日期、类型词表、长度约束或用户固定；只提取命名片段，不注入整份工程指令，也不修改 AGENTS 文件。
- AGENTS 文件不做文件系统缓存，不持续监听；仅在需要生成时重新读取。文件发生变化不会单独触发现有规范定稿 provider 标题重新生成。
- `agentsInstructions.enabled` 默认为 `true`，`maxBytes` 默认为 `4096`；关闭后不读取补充指导，也不添加命名协调段。协调段是 `systemPrompt` 指导，不阻断重命名 API；完整覆盖系统提示词的部署可能不包含该段，用户明确改名仍可执行。
- DSH 没有独立 no-op 返回协议。保留原标题时返回同一标题，Host 仍可能追加同值标题事件。
- 自动生成由 DSH 保护手动标题；`refresh_current_session_title` 明确绕过自动稳定性并有意解除固定。当前 SDK 不传递触发原因，内置 GUI refresh 仍可能保留已总结标题。历史维护始终跳过手动标题。
- `topicMinChars` 只作为提示词目标；`topicMaxChars` 会执行截断。标题还受 Host 的 `maxTitleBytes` 限制。
- 有路由但请求或解析失败时，由 DSH 保留已有标题或内置兜底；完全没有路由时可生成本地格式化兜底。
- 定点 hint 仅在开启历史维护时执行，按 id 和完全相同的 hint 去重；普通消息不会反复强制改名。
- 状态损坏不会被当作空进度覆盖。锁不会按时间被抢占；异常退出留下的锁需确认没有活动 writer 后再清理。
- 独立诊断日志只写路由、尝试轮次、provider 错误码和本地失败类别，不写标题、提示词、响应或原始错误文本；标准辅助请求事件仍包含实际请求内容以支持追溯。
- 状态保存在 profile 中，安装包可替换；个人配置、hint 和状态不进入公开仓库。

## 复现入口

单元与回归测试共 25 个文件，全部由 `npm test` 运行：

- [标题解析与格式测试](../test/title.test.js)
- [标题生成阶段测试](../test/title-runtime.test.js)
- [标题规划测试](../test/title-plan.test.js)
- [子代理命名规划测试](../test/title-plan-delegation.test.js)
- [状态快照测试](../test/title-state.test.js)
- [配置测试](../test/config-regression.test.js)
- [刷新策略测试](../test/refresh-policy.test.js)
- [AGENTS 指令测试](../test/instructions.test.js)
- [AGENTS 本地发现测试](../test/instructions-local.test.js)
- [提示词指导测试](../test/guidance-prompt.test.js)
- [模板后缀测试](../test/template-suffix.test.js)
- [插件行为测试](../test/plugin.test.js)
- [失败重试测试](../test/retry.test.js)
- [角色探测测试](../test/role-probe.test.js)
- [子代理标签测试](../test/delegation.test.js)
- [改名工具测试](../test/rename.test.js)
- [命令测试](../test/commands.test.js)
- [命令语法与文案测试](../test/title-command.test.js)
- [只读状态路由测试](../test/status-route.test.js)
- [状态投影测试](../test/projection.test.js)
- [历史维护测试](../test/backfill.test.js)
- [历史维护预览测试](../test/backfill-plan.test.js)
- [历史维护工具测试](../test/backfill-tool.test.js)
- [状态测试](../test/state.test.js)
- [结构化记录测试](../test/records.test.js)

脚本与外部契约检查：

- [安装版 SDK 验收](../scripts/verify-runtime.mjs)
- [Client 半边验收](../scripts/verify-client.mjs)
- [真实网关标题生成](../test/verify-gateway.mjs)
