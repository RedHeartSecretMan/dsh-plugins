# 独立发布流程

本仓库的每个插件**独立版本、独立发布**。目标是：改一个插件时，不连累另一个插件的版本、tag 和 Release。

## 核心约定

| 项目 | 规则 |
| --- | --- |
| 版本 | 每个插件在自己的 `package.json` 里独立维护，例如两个插件都可以是 `0.1.0` |
| tag | `<plugin>-v<version>`，例如 `session-video-intake-v0.1.0`；前缀避免两个插件同名 tag 冲突 |
| Release | 每个 tag 对应一个 Release，资产名 `<plugin>-<version>.tgz` |
| 变更范围 | 一次提交只改一个插件；一次发布只处理一个插件 |
| 基线例外 | 0.1.0 基线整理时两个插件共享同一个基线提交；从下一个版本起，tag 指向对应插件的 release 提交 |
| 不改不发布 | 未改动的插件不 bump 版本、不重发、不刷新 Release 资产 |

## 先确认谁变了

```bash
git fetch --tags
node tools/status.mjs
```

`--json` 会输出同样的信息，便于脚本消费。

输出会列出每个插件当前版本、最近 tag，以及自该 tag 以来是否有提交。只有显示有变更的插件才需要发布。

## 发布单个插件

当前基线是 `0.1.0`；下面以发布**下一个 patch** `0.1.1` 为例：

```bash
cd plugins/session-video-intake

# 1. 验证
npm run check
npm test

# 2. 只改这个插件的版本
#    package.json: version
#    README.md / README.zh.md: 安装版本与资产链接
#    docs/VALIDATION.md: 当前发布版本
#    CHANGELOG.md: 顶部新增一条
cd ../..

# 3. 提交范围只包含目标插件
git add plugins/session-video-intake
git commit -m "release(session-video-intake): v0.1.1"
git push origin main

# 4. 打 tag 并推送；工作流会自动验证、打包并创建 Release
git tag session-video-intake-v0.1.1
git push origin session-video-intake-v0.1.1
```

推送 tag 后，`.github/workflows/release-plugin.yml` 会：

1. 从 tag 解析插件名与版本，校验 `package.json` 版本一致；
2. 在该插件目录运行 `npm run check` 与 `npm test`；
3. `npm pack` 并重命名资产为 `<plugin>-<version>.tgz`；
4. 创建 Release；如果 Release 已存在（例如先手动创建），则覆盖上传资产。

等待工作流成功后，核对 Release 资产即可，不再需要手动执行 `gh release create`。

如果工作流不可用（例如 Actions 被禁用），仍可手动发布：

```bash
cd plugins/session-video-intake
npm pack --pack-destination /tmp
mv /tmp/redheartsecretman-session-video-intake-0.1.1.tgz /tmp/session-video-intake-0.1.1.tgz
gh release create session-video-intake-v0.1.1 \
  /tmp/session-video-intake-0.1.1.tgz \
  --repo RedHeartSecretMan/dsh-plugins \
  --title "session-video-intake 0.1.1" \
  --notes "本次变更摘要"
```

本机 profile 使用 `link:` 安装时，**只改版本不需要重装**；只有包名或目录路径变化时才需要在该 profile 里执行 `pnpm install`。

如果 `origin` 指向代理或镜像而不是 `github.com`，`gh` 可能无法推断仓库，命令里要显式带 `--repo`（上面的示例已经带上）；推送时优先使用 SSH remote。

## 版本怎么升

- `patch`：文案、图标、内部修复、测试。
- `minor`：新增能力或配置项，行为向后兼容。
- `major`：破坏性变更（重命名、配置不兼容、移除能力）。

## 不要做的事

- 不要因为发布 A 插件而顺手 bump B 插件。
- 不要移动或重建已发布的 tag 去“刷新资产”——需要更新内容就升一个 patch 版本（一次性基线整理除外）。
- 不要把多个插件的发布塞进同一个 `release(...)` 提交。
- 不要删除旧 Release 来“整理版本”；历史版本用于回装，确实需要清理时单独确认。

## 发布检查清单

- [ ] `git fetch --tags && node tools/status.mjs` 确认只有目标插件有变更
- [ ] 目标插件 `npm run check` 与 `npm test` 通过
- [ ] 只改了目标插件的版本、README、验收文档和 CHANGELOG
- [ ] `release(<plugin>): vX` 提交只包含目标插件目录
- [ ] tag 指向该提交，`release-plugin` 工作流成功并上传了 `<plugin>-<version>.tgz`
- [ ] `node tools/status.mjs` 显示目标插件 `unchanged`

## 发布工作流

- `plugin-checks.yml`：可复用的插件测试矩阵（Ubuntu/Windows × Node 22/24），两个插件各有一个轻量 caller。
- `release-plugin.yml`：tag push（`*-v*`）时自动校验版本、跑测试、打包并创建/更新 Release。
- `repo-checks.yml`：检查 tools 语法、相对链接/anchor 与版本引用一致性。

新增插件时复制一个 caller workflow，并把 `plugin` 换成新插件目录名即可。
