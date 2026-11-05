# dsh-plugins

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件集合。每个插件都是可独立安装的 bundle，放在 [`plugins/`](plugins/) 下各自的目录里，彼此不依赖。

## 插件目录

| 插件 | 作用 | 安装路径 |
|---|---|---|
| [session-title-template](plugins/session-title-template/) | 按预设模板自动命名会话标题：预设类型分类、中英文自动空格，可选 AGENTS 命名指导与历史回填，并提供改名/刷新工具。 | `plugins/session-title-template` |
| [session-video-intake](plugins/session-video-intake/) | 按当前模型能力处理视频：原生支持则发 `video_url`，仅支持图片则生成场景感知的 storyboard 分镜图，两者都不支持则明确失败；不注册额外 provider。 | `plugins/session-video-intake` |

## 安装

这里的每个插件都是 DSH **bundle**：`package.json` 声明了 `dsh.bundle.patch`，安装一次即对该 profile 全部生效，并跨重启保留。

```bash
git clone https://github.com/RedHeartSecretMan/dsh-plugins.git
```

然后在 DeepSeek Harness 里用 `plugin_manager` 的 `install_bundle` 动作，把插件目录的绝对路径作为 `target` 传入：

```
<clone>/plugins/session-title-template
<clone>/plugins/session-video-intake
```

注意传的是**插件目录**，不是仓库根目录——根目录是索引，本身不含 bundle。

安装前请先读该插件自己的 README。部分插件会改动或禁用内置默认项，这类影响都写在它 README 的开头。

## 目录结构

```
dsh-plugins/
├─ plugins/
│  ├─ session-title-template/     一个自包含的 bundle
│  │  ├─ package.json            名称、exports、dsh.bundle.patch、图标
│  │  ├─ cordis.patch.yml        本 bundle 应用的 loader 补丁
│  │  ├─ index.js                Host 插件入口
│  │  ├─ lib/                    插件模块（Node 内置或公开 SDK helper）
│  │  ├─ locale/                 插件页显示用的标题与描述
│  │  ├─ test/                   node:test 测试
│  │  └─ README.md               行为、配置与注意事项
│  └─ session-video-intake/       另一个自包含的 bundle
├─ .github/workflows/           插件检查、自动发布与仓库检查
├─ tools/status.mjs             查看哪个插件自上次发布后有改动
├─ tools/check-links.mjs        相对 Markdown 链接与 anchor 检查
├─ tools/check-versions.mjs     发布 URL / 版本引用一致性检查
├─ docs/RELEASING.md            独立发布流程
├─ README.md
└─ LICENSE
```

每个插件目录都是自包含的：没有共享运行时代码、没有构建步骤；仓库级提供 `tools/status.mjs`、`tools/check-links.mjs` 与 `tools/check-versions.mjs` 三个辅助工具。单独拷走一个目录就能用，所以插件可以独立发布到 npm 或单独克隆，不必带上整个索引。

## 新增插件

新建 `plugins/<名称>/`，包含自己的 `package.json`（带 `dsh.bundle.patch`）、`cordis.patch.yml`、入口模块、`locale/` 元数据和 README，然后在上面的目录表里加一行，并添加一个引用可复用 `plugin-checks.yml` 的 `.github/workflows/<名称>.yml`。没有注册表文件要改，也没有根 manifest 要动：仓库根始终是索引，因此新增插件不会影响已有插件。

## 发布

每个插件独立版本、独立发布，tag 格式为 `<plugin>-v<version>`。运行 `node tools/status.mjs` 查看哪些插件自上次 tag 后有改动；只有变化的插件需要升版本和发布。完整流程见 [docs/RELEASING.md](docs/RELEASING.md)。

## 许可证

各插件均为 MIT。插件目录内自带 `LICENSE` 引用；仓库级 [LICENSE](LICENSE) 覆盖索引本身。
