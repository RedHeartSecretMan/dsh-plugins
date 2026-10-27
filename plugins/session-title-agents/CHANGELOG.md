# Changelog

## 0.2.2 — 2026-10-27

- Record auxiliary `session/title-llm-request` messages with the canonical `dsh-session-title-llm` source kind instead of the plugin name. The session-format v4 restore validator (`titleSources`) requires that exact kind and otherwise rejects the whole stored Session on the next cold load with `session/title-llm-request messages do not represent messageSeqs`.
- Add a regression test for the recorded message source so the format contract cannot silently regress.
- The plugin does not migrate already-recorded events; historical logs that already contain the wrong kind need a separate repair.

## 0.2.1 — 2026-10-26

- Recover deterministic first-message fallback titles after the provisional message window, including legacy provider-labelled and Host-truncated fallbacks; preserve model provenance on no-op results.
- Add `rename_current_session` and `refresh_current_session_title`: caller-owned live-session targets, official title APIs, cancellation/pinning, exclusive execution and flush/read-back before success.
- Fix linked-plugin SDK discovery with optional Harness peer declarations and category-only import/discovery/read/timeout diagnostics.
- Replace custom SDK test hooks with the real profile resolver; cover explicit tool refresh, in-flight cancellation, persisted read-back and tool unload. Native GUI refresh remains subject to SDK trigger ambiguity; use the dedicated refresh tool.
- Raise the output-token ceiling to 4096 for models whose lowest effort still includes hidden reasoning; topic length remains bounded.
- Correct the impossible DSH engine range to match the installed 0.2.1-rc.3 contract checks; no broader runtime compatibility is claimed.

## 0.2.0 — 2026-10-25

- Supplement automatic naming with bounded naming excerpts from applicable `AGENTS.md` and `AGENTS.local.md`, discovered lazily through the in-box public SDK helper without an installed runtime dependency.
- Add strict `agentsInstructions` settings, heading or explicit-marker extraction, scope-aware byte budgeting and failure/timeout fallback to existing naming behavior.
- Add main-agent naming coordination while preserving explicit user renames, template/date/type/length constraints, manual title pins and opt-in backfill.
- Extend regression and installed-runtime contract checks for AGENTS guidance and update bilingual configuration and validation documentation.

## 0.1.0 — 2026-10-25

Initial release of `@redheartsecretman/session-title-agents`.

- Template-shaped session titles using the session creation date, configurable type vocabulary, time zone, language and Unicode-safe topic limits.
- Canonical validation of stored titles, lenient model-output parsing and a byte budget measured over the final framed input.
- DSH stream outcome handling, backup routing, auxiliary request records and cancellation tied to the plugin lifecycle.
- Optional historical maintenance with read-only eligibility checks, pinned-title protection, flush-before-marker ordering and owned handle disposal.
- Profile-scoped bookkeeping with file locks, atomic writes, recoverable queues and bounded diagnostic logs.
- Unified plugin identity, display metadata, documentation and installable bundle resources.
- 103 isolated tests, CI on Windows/Linux with Node.js 22/24, and an optional installed-Harness contract check.

See [validation and behavior boundaries](docs/VALIDATION.md) for the checked contracts and limits.
