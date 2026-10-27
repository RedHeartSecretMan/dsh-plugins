# session-title-agents 验证范围与行为边界

当前发布：`0.2.2`。验证环境包括已安装的 DSH `0.2.1-rc.3` 及其真实 Cordis、SessionStore、投影和标题服务。当前安装包为 [session-title-agents 0.2.2](https://github.com/RedHeartSecretMan/dsh-plugins/releases/download/session-title-agents-v0.2.2/session-title-agents-0.2.2.tgz)。

## 已验证的契约

| 范围 | 核对内容 |
|---|---|
| 模型流 | 只接受正常 stop；错误、取消、token 截断和工具调用中的部分文本不成为标题；支持最终 text block 和不同备用路由 |
| 标题格式 | 日期取自创建时间；已有标题要求规范格式和正确日期；模型输出可宽容处理括号、Markdown 包裹和省略日期 |
| 模板与字符 | 占位符恰好一次且可辨识；字段重排、后缀和字面美元文本可往返；截断按 Unicode 码点计算 |
| 输入预算 | 按最终 JSON 框架的 UTF-8 字节计算，包含转义；优先保留首条和最新消息 |
| 配置 | 字段、路由成对、词表和占位符校验；支持配置别名并拒绝冲突或未知字段；`agentsInstructions` 仅接受 boolean `enabled` 和 `256` 至 `65536` 整数 `maxBytes`，解析结果独立冻结 |
| AGENTS 发现 | 懒加载内置 `@deepseek-ai/dsh-agent-instructions` 的公开 helper 并支持 profile 回退解析；只处理 `AGENTS.md`、`AGENTS.local.md`，按全局 `DSH_HOME`、`DSH_AGENTS_HOME` 及默认 `.git` 根目录至当前工作目录范围发现 |
| AGENTS 提取 | 中文“会话/对话”与“命名/标题”组合或英文 session/conversation 与 naming/title 组合标题；忽略围栏代码块标题；支持显式 `session-title-agents:start/end` 注释标记 |
| AGENTS 预算与失败 | 仅命名片段进入最终 UTF-8 补充预算，优先保留更具体作用域；源读取有界、软超时；无规则、SDK 或读取失败沿用原有命名行为 |
| 命名归属 | 插件负责自动命名；补充指导不覆盖模板、创建日期、类型、长度和手动固定；主代理协调允许用户明确改名，`enabled: false` 同时关闭指导与协调 |
| 历史维护 | 先只读检查；跳过手动标题、子代理、运行中及未结束轮次；只释放本次创建的句柄 |
| 持久化 | 标题被接受并 flush 成功后才记完成；失败保留重试机会；跨进程并发更新不丢标记 |
| 状态与卸载 | 按 profile 隔离；原子写入和有界锁等待；错误后队列可恢复；卸载取消定时器并等待维护退出 |
| 命名与资源 | 包名为 `@redheartsecretman/session-title-agents`；自有标识和显示名称一致；发布包包含全部运行资源 |

单元与回归测试使用隔离临时目录，覆盖 AGENTS 指令片段和配置边界；状态测试包含两个真实子进程并发写入。运行 `npm test` 获取当前测试总数和结果，`npm run check` 包含 `lib/instructions.js` 的语法检查。

`scripts/verify-runtime.mjs` 进一步接入实际安装的 DSH 服务，核对被接受的标题、provider 来源、辅助请求事件和消息来源标记、AGENTS 补充指导与命名协调、定稿保留、手动标题以及卸载。该契约检查使用 LLM 适配器替身，不验证外部模型的实时网络、凭据或配额。已改用正式 profile resolver，不再人工映射 SDK。使用真实工具注册器、标题服务与文件 durability listener 检查显式刷新、当前会话改名、取消在飞生成、flush/read-back 和卸载；该 listener 不是生产 writer，未验证其重启恢复。

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
- 独立诊断日志不写标题、提示词或模型原文；标准辅助请求事件包含实际请求内容以支持追溯。
- 状态保存在 profile 中，安装包可替换；个人配置、hint 和状态不进入公开仓库。

## 0.2.1 新增验收

- 截断回退跨过第 4 条消息仍可恢复；Host 再次截断的无模型回退可恢复。
- 自动生成不根据事件先后或用户消息中的“重命名”文字强制刷新；明确刷新通过专用工具标记，成功或失败后标记清理。
- 改名工具仅接收 title，刷新工具不接收参数；拒绝跨会话参数、无 agent、失效会话与取消调用。
- 改名固定标题、取消在飞生成；两个工具均确认 flush 与读回，不通过直接文件改写修改生产会话。
- SDK peers 由正式 linked-profile resolver 解析，诊断只包含故障类别；普通 Node 单测无需安装整套 Harness。

## 0.2.2 新增验收

- `session/title-llm-request` 记录的消息来源固定为 `dsh-session-title-llm`，与会话格式 v4 还原校验的 `titleSources` 契约一致；不再写入插件自身名称。
- 回归测试断言追加事件的 `data.messages[0].source.kind`；该字段回退会使历史会话在下一次冷加载时被判定为日志损坏。
- 插件不迁移历史事件：已经写入错误来源的会话日志需要单独修复后才能重新打开，本插件不提供自动迁移。

