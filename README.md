# dsh-plugins

English | [简体中文](README.zh-CN.md)

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Each one is an installable bundle that lives in its own directory under [`plugins/`](plugins/) and works independently of the others.

## Catalog

| Plugin | What it does | Install path |
|---|---|---|
| [session-title-template](plugins/session-title-template/) | Template-shaped session titles with a preset type vocabulary, CJK spacing, optional AGENTS naming guidance and backfill, plus rename/refresh tools. | `plugins/session-title-template` |
| [session-video-intake](plugins/session-video-intake/) | Handles video input per model capability: native `video_url` when supported, a scene-aware storyboard fallback for image-only models, and an explicit failure otherwise. No extra provider. | `plugins/session-video-intake` |

## Install a plugin

Every plugin here is a DSH **bundle**: its `package.json` declares `dsh.bundle.patch`, so installing it once applies to the whole profile and survives restarts.

```bash
git clone https://github.com/RedHeartSecretMan/dsh-plugins.git
```

Then, in DeepSeek Harness, use `plugin_manager` with the `install_bundle` action and the absolute path of the plugin's directory as `target`:

```
<clone>/plugins/session-title-template
<clone>/plugins/session-video-intake
```

Pass the plugin directory, not the repository root: the root is a catalog, and has no bundle of its own.

Read each plugin's own README before installing. Some of them change or disable a shipped default, and say so at the top.

## Layout

```
dsh-plugins/
├─ plugins/
│  ├─ session-title-template/     one self-contained bundle
│  │  ├─ package.json            name, exports, dsh.bundle.patch, icon
│  │  ├─ cordis.patch.yml        the loader patch this bundle applies
│  │  ├─ index.js                Host plugin entry
│  │  ├─ lib/                    plugin modules (Node builtins or public SDK helpers)
│  │  ├─ locale/                 plugin-manager title and description
│  │  ├─ test/                   node:test suites
│  │  └─ README.md               behaviour, configuration, caveats
│  └─ session-video-intake/       another self-contained bundle
├─ .github/workflows/           plugin checks, automated releases and repository checks
├─ tools/status.mjs             which plugin changed since its last release
├─ tools/check-links.mjs        relative Markdown link and anchor checker
├─ tools/check-versions.mjs     release URL / version consistency checker
├─ docs/RELEASING.md             the independent per-plugin release process
├─ README.md
└─ LICENSE
```

Each plugin directory is self-contained: no shared runtime code and no build step; the repository-level helpers are `tools/status.mjs`, `tools/check-links.mjs` and `tools/check-versions.mjs`. Copying one directory out of this repository gives you a working plugin, which is why a plugin can be published to npm or cloned on its own without dragging the catalog along.

## Adding a plugin

Create `plugins/<name>/` with its own `package.json` carrying `dsh.bundle.patch`, a `cordis.patch.yml`, an entry module, `locale/` metadata, and a README. Add a `.github/workflows/<name>.yml` caller that uses the reusable `plugin-checks.yml` workflow with `plugin: <name>`. Then add a row to the catalog table above. There is no registry file to update and no root manifest to edit: the repository root stays a catalog, so a new plugin cannot break an existing one.

## Releasing

Each plugin is versioned and released independently, under its own `<plugin>-v<version>` tag. Run `node tools/status.mjs` to see which plugin changed since its last tag; only that plugin needs a version bump and a release. The full process is in [docs/RELEASING.md](docs/RELEASING.md).

## License

MIT, per plugin. See each plugin's `LICENSE` reference in its own directory; the repository-level [LICENSE](LICENSE) covers the catalog itself.
