# session-title-agents

English | [中文](README.zh.md) · [Catalog](../../README.md)

A configurable `[date][type] topic` title provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Dates come from session creation timestamps; the type vocabulary, template, time zone and prompt language are configurable.

## Install

Requires Node.js 22+. Tested against the installed DSH `0.2.1-rc.3` services; declared compatibility is `>=0.2.1-rc.3 <0.3.0`.

The package is `@redheartsecretman/session-title-agents`, version `0.1.0`. Install the [Release archive](https://github.com/RedHeartSecretMan/dsh-plugins/releases/download/session-title-agents-v0.1.0/session-title-agents-0.1.0.tgz) through the plugin manager (`install_bundle`) or the CLI:

```sh
dsh plugin --profile <profile> add https://github.com/RedHeartSecretMan/dsh-plugins/releases/download/session-title-agents-v0.1.0/session-title-agents-0.1.0.tgz
```

To install from a checkout instead:

```sh
git clone https://github.com/RedHeartSecretMan/dsh-plugins.git
dsh plugin --profile <profile> add /absolute/path/to/dsh-plugins/plugins/session-title-agents
```

Use `<clone>/plugins/session-title-agents` as the plugin manager's target, not the repository root.

The bundle disables the shipped `session-title-llm`. Disable other title providers too: the service accepts one provider. Follow the Host's application outcome; a restart-required result means fully quit and reopen Desktop.

## Configure

Override `id: session-title-agents` in your profile's user patch. The whole `config` object is replaced, not recursively merged; omitted fields use plugin defaults. Do not insert another provider merely to change its settings.

| Field | Default | Meaning |
|---|---|---|
| `template` | `[{date}][{type}] {topic}` | Each placeholder exactly once; order and literal separators are configurable |
| `dateFormat` | `MMDD` | Complete `YYYY`, `YY`, `MM`, `DD` tokens and `- / . _` separators; month/day required |
| `timezone` | `Asia/Shanghai` | IANA zone for the creation timestamp |
| `language` | `zh` | `zh` or `en`; selects prompt language, not translated type labels |
| `types` | Nine Chinese types | Array of strings or `{ key, hint, provisional? }` objects |
| `fallbackType` | `探索` | Local fallback type when no route is available; must exist in the vocabulary |
| `cjkSpacing` | `true` | Space between Han text and adjacent Latin letters/digits |
| `topicMinChars` | `8` | Prompt guidance; a useful short topic is not rejected just to reach this target |
| `topicMaxChars` | `18` | Unicode code-point limit for the topic |
| `provider` / `model` | unset | Supply both or neither; otherwise use the session route |
| `maxInputBytes` | `4096` | Final framed JSON UTF-8 byte budget, including escaping and wrapper text |
| `maxOutputTokens` | `64` | Output cap; uses the model's lowest supported reasoning effort |
| `timeoutMs` | `60000` | Deadline for one candidate-route attempt |
| `maxProvisionalRefinements` | `4` | Legacy semantics: refine within the first N eligible human messages, **not a rewrite counter** |
| `backfill.enabled` | `false` | Run one historical maintenance pass after startup |
| `backfill.fallbackRoute` | unset | `{ provider, model }`; also the backup for ordinary title requests |
| `backfill.retitle` | `[]` | Targets `[{ id, hint }]`, executed only while backfill is enabled |

Legacy aliases remain supported: `maxExploreRefinements` and top-level `retitle`. Supplying conflicting aliases or unknown keys produces an activation error rather than silently discarding settings.

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

The default Chinese vocabulary is 功能, 设计, 修复, 优化, 发布, 运维, 探索, 文档, 研究. `探索` is provisional. A canonical concrete title with the correct creation date is retained; provisional titles refine within the message-count limit. Model output is leniently normalized, but stored titles require canonical syntax and the correct date, so malformed legacy dates are not frozen as settled.

## Model errors and ownership

The provider handles `text-delta`, completed `block-end` text and terminal `finish` events. Only a normal `stop` result can be accepted. Error, cancellation, truncation and tool-call partial output never become titles. Failed calls or parsing try a distinct backup route, then reject so Harness retains the current title or its built-in fallback. With no available route, a local title can be derived from the first message.

Harness suppresses automatic updates to user-pinned titles. An **explicit UI refresh** intentionally unpins them. Backfill always skips user titles, even a configured retitle target. Auxiliary calls use the built-in `session/title-llm-request` record; diagnostic files do not contain title, prompt or raw model text.

## Backfill and state

Backfill is off by default. When enabled, it starts once after 2.5 seconds. `sessionQuery.readSession` performs read-only eligibility checks before resuming anything. It skips subagents, pinned titles, canonical titles, interrupted historical turns and currently running agents. Targeted retitles can rewrite canonical provider titles, once per exact id/hint.

A candidate's title must be accepted and acknowledged by `sessions.flush()` before completion is recorded. Failures remain retryable. Only handles created by the pass are disposed. Plugin unload cancels its timer and aborts/drains running maintenance; ordinary prompts never repeatedly force a configured retitle hint.

With `DSH_PROFILE_DIR` set:

```text
$DSH_PROFILE_DIR/state/session-title-agents/backfill-state.json
$DSH_PROFILE_DIR/state/session-title-agents/backfill.log
```

Otherwise use `$DSH_HOME/profiles/$DSH_PROFILE/state/session-title-agents/`, or the legacy `$DSH_HOME/session-title-agents/` only when there is no profile. `DSH_HOME` defaults to `~/.dsh`.

Exclusive locks, atomic replacement and recoverable queues protect bookkeeping across activations/processes. Corrupt state is surfaced and preserved. Lock waits are bounded; locks are never stolen. After an abnormal process exit, remove a leftover `.lock` only after confirming that no writer is active. Diagnostic logs rotate at 512 KiB with one bounded backup; logging failures do not change title/bookkeeping success.

## Development

No dependencies or build step:

```sh
cd plugins/session-title-agents
npm test
npm run check
```

Tests use isolated temporary directories, including multi-process state updates, flush failure, read-only backfill preflight and unload cancellation. `scripts/verify-runtime.mjs <runtime-root>` additionally checks the installed SessionStore, projections, title service and Cordis lifecycle; ASAR installs require Electron's Node carrier. Its LLM adapter is stubbed, so this is a runtime-contract check rather than a provider availability test.

See [validation and behavior boundaries](docs/VALIDATION.md) for checked contracts and limits.

## License

MIT.
