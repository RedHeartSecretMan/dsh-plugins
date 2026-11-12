# session-video-intake

[English](README.md) | 简体中文 · [插件目录](../../README.zh-CN.md)

插件按你**当前选中的模型**决定视频怎么交给它：

| 当前路由 | 处理方式 |
| --- | --- |
| 原生支持视频 | 原视频以 `video_url` 发送 |
| 只支持图片 | 生成 storyboard 分镜图，连同时间清单一起发送 |
| 两者都不支持 | 发请求前明确失败 |

插件不注册 provider，也不会替换你选择的路由。

判断“原生支持视频”需要额外信息：DSH 的模型元数据只有 `text` / `image`，没有 `video`。所以插件先看显式 `videoRoutes` 白名单；没有配置时，才去读 provider 的模型目录，看当前模型是否声明了 `video`。两者都没有答案时，按图片处理。

## 安装和兼容性

需要 Node.js 22 或更新版本；storyboard 回退需要可用的 FFmpeg/FFprobe。已有能力匹配的本地构建会直接复用；只有所有本地候选都不具备分镜能力时，才下载固定版本的 LGPL managed FFmpeg/FFprobe。已在安装版 DSH `0.2.1-rc.3`、`0.2.1-rc.5`、`0.2.2-rc.1` 与 `0.2.2-rc.2` 上验证，声明支持 `>=0.2.1-rc.3 <0.6.0`。

