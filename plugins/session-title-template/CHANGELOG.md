# Changelog

## 0.1.0 — 2026-11-04

- Template-shaped session titles: configurable `[date][type] topic` template, date from the session creation time, controlled type vocabulary, CJK spacing and Unicode-aware topic limits.
- Stability policy: canonical titles are retained; provisional titles refine within a bounded message window; deterministic fallbacks remain recoverable.
- Model calls use the current session route with an explicit backup route, the lowest reasoning effort, bounded input/output budgets, timeouts, cancellation and a `session/title-llm-request` record.
- Optional AGENTS naming guidance from applicable `AGENTS.md` / `AGENTS.local.md` files, with byte budgets, scope ordering and fail-soft diagnostics.
- Current-session tools `rename_current_session` and `refresh_current_session_title`, with official title APIs, flush and read-back.
- Optional historical backfill with read-only eligibility checks, pinned-title protection, resumable state and durable completion markers.
- 158 tests and an installed-Harness contract check.
