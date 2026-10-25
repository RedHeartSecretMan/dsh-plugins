# dsh-plugins

English | [中文](README.zh.md)

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Each one is an installable bundle that lives in its own directory under [`plugins/`](plugins/) and works independently of the others.

## Catalog

| Plugin | What it does | Install path |
|---|---|---|
| [session-title-agents](plugins/session-title-agents/) | Names every session as `[date][type] topic`, with a controlled type vocabulary, CJK spacing, and optional historical backfill. | `plugins/session-title-agents` |

## Install a plugin

Every plugin here is a DSH **bundle**: its `package.json` declares `dsh.bundle.patch`, so installing it once applies to the whole profile and survives restarts.

```bash
git clone https://github.com/RedHeartSecretMan/dsh-plugins.git
```

Then, in DeepSeek Harness, use `plugin_manager` with the `install_bundle` action and the absolute path of the plugin's directory as `target`:

```
<clone>/plugins/session-title-agents
```

Pass the plugin directory, not the repository root: the root is a catalog, and has no bundle of its own.

Read each plugin's own README before installing. Some of them change or disable a shipped default, and say so at the top.

## Layout

```
dsh-plugins/
├─ plugins/
│  └─ session-title-agents/     one self-contained bundle
│     ├─ package.json           name, exports, dsh.bundle.patch, icon
│     ├─ cordis.patch.yml       the loader patch this bundle applies
│     ├─ index.js               Host plugin entry
│     ├─ lib/                   pure modules, no Harness imports
│     ├─ locale/                plugin-manager title and description
│     ├─ test/                  node:test suites
│     └─ README.md              behaviour, configuration, caveats
├─ README.md
└─ LICENSE
```

Each plugin directory is self-contained: no shared runtime code, no workspace tooling, no build step. Copying one directory out of this repository gives you a working plugin, which is why a plugin can be published to npm or cloned on its own without dragging the catalog along.

## Adding a plugin

Create `plugins/<name>/` with its own `package.json` carrying `dsh.bundle.patch`, a `cordis.patch.yml`, an entry module, `locale/` metadata, and a README. Then add a row to the catalog table above. There is no registry file to update and no root manifest to edit: the repository root stays a catalog, so a new plugin cannot break an existing one.

## License

MIT, per plugin. See each plugin's `LICENSE` reference in its own directory; the repository-level [LICENSE](LICENSE) covers the catalog itself.
