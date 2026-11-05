# Changelog

## 0.1.1 — 2026-11-05

- Split the title provider entry: route selection and the model request now live in `lib/run.js`, while tool registration and the naming coordination section live in `lib/coordination.js`. `index.js` keeps only configuration, provider registration, backfill and lifecycle wiring.
- Await the deferred Cordis `inject` fibers so tool and system-prompt registration complete before `apply()` returns on newer runtimes.
- Update `scripts/verify-runtime.mjs` for the newer runtime service composition (native tool executor and the `agents` surface); the installed-Harness contract check passes on `0.2.2-rc.1`.
- Harden the multi-process state fixture on Windows CI: capture child stderr and retry one transient child exit.
- Add an opt-in `test/verify-gateway.mjs` live check for real title generation through the installed LLM runtime and an OpenAI-compatible gateway; the local Magpie `auto/deepseek-flash` run passes.
- No user-visible behavior change; 158 tests.

## 0.1.0 — 2026-11-04

- Template-shaped session titles: configurable `[date][type] topic` template, date from the session creation time, controlled type vocabulary, CJK spacing and Unicode-aware topic limits.
- Stability policy: canonical titles are retained; provisional titles refine within a bounded message window; deterministic fallbacks remain recoverable.
- Model calls use the current session route with an explicit backup route, the lowest reasoning effort, bounded input/output budgets, timeouts, cancellation and a `session/title-llm-request` record.
- Optional AGENTS naming guidance from applicable `AGENTS.md` / `AGENTS.local.md` files, with byte budgets, scope ordering and fail-soft diagnostics.
- Current-session tools `rename_current_session` and `refresh_current_session_title`, with official title APIs, flush and read-back.
- Optional historical backfill with read-only eligibility checks, pinned-title protection, resumable state and durable completion markers.
- 158 tests and an installed-Harness contract check.