包名为 `@redheartsecretman/session-video-intake`，当前版本为 `0.1.2`。在插件管理中通过 `install_bundle` 安装 [Release 压缩包](https://github.com/RedHeartSecretMan/dsh-plugins/releases/download/session-video-intake-v0.1.2/session-video-intake-0.1.2.tgz)，或使用 CLI：

```sh
dsh plugin --profile <profile> add https://github.com/RedHeartSecretMan/dsh-plugins/releases/download/session-video-intake-v0.1.2/session-video-intake-0.1.2.tgz
```

包内带一个 `postinstall` 钩子：解析 FFmpeg，仅在没有合格的本地构建时才下载托管版本。会拦截安装脚本的包管理器会跳过它——pnpm 报 `ERR_PNPM_IGNORED_BUILDS` 并以非零码退出，但包本身已装好。不执行该钩子不影响使用，第一次生成分镜时会重做同样的解析；只有希望下载发生在安装阶段才需要放行。

也可以从仓库目录安装：

```sh
git clone https://github.com/RedHeartSecretMan/dsh-plugins.git
dsh plugin --profile <profile> add /absolute/path/to/dsh-plugins/plugins/session-video-intake
```

插件管理的安装目标为 `<clone>/plugins/session-video-intake`，不要选择仓库根目录。升级后按 Host 的结果重载；要求重启时需完全退出并重新打开 Desktop。

## 配置

在 profile 的用户 patch 中覆盖 `id: session-video-intake`。整个 `config` 对象会被替换而不是递归合并；省略字段使用插件默认值，未知字段会直接导致激活失败，不会被静默忽略。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 设为 `false` 时不安装能力检查、payload 改写和路由钩子；输入框接管仍会加载，视频按 DSH 普通文件处理 |
| `videoRoutes` | 未设置 | 原生 `video_url` 的显式 `provider/model` 白名单。未设置表示“从模型目录探测”；`[]` 表示完全关闭原生视频。model 段可以包含 `/` |
| `catalogProbe.enabled` | `true` | 仅在 `videoRoutes` 未设置时使用的目录探测 |
| `catalogProbe.timeoutMs` | `2500` | 单次目录请求的超时（`200`–`10000`） |
| `catalogProbe.ttlMs` | `300000` | 探测结果缓存时长（`10000`–`3600000`） |
| `maxOutputTokens` | `32768` | 视频请求的输出上限；普通请求不受影响 |
| `maxVideoBytes` | `67108864` | 单个视频的字节上限，在读取附件前检查 |
| `maxTotalVideoBytes` | `67108864` | 原生视频请求的累计字节上限 |
| `maxVideos` | `8` | 单次请求的视频数量上限 |
| `storyboard.enabled` | `true` | 设为 `false` 时仅图片路由直接失败，不生成分镜 |
| `storyboard.sceneAware` | `true` | 检测场景切点并按内容分段分配格子；`false` 使用等分区间 |
| `storyboard.cells` | `9` | 网格最大格数（`4`–`16`）；短视频至少 4 格 |
| `storyboard.cellEdge` | `256` | 单格宽度像素（`64`–`1024`） |
| `storyboard.timeoutMs` | `120000` | 单次 FFprobe/FFmpeg 调用的超时 |
| `storyboard.ffmpegPath` / `ffprobePath` | 自动探测 | 显式路径优先且不静默替换。否则探测 `SESSION_VIDEO_FFMPEG`、`$DSH_HOME/tools/ffmpeg/bin`、profile/Homebrew/PATH；只有都不具备分镜能力时才下载固定版本 LGPL managed 包 |

确定某条路由接受 `video_url` 时可以显式固定，或彻底关闭原生视频：

```yaml
- id: session-video-intake
  config:
    videoRoutes:
      - magpie/zhipu/glm-5.3-flash
    # 或：videoRoutes: []
    storyboard:
      cells: 6
      cellEdge: 320
```

## FFmpeg 选择

插件不假设某个固定 FFmpeg 版本：

1. 显式 `storyboard.ffmpegPath` 权威；能力不足时直接报错，不静默换其他二进制。
2. 否则依次探测 `SESSION_VIDEO_FFMPEG`、`$DSH_HOME/tools/ffmpeg/bin`、profile tools、Homebrew/`/usr/local/bin`、裸 `ffmpeg`。
3. 只有 ffprobe 可用，且构建报告 `image2`、`scale`、`tile`、`mjpeg` 时才接受。
4. 第一个合格候选直接使用，不下载。支持 glob 时以 glob 作为首选的**图片输入方式**；遇到不支持 glob 的构建，自动改用 image2 序列并缓存选择。两者只是读取同一组零填充帧文件的方式不同，不是两种分镜算法：抽帧、场景规划、格时间、网格布局和 tile filter 完全一致。
5. 只有所有本地候选都不合格时，才下载固定版本 LGPL FFmpeg/ffprobe 到 `$DSH_HOME/tools/ffmpeg/managed/`；安装时尽力而为，首次分镜再重试，离线时插件仍可安装。见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 输入来源

视频输入在模型看到之前统一归一化：

| 来源 | 处理 |
|---|---|
| 拖放、粘贴、浏览器文件选择 | pathless `File` 上传，成为持久视频 `file` 块 |
| 桌面 `+` 文件选择 | 稳定结构选择器转发 pathless `File`，不再变成 `@路径` 文本引用 |
| `@/绝对路径.mp4` / Windows 路径 / UNC | 宿主读取文件、存为持久附件并替换引用 token |
| `file://` 本地 URI | 与 `@` 相同的物化路径 |
| 带支持后缀的裸 HTTP(S) URL | 捕获，按原生视频或 storyboard 处理 |
| 直接视频 `file` 块 | 按扩展名或 `video/*` mediaType 识别 |

默认支持 MP4、WebM、MOV、MKV、M4V、AVI、TS/MTS/M2TS、FLV、3GP、OGV。看起来像视频但无法物化的引用会以 `VIDEO_UNSUPPORTED_INPUT` 明确失败，不会静默当普通文本。

## 工作方式

```text
视频消息
  ↓
客户端接管：无宿主路径的 File 变成 DSH durable attachment
  ↓
agent/request：解析当前 provider/model 能力；两者都不支持则在此失败
  ↓
llm/stream：在 core 文件投影前捕获原始 FileBlock / 裸 URL
  ↓
provider 的 onPayload：
  ├─ 原生视频 → 替换成 video_url
  └─ 仅图片   → 生成 storyboard，替换成 manifest + image parts
  ↓
模型流式回复
```

- [client.js](client.js)：只转发现有 composer 的拖放、粘贴和文件选择事件；克隆视频 `File` 去掉 Electron 宿主路径，保留全部字节与元数据。
- [lib/capability.js](lib/capability.js)：按 provider/model 解析 `video` / `image` / `injectable`，adapter 拓扑变化时清空缓存。
- [lib/catalog.js](lib/catalog.js)：执行失败安全的模型目录探测并缓存结果。
- [lib/router.js](lib/router.js)：在 `prepareCall()` 前校验能力；普通消息完全不触碰路由。
- [lib/capture.js](lib/capture.js)：在核心把 FileBlock 投影成文件句柄前记录视频块与裸 URL。
- [lib/request-scope.js](lib/request-scope.js)：把记录结果绑定到当前请求的流。
- [lib/native-video.js](lib/native-video.js)：把校验后的附件构造成 `data:` URL。
- [lib/attachment.js](lib/attachment.js)：原生视频与 storyboard 共用的字节数和 SHA-256 校验。
- [lib/rewrite-tokens.js](lib/rewrite-tokens.js)：两种 payload 形状共用的 token 替换。
- [lib/payload.js](lib/payload.js)：payload 形状与 provider 钩子；按能力选择原生视频或 storyboard 图片。Completions 与 Responses 两种形状都支持原生视频和 storyboard：Completions 使用对象形式的 `video_url`，Responses 使用字符串形式 `video_url` 的 `input_video`。未知形状以 `VIDEO_SDK_UNSUPPORTED` 失败，而不是静默降级或误报“没有媒体能力”。
- [lib/storyboard.js](lib/storyboard.js)：FFprobe 探测、FFmpeg 采样并拼成一张 PNG，生成中文时间清单。
- [lib/failure.js](lib/failure.js)：统一错误前缀与 code；[lib/defaults.js](lib/defaults.js)：storyboard 默认值的唯一来源。
- [lib/config.js](lib/config.js)：校验 profile 配置并解析 FFmpeg 路径。

原始 FileBlock 从不改写；storyboard 只进入当前请求，不写入会话日志。后续追问会重新投影，因为会话里仍保留原视频附件。

## 判定顺序

插件只回答两个问题：当前路由能不能原生收视频，能不能收图片。

1. **图片能力**：宿主元数据 `inputModalities` 是否包含 `image`。
2. **原生视频能力**：宿主没有这个信息，按顺序取——
   - 配置了 `videoRoutes` 就只信它，不再探测；
   - 没配置时才读 provider 的模型目录，当前模型条目声明了 `video` 才算支持。

| 情况 | 行为 |
| --- | --- |
| `videoRoutes` 命中当前路由 | 原生 `video_url` |
| `videoRoutes` 未命中，或写成 `[]` | 不探测，按图片能力处理 |
| `videoRoutes` 未配置，目录声明 `video` | 原生 `video_url` |
| `videoRoutes` 未配置，目录没声明或探测失败 | 按图片能力处理 |
| 图片也不支持 | `VIDEO_UNSUPPORTED` |

还有一个前提：provider 必须暴露 pi-ai profile 结构，payload 钩子才挂得上去。挂不上时无法注入视频或分镜图片，会直接失败，而不是把文件路径当成视频内容发送。

只有 `VIDEO_UNSUPPORTED` 是能力判定结果。认证失败、缺少凭证、限流、网络错误、服务端错误、超时和取消都原样传播，不触发回退。

## 目录探测

- 只查**当前会话选中的模型**：请求 provider 的 `{baseURL}/models`，只读 `id` 与当前 `model` 相同的那一条。其他条目会被忽略，也不会据此切换模型。
- 只对 OpenAI 兼容、`baseURL` 为 `http(s)` 的路由生效；其他协议保持“未知”，按图片处理。
- 凭证先走宿主 credentials 服务，再用 provider profile 指定的环境变量。缺失或被拒绝只让结果“未知”，不会影响请求。
- 结果按 `provider/model` 缓存 `catalogProbe.ttlMs`，包括否定结果；adapter 拓扑变化时与能力缓存一起清空。
- `modalities` 不是 OpenAI 标准字段。原生 OpenAI 和普通 vLLM 目录通常不声明它，所以没有显式白名单时，多数路由会走 storyboard。
- 目录声明只代表后端模型能力，不代表这条路由一定接受 `video_url`；需要精确控制时仍用 `videoRoutes`。

## Storyboard 回退

- FFprobe 读取时长、分辨率和是否有音频；无法得到可用时长时报 `VIDEO_STORYBOARD_PROBE_FAILED`。
- 开启 `sceneAware` 时，FFmpeg 以低帧率解码 64×36 RGB 画面，用 HSV 三通道差得到逐帧分数，再按“每秒切点速率”反推阈值得到候选切点；切点组成内容段，经过合并/拆分对齐格数，每格取段中心。
- 因此静止长镜头用 4 个等分格，不重复同一画面占满格数；快剪片段会得到更短的段，而不是统一等分。
- 场景检测切点少于 2 个时，静止回退使用 4 个等分格；检测被关闭或不可用时，才按时长回退到 `clamp(ceil(duration / 4), 4, cells)` 个等分格。
- 输出一张 PNG；清单包含文件名、时长、网格、每格时间区间，并说明这是采样分镜而非连续视频。
- 缺少可执行文件报 `VIDEO_STORYBOARD_UNAVAILABLE`；执行失败报 `VIDEO_STORYBOARD_FAILED`；仅图片路由禁用回退时报 `VIDEO_STORYBOARD_DISABLED`。这些情况都不会静默退化成纯文本。
- FFmpeg 运行前校验字节数和 SHA-256；临时目录始终清理，取消或超时的进程会被终止。

## Storyboard 思路来源

storyboard 做法参考 [dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard)：低分辨率 HSV 场景扫描、按速率反推切点阈值、按内容分段分配格子、一张可索引的宫格图。本插件为独立实现，范围更窄，未复制上游代码；采用与未采用清单见 [NOTICE](NOTICE)。

## 范围与限制

- storyboard 是近似采样：场景检测本身是启发式，快速运动、闪烁和连续运镜会丢失细节，音频不会转写。
- 分镜图固定为 PNG；裸 HTTP(S) 链接交给 FFmpeg 直接读取，不写入附件库。
- 支持 MP4 和 WebM；本地文件会校验容器签名、字节数和 SHA-256。
- 裸链接必须是 HTTP(S) 且路径以 `.mp4`/`.webm` 结尾；Markdown 链接、代码段和引号内链接保持文本。
- 挂载 provider 内部结构是有意取舍：profile 只保留自己的路由。若未来 SDK 移除 pi-ai profile 结构，插件会明确失败而不是猜测。
- payload 钩子覆盖当前已装适配器产生的两种 OpenAI 兼容形状。原生视频写入 Chat Completions `messages` 的 `video_url` 或 Responses `input` 的 `input_video`；未知形状以 `VIDEO_SDK_UNSUPPORTED` 失败，而不是静默降级。

## 开发

无需安装依赖，也没有构建步骤：

```sh
cd plugins/session-video-intake
npm test
npm run check
```

`npm test` 覆盖配置、目录探测、场景规划、payload、路由、客户端和 storyboard。storyboard 单元测试注入假 runner 保证确定性，同时验证真实 runner 的 stdout、stderr 截断、超时和取消处理。

`scripts/verify-runtime.mjs` 检查安装版 Harness：ASAR 安装需要 Electron 的 Node 载体和 FFmpeg，并通过 `VIDEO_FIXTURE_ROOT` 读取测试素材：

```sh
VIDEO_FIXTURE_ROOT=/path/to/fixtures \
ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' scripts/verify-runtime.mjs
```

它覆盖三条路径：原生 `video_url` 字节一致、仅图片路由得到真实 storyboard、纯文本路由明确失败，并断言没有注册第二个 provider。该测试显式固定路由，因此不触发目录探测；探测行为由 [test/catalog.test.js](test/catalog.test.js) 注入 `fetch` 覆盖。

`scripts/verify-gateway.mjs` 是可选的真实网关检查，需要 `RUN_SESSION_VIDEO_LIVE=1`、`SESSION_VIDEO_FIXTURE`、`SESSION_VIDEO_GATEWAY` 和可用凭证；`SESSION_VIDEO_API` 可选 `openai-completions`（默认）或 `openai-responses`。

```sh
RUN_SESSION_VIDEO_LIVE=1 SESSION_VIDEO_FIXTURE=/path/to/clip.mp4 \
SESSION_VIDEO_GATEWAY=http://127.0.0.1:3425/v1 SESSION_VIDEO_MODEL=zhipu/glm-5.3-flash MAGPIE_GATEWAY_KEY=... \
ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' scripts/verify-gateway.mjs
```

校验范围与行为边界见 [docs/VALIDATION.md](docs/VALIDATION.md)。

## 许可证

[MIT](LICENSE)
