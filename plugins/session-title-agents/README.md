# session-title-agents

English | [中文](README.zh.md) · [Catalog](../../README.md)

A configurable `[date][type] topic` title provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Dates come from session creation timestamps; the type vocabulary, template, time zone and prompt language are configurable. Two current-session tools support explicit rename and regeneration.

## Install

Requires Node.js 22+. Tested against the installed DSH `0.2.1-rc.3` services; declared compatibility is `>=0.2.1-rc.3 <0.6.0`.

The package is `@redheartsecretman/session-title-agents`, version `0.2.1`. Install the [Release archive](https://github.com/RedHeartSecretMan/dsh-plugins/releases/download/session-title-agents-v0.2.1/session-title-agents-0.2.1.tgz) through the plugin manager (`install_bundle`) or the CLI:

```sh
dsh plugin --profile <profile> add https://github.com/RedHeartSecretMan/dsh-plugins/releases/download/session-title-agents-v0.2.1/session-title-agents-0.2.1.tgz
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
| `maxOutputTokens` | `4096` | Output cap; uses the lowest supported reasoning effort; the cap includes hidden reasoning, while topic length is validated separately |
| `timeoutMs` | `60000` | Deadline for one candidate-route attempt |
| `maxProvisionalRefinements` | `4` | For summarized provisional titles, refine within the first N eligible messages; **not a rewrite counter**. Recognizable fallbacks remain retryable |
| `agentsInstructions.enabled` | `true` | Read applicable AGENTS naming excerpts and add main-agent naming coordination; `false` disables both |
| `agentsInstructions.maxBytes` | `4096` | Final supplemental guidance UTF-8 byte limit; integer from `256` to `65536` |
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

The default Chinese vocabulary is 功能, 设计, 修复, 优化, 发布, 运维, 探索, 文档, 研究. `探索` is provisional. A canonical concrete title with the correct creation date is retained; summarized provisional titles refine within the message-count limit. Deterministic first-message fallbacks, including legacy provider-labelled fallbacks and Host-truncated fallbacks without model provenance, remain retryable after that window. Retaining a title preserves its model provenance. Model output is leniently normalized, but stored titles require canonical syntax and the correct date, so malformed legacy dates are not frozen as settled.

## AGENTS naming guidance

The plugin remains the automatic naming owner. When a title needs generation or provisional refinement, it reads naming excerpts from applicable `AGENTS.md` and `AGENTS.local.md` files. It lazily loads the public discovery helper from the in-box `@deepseek-ai/dsh-agent-instructions` SDK, declared as an optional peer so the real profile resolver can find it for external linked installations; no second Harness is installed. The helper discovers global `AGENTS.md` files under `DSH_HOME`, then `DSH_AGENTS_HOME`, followed by project files in its default `.git` root-to-current-working-directory scope. Other instruction filenames are not read. Discovery uses host-visible paths and the SDK's default baseline chain; it does not mirror a remote filesystem provider or additional deeper scopes discovered by the main agent's file operations.

A heading matches when it combines 会话 or 对话 with 命名 or 标题, or session or conversation with naming or title. Matching is case-insensitive for English, and headings inside fenced code blocks are ignored. For an explicit excerpt, put the intended naming guidance between these markers:

```markdown
<!-- session-title-agents:start -->
Prefer a concise topic describing the user's current task.
<!-- session-title-agents:end -->
```

Only matching naming excerpts enter the supplemental prompt; unrelated engineering instructions are left out. `agentsInstructions.maxBytes` bounds the final supplemental UTF-8 text, with more-specific excerpts retained preferentially. Source reads are bounded and discovery has a soft timeout. Missing rules, SDK/read failures or the timeout preserve existing naming behavior. Files are reread when generation needs them, with no filesystem cache or continuous watcher. Changing a file alone does not regenerate an existing canonical settled provider title.

AGENTS guidance may influence topic wording and provisional refinement. The configured template, creation date, type vocabulary, topic length limits and user-title pin remain authoritative. A `systemPrompt` coordination section asks the main agent to leave automatic naming to the plugin when only standing AGENTS rules request a rename; an explicit user rename should call `rename_current_session` rather than hand the task back to the GUI. This section is guidance, not a rename API restriction, and deployments that replace the complete system prompt may omit it. Set `agentsInstructions.enabled: false` to disable both the supplemental excerpts and coordination. The plugin never edits AGENTS files.

## Model errors and ownership

The provider handles `text-delta`, completed `block-end` text and terminal `finish` events. Only a normal `stop` result can be accepted. Error, cancellation, truncation and tool-call partial output never become titles. Failed calls or parsing try a distinct backup route, then reject so Harness retains the current title or its built-in fallback. With no available route, a local title can be derived from the first message.

Harness suppresses automatic updates to user-pinned titles. An **explicit UI refresh** intentionally unpins them. Backfill always skips user titles, even a configured retitle target. Auxiliary calls use the built-in `session/title-llm-request` record; diagnostic files do not contain title, prompt or raw model text.

## Explicit current-session tools

When the Host tools service is available, the plugin registers two tools globally across agent presets. Disabling AGENTS guidance does not remove them. Both keep the default exclusive scheduling and normal Harness execution policy.

- `rename_current_session({ title })` calls the official title service, cancels in-flight generation and pins the accepted title.
- `refresh_current_session_title({})` explicitly bypasses automatic stability and regenerates through `sessionTitle.refresh()`, deliberately unpinning a user title.

Targets come only from `execution.agent.session`; no session id is accepted. Missing/stale agents and extra fields are rejected. Success requires flush and read-back. If persistence fails, the error explains that memory may already have changed; retrying the same pinned title avoids duplicate rename events.

The tested Harness provider request carries no automatic/explicit trigger. The plugin does not guess from event order or words in user messages. **Use `refresh_current_session_title` for a forced regeneration**: native GUI refresh can still retain an already summarized title under the automatic stability policy. Initial/fallback recovery is unaffected. A future SDK trigger discriminator can enable direct GUI-refresh support.

Follow the Host reload outcome after upgrading; restart when required. Installing or editing the package does not prove an existing session has the new tools.

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

No dependencies to install or build step. The optional AGENTS feature uses the public SDK helper shipped with Harness:

```sh
cd plugins/session-title-agents
npm test
npm run check
```

Tests use isolated temporary directories, including AGENTS discovery/extraction and byte limits, config validation, naming coordination, multi-process state updates, flush failure, read-only backfill preflight and unload cancellation. `scripts/verify-runtime.mjs <runtime-root>` additionally checks the installed SessionStore, projections, title service and Cordis lifecycle; ASAR installs require Electron's Node carrier. It uses the real profile linked-peer resolver, tool registry and title service. The LLM and disk durability listener are fixtures: this does not test external model availability or production-writer restart recovery.

See [validation and behavior boundaries](docs/VALIDATION.md) for checked contracts and limits.

## License

MIT.
