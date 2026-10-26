# session-title-agents

[English](README.md) | 中文 · [插件目录](../../README.zh.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 生成 `[日期][类型] 主题` 格式的标题。日期取自会话创建时间；类型、模板、时区和提示词语言都可配置。提供仅针对当前会话的改名和重新生成工具。

```text
[1025][修复] 排查登录超时
[1025][功能] 新增导出 PDF 能力
[1025][探索] 了解网关设置含义
```

## 安装和兼容性

需要 Node.js 22 或更新版本；在 DSH `0.2.1-rc.3` 的真实 SessionStore、标题服务和 Cordis 生命周期上验证过。声明支持 `>=0.2.1-rc.3 <0.6.0`，不对更高版本的内部接口作保证。

包名为 `@redheartsecretman/session-title-agents`，当前版本为 `0.2.1`。在插件管理中通过 `install_bundle` 安装 [Release 压缩包](https://github.com/RedHeartSecretMan/dsh-plugins/releases/download/session-title-agents-v0.2.1/session-title-agents-0.2.1.tgz)，或使用 CLI：

```sh
dsh plugin --profile <profile> add https://github.com/RedHeartSecretMan/dsh-plugins/releases/download/session-title-agents-v0.2.1/session-title-agents-0.2.1.tgz
```

也可以从仓库目录安装：

```sh
git clone https://github.com/RedHeartSecretMan/dsh-plugins.git
dsh plugin --profile <profile> add /absolute/path/to/dsh-plugins/plugins/session-title-agents
```

插件管理的安装目标为 `<clone>/plugins/session-title-agents`，不要选择仓库根目录。

安装会禁用内置 `session-title-llm`。标题服务同时只接受一个提供方；其他第三方标题提供方也应先停用。是否热生效取决于 Host 的重载能力，安装结果要求重启时请完整退出并重新打开桌面版。

## 配置

通过 profile 的用户补丁覆盖 `id: session-title-agents` 的 `config`。**用户补丁中的 `config` 是整块替换，不是递归合并**；未提供字段使用下表默认值。不要为覆盖配置再插入一个同名 provider。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `template` | `[{date}][{type}] {topic}` | 三个占位符必须各出现一次，可调整顺序和字面分隔符 |
| `dateFormat` | `MMDD` | `YYYY`、`YY`、`MM`、`DD`；支持 `- / . _` 分隔符，必须有月、日 |
| `timezone` | `Asia/Shanghai` | 按创建时间计算日期的 IANA 时区 |
| `language` | `zh` | `zh` 或 `en`，只选择提示词语言，不自动翻译词表 |
| `types` | 9 类中文词表 | 字符串，或 `{ key, hint, provisional? }` 对象数组 |
| `fallbackType` | `探索` | 无可用路由时的本地回退类型，必须在词表内 |
| `cjkSpacing` | `true` | 中文与相邻英文字母、数字之间补空格 |
| `topicMinChars` | `8` | 提示词目标下限；不为凑长度拒绝简短有效主题 |
| `topicMaxChars` | `18` | 按 Unicode 码点安全截断主题 |
| `provider` / `model` | 未设置 | 必须同时填写，否则跟随会话路由 |
| `maxInputBytes` | `4096` | **最终 JSON 框架文本**的 UTF-8 字节上限，含转义和包装 |
| `maxOutputTokens` | `4096` | 请求输出上限；选择模型支持的最低推理档位；上限包含隐藏推理 token，标题字数另行校验 |
| `timeoutMs` | `60000` | 每个候选路由的一次请求时限 |
| `maxProvisionalRefinements` | `4` | 已总结暂定标题仅在前 N 条合格消息内细化，**不是改写次数计数器**；可识别回退始终可重试 |
| `agentsInstructions.enabled` | `true` | 读取适用的 AGENTS 命名片段并添加主代理命名协调；`false` 同时关闭两者 |
| `agentsInstructions.maxBytes` | `4096` | 最终补充指导文本的 UTF-8 字节上限，必须是 `256` 至 `65536` 的整数 |
| `backfill.enabled` | `false` | 启动后执行一次历史维护 |
| `backfill.fallbackRoute` | 未设置 | `{ provider, model }`；同时是普通标题请求的备用路由 |
| `backfill.retitle` | `[]` | 定点重命名列表 `[{ id, hint }]`，仅在启用回填时执行 |

保留兼容别名：`maxExploreRefinements` 对应 `maxProvisionalRefinements`，顶层 `retitle` 对应 `backfill.retitle`。同一配置同时提供新旧字段且值冲突会报错。未知字段也会报错，不再静默忽略。

### 英文方案

```yaml
- id: session-title-agents
  config:
    template: '[{date}] {type}: {topic}'
    dateFormat: YYYY-MM-DD
    language: en
    cjkSpacing: false
    types:
      - { key: feat, hint: New capability }
      - { key: fix, hint: Bug fixes }
      - { key: explore, hint: Understanding current behaviour, provisional: true }
    fallbackType: explore
```

默认词表为功能、设计、修复、优化、发布、运维、探索、文档、研究。`探索` 带 `provisional: true`。已有**日期正确、格式规范**的具体类型标题会保留；已经总结过的暂定标题在消息数上限内继续细化。本地首句截断回退（含旧版本标记为 provider 的回退，以及被 Host 字节上限再截断且没有模型来源的回退）不受该窗口限制，路由恢复后继续尝试。保留标题时也保留已有模型来源。模型输出可宽容解析全角括号、缺日期和 Markdown 包裹，但已有标题使用严格校验，错误日期不会被当作“已定稿”。

## AGENTS 命名指导

插件继续负责自动命名。在需要生成标题或细化暂定标题时，读取适用的 `AGENTS.md` 和 `AGENTS.local.md` 中的命名片段。通过懒加载使用 Harness 内置 `@deepseek-ai/dsh-agent-instructions` SDK 的公开发现 helper，通过声明可选 SDK peer 使用 Harness 的正式 profile resolver，使外部 linked 安装也能解析到内置 SDK；不安装第二套 Harness。该 helper 先发现 `DSH_HOME`、`DSH_AGENTS_HOME` 下的全局 `AGENTS.md`，随后按默认 `.git` 根目录到当前工作目录的范围查找项目文件；不读取其他指令文件名。这里使用 Host 可见路径和 SDK 默认的基础指令链，不复刻远端文件系统或主代理因文件操作额外发现的更深作用域。

Markdown 段落标题需同时包含“会话”或“对话”与“命名”或“标题”，或同时包含 session 或 conversation 与 naming 或 title，才会提取对应片段。英文匹配不区分大小写，忽略围栏代码块中的标题。也可用以下标记明确指定命名片段：

```markdown
<!-- session-title-agents:start -->
优先用简短主题概括用户当前的任务。
<!-- session-title-agents:end -->
```

只把命中的命名片段加入补充提示，不注入无关的工程指令。`agentsInstructions.maxBytes` 限制最终补充文本的 UTF-8 字节数，优先保留作用域更具体的片段。源文件读取有大小上限，发现流程设软超时；没有命中规则、SDK 或读取失败以及超时，均沿用现有命名行为。仅在需要生成时重新读取，不缓存文件内容，也不持续监听。修改文件本身不会触发现有规范定稿 provider 标题重新生成。

AGENTS 规则可以影响主题措辞和暂定标题细化，但不能覆盖配置的模板、创建日期、类型词表、主题长度限制或手动标题固定状态。新增的 `systemPrompt` 协调段要求主代理在只有常驻 AGENTS 规则要求改名时，把自动命名交给插件；用户明确要求改名时调用 `rename_current_session`，不要把任务交回 GUI。这段内容是指导，不会阻断重命名 API；完全替换系统提示词的部署可能不包含该段。设置 `agentsInstructions.enabled: false` 会同时关闭补充片段和协调段。插件不会修改 AGENTS 文件。

## 模型失败和标题归属

处理 DSH 的 `text-delta`、`block-end` 和终止 `finish` 事件。只有正常 `stop` 结果可以采纳；错误、取消、token 截断和工具调用中的部分文本不会成为标题。调用或解析失败时尝试不同的备用路由；仍失败则由 DSH 保留现有标题或其内置回退。没有模型路由时可以从首条消息生成本地回退。

DSH 会阻止普通自动请求覆盖手动标题。界面的**显式刷新**有意解除这个固定状态。历史回填即使指定了 `retitle` 也跳过手动标题。辅助模型请求记录到 DSH 内置的 `session/title-llm-request` 事件，普通诊断日志不写入标题、提示词或模型原文。

## 明确改名与重新生成

Host 在工具服务可用时向所有 agent preset 注册两个默认排他执行的工具；关闭 `agentsInstructions` 不会关闭工具：

| 工具 | 参数 | 行为 |
|---|---|---|
| `rename_current_session` | `title` | 调用正式 `sessionTitle.rename()`，取消在飞自动生成并固定标题 |
| `refresh_current_session_title` | 无 | 明确绕过自动稳定性保护，调用正式 `sessionTitle.refresh()` 重新生成；有意解除手动固定 |

目标只从 `execution.agent.session` 取得，不接受会话 id；拒绝无 agent、非 live session 和多余字段。两个工具都在 flush 成功并读回核对后报告已保存。落盘失败会明确说明内存可能已改变；同一个已固定标题的改名重试不重复写事件。工具走 Harness 正常执行策略，不声明只读或绕过权限。

当前已验证的 Harness provider 请求不包含自动/手动刷新原因，所以不根据事件序号或用户文字猜测意图。**需要强制重新生成时使用 `refresh_current_session_title`**；内置 GUI refresh 仍可能被已总结标题的自动稳定性保护保留。首次/回退标题恢复不受此限制。后续 SDK 若提供明确触发原因，应再接入内置刷新。

升级后按 Host 的重载结果生效；现有进程要求重启时完整退出再打开。修改代码或安装包本身不代表当前会话工具列表已更新。

## 历史维护和状态

回填默认关闭。启用后延迟 2.5 秒运行一次；先通过 `sessionQuery.readSession` 只读检查，再处理候选会话：

- 跳过子代理、手动标题、已规范标题和尚未闭合的历史轮次；
- 跳过当前正在运行的 agent；定点重命名允许重写已规范的 provider 标题；
- 仅为候选历史会话恢复 agent，结束后释放自己创建的句柄；
- 成功接受标题且 `sessions.flush()` 确认持久化后，才记完成标记；失败可重试；
- `retitle` 按会话 id 和完全相同的 hint 去重，不会借普通消息反复执行；
- 禁用、卸载或重载插件会清理定时器，中止并等待维护任务退出。

有 `DSH_PROFILE_DIR` 时，状态位于：

```text
$DSH_PROFILE_DIR/state/session-title-agents/backfill-state.json
$DSH_PROFILE_DIR/state/session-title-agents/backfill.log
```

没有该变量时使用 `$DSH_HOME/profiles/$DSH_PROFILE/state/session-title-agents/`；连 profile 也未指定时才使用旧的 `$DSH_HOME/session-title-agents/`。`DSH_HOME` 默认 `~/.dsh`。

状态文件采用独占锁、原子替换和可恢复写队列；损坏的状态不会被当作空进度覆盖。锁等待有界且不偷锁；进程异常退出留下 `.lock` 时，应确认没有活动写入者后再清理。日志保留最多 512 KiB 和一份同上限备份；日志失败不影响记账。

## 开发和验证

无须安装依赖、无构建步骤；可选 AGENTS 功能使用 Harness 内置 SDK 的公开 helper：

```sh
cd plugins/session-title-agents
npm test
npm run check
```

测试全部使用临时目录，包括 AGENTS 发现、片段提取与字节限制、配置校验、命名协调、两个进程并发写入、失败落盘后重试、只读回填预检和卸载取消。`scripts/verify-runtime.mjs <runtime-root>` 可进一步接入已安装的真实 DSH 服务；ASAR 安装需通过 Electron 的 Node carrier 执行。它通过真实 profile linked-peer resolver、工具注册器和标题服务验证发现/刷新/改名；LLM 和磁盘 durability listener 是 fixture，不等同于外部模型可用性或完整生产 writer 的重启恢复测试。

[验证范围与行为边界](docs/VALIDATION.md)说明已核对的契约及使用限制。

## 许可证

MIT。
