# session-video-intake 验证范围与行为边界

当前发布：`0.1.1`。验证环境包括安装版 DSH `0.2.1-rc.3`、`0.2.1-rc.5` 与 `0.2.2-rc.1`、pi-ai `1.1.0`、FFmpeg `9.0.2`，以及应用运行时 Node `24.21.0`。当前安装包为 [session-video-intake 0.1.1](https://github.com/RedHeartSecretMan/dsh-plugins/releases/download/session-video-intake-v0.1.1/session-video-intake-0.1.1.tgz)。

## 已验证的契约

| 范围 | 核对内容 |
|---|---|
| 配置 | 默认值物化并冻结；`videoRoutes` 未设置与显式 `[]` 语义不同；未知顶层/子字段、非法 `provider/model`、重复路由和越界整数都在激活时失败；`null` 等同于缺省；FFmpeg 路径按配置、环境变量、Homebrew、裸命令的顺序解析；`enabled: false` 时不安装任何 host hook、中间件或路由，且不要求 `llm.fileRequestText` |
| 能力来源 | 显式 `videoRoutes` 优先且不触发探测；未设置时使用目录探测；`catalogProbe.enabled: false` 时不探测；图片能力仍来自 `inputModalities`；provider 无法挂载 payload 钩子时视为不可注入，并在路由前以 `VIDEO_UNSUPPORTED` 失败 |
| 目录探测 | 只对 OpenAI 兼容路由请求 `{baseURL}/models`；`modalities.input`/`input_modalities` 中出现 `video` 才算支持；条目缺失、字段缺失、非 200、网络异常、无 baseURL、非 OpenAI 协议都返回“未知”；凭证优先 credentials 服务、其次同名环境变量；正负结果都缓存，TTL 与 `clear()` 生效 |
| 路由 | 原生视频和仅图片路由都保持用户选择的 provider/model；普通消息不改变路由对象；带视频历史的后续轮次仍会重新校验；多 agent 状态隔离 |
| payload 投影 | 原视频以完全相同的字节和容器 MIME 进入 `video_url`（Completions）或 `input_video`（Responses）；仅图片路由得到 manifest + `image_url`（Completions）或 `input_image`（Responses）；未知形状以 `VIDEO_SDK_UNSUPPORTED` 失败；无视频请求完全透传；非视频附件不读取字节 |
| 输入识别 | 只处理用户来源的视频文件和裸 HTTP(S) 链接；Markdown、代码段、引号内链接、assistant/tool 文本和非 MP4/WebM 文件保持原样 |
| 限制与完整性 | 单文件、累计和数量上限在读取或发送前生效；容器签名、字节数和 SHA-256 均校验；取消在读取、构建和发送阶段都生效 |
| storyboard | 时长解析、格数上下限、等分区间清单、网格参数、PNG 原样返回、临时目录清理；FFmpeg 缺失/执行失败/探测失败/取消分别映射为明确错误码 |
| 场景规划 | 64×36 HSV 低帧率扫描、速率阈值、切点聚类与间隔抑制、内容段生成、合并/拆分到目标格数；切点少于 2 个时静止回退 4 格，扫描不可用时按时长回退；取消传播；真实素材（合成三场景）识别出 2 个切点并走场景分配 |
| 默认 runner | 真实子进程检查 stdout、stderr 截断、超时终止、取消终止和 ENOENT 保留 |
| 客户端 | 拖放、粘贴、文件选择的事件转发；克隆 File 去掉宿主路径但保留字节、名称和类型；非视频文件不接管 |
| 安装版 SDK | 原生：`video_url` 与原始 **1,128,375 bytes** 完全一致；仅图片：真实 FFmpeg 生成 storyboard，payload 无 `video_url` 且有 PNG + 清单；纯文本模型：失败而非发送文件路径；`listProviders()` 仅含既有 provider |
| 卸载与生命周期 | 钩子按 adapter 拓扑重挂；卸载恢复原始 `streamSimple`；agent hook 随 agent 创建/销毁安装与移除 |
| 命名与资源 | 包名为 `@redheartsecretman/session-video-intake`，插件 id 与包名一致；显示名称由 locale 提供为“会话视频输入”；发布包包含 icon、locale、NOTICE 和运行脚本 |

单元与回归测试共 97 项，运行 `npm test` 获取当前结果；`npm run check` 对全部入口和脚本执行语法检查。

`scripts/verify-runtime.mjs` 进一步接入实际安装的 Harness。它通过应用自带运行时加载 ASAR 内 SDK，挂载真实的 `LlmRuntime`、`pi-ai` 适配器与本地附件存储；模型网关是本地 HTTP/SSE 替身，因此不验证外部模型的实时网络、凭据或配额。storyboard 使用真实 FFmpeg/FFprobe，缺失时跳过该段。该检查显式固定 `videoRoutes`，所以不触发目录探测；探测行为由 `test/catalog.test.js` 注入 `fetch` 覆盖。

`scripts/verify-gateway.mjs` 是可选的真实网关检查，默认关闭；它需要 `RUN_SESSION_VIDEO_LIVE=1`、测试素材、网关地址和凭证。2026-11-05 已对本地 Magpie 网关的 `zhipu/glm-5.3-flash` 实测通过：原生视频附件得到工具调用，裸视频 URL 得到回答；`openai-completions` 与 `openai-responses` 两种路径均已实测，该检查不进入 CI。

实际启用状态应从当前 Host 的插件清单核对；安装命令成功本身不等于当前进程已经切换。

## 行为边界

- 只有 `VIDEO_UNSUPPORTED` 属于能力判定结果。认证、缺少凭证、限流、传输、服务端、超时和取消错误都原样传播，不触发任何回退。
- 宿主没有 video 模态：`inputModalities` 词表只有 text/image，pi-ai 也没有视频输入类型。因此原生视频不能从宿主元数据推断，只能来自显式白名单或后端目录声明。
- 目录探测不是标准能力。普通 OpenAI/vLLM 的 `/v1/models` 不声明 modalities，探测结果会是“未知”；即使声明了 video，也只说明后端模型能力，不代表当前 route 一定接受 `video_url`。需要精确控制时使用 `videoRoutes`。
- 目录探测只覆盖 OpenAI 兼容协议；使用其他协议的 provider 不会被探测，也不影响其图片路径。
- 探测失败、超时、401 或无凭证只会让结果未知，不会阻塞请求，也不会改变错误语义；探测缓存包含否定结果，默认 5 分钟后过期。
- 图片能力也依赖 provider 可注入的 payload 结构；不能挂载钩子的 provider 虽然可能声明图片输入，仍会明确失败而不是发送文件句柄。
- storyboard 是采样近似：快速运动、闪烁、连续运镜会丢失细节，音频不转写；4–9 格与 256 px 默认宽度是清晰度和 token 成本的折中。
- 分镜图只进入当前请求，不写入会话日志；后续追问依赖会话中仍保留的原视频附件重新投影，因此每次都会重新构建（同一请求内按附件去重）。
- 裸链接交给 FFmpeg 直接读取，不下载到附件库；来源不限于本地文件，读取行为受 FFmpeg 自身的协议支持与超时约束。
- 容器判定基于文件内容签名，不信任扩展名；`.mov`、Matroska、伪造扩展名的文件都会被拒绝。
- 场景检测是启发式：HSV 低分辨率扫描识别硬切较可靠，叠化、渐变、强运动/闪烁可能漏检或误检；扫描以固定低帧率采样，切点时间有约一个采样间隔的误差。目录声明与切点识别都不构成画面语义保证。
- 场景检测增加一次全片低分辨率解码（约 4 fps 的 64×36 画面），长视频会明显增加构建耗时；超时由 `storyboard.timeoutMs` 约束，失败则回退等分。
- storyboard 思路参考 `dsh-video-storyboard`，本插件为独立实现，未复制上游代码；细节见 [NOTICE](../NOTICE)。
- 未重跑真实 GUI 页面验收；客户端结论来自 VM 测试与既有 composer 行为。
- 未验证超大视频（`maxVideoBytes` 上限内）和极长视频的 FFmpeg 耗时分布；单次调用由 `storyboard.timeoutMs` 保护。

## 复现入口

- [配置测试](../test/config.test.js)
- [目录探测测试](../test/catalog.test.js)
- [场景规划测试](../test/scenes.test.js)
- [payload 测试](../test/payload.test.js)
- [路由测试](../test/router.test.js)
- [storyboard 测试](../test/storyboard.test.js)
- [客户端测试](../test/client.test.js)
- [安装版 SDK 验收](../scripts/verify-runtime.mjs)
- [真实网关验收](../scripts/verify-gateway.mjs)
