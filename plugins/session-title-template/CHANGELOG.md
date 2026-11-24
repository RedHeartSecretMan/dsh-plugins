# Changelog

## Unreleased

- Retry failed title calls instead of giving up after one attempt. One round now walks every configured route (so a healthy `backfill.fallbackRoute` still wins immediately), and later rounds re-walk the set with exponential backoff; `retryAttempts` (default `3`) and `retryDelayMs` (default `500`) bound it. Input-budget failures stay single-shot because they repeat deterministically.
- Record why a title call failed without persisting provider text: the diagnostic log now keeps `route=<provider>/<model> attempt=<n>/<total> <code>: <category>` instead of the bare `title-call-failed` label, so route, timeout, budget, stream and format failures can be distinguished without logging prompt, response or raw error text.
- `describeTitleFailure` / `isRetryableTitleFailure` are exported from `lib/run.js` and covered by `test/retry.test.js`.
- Stop losing AGENTS.md naming guidance. The plugin declared `@deepseek-ai/dsh-agent-instructions` as an optional peer, but the Harness bundles that package inside its application archive: a linked or profile-installed plugin carries no `node_modules`, so the lazy import failed on every prompt and the log filled with `agents-instructions-sdk-import-failed`. The dependency and the runtime import are gone; `discoverInstructionFilesLocally` now covers the documented scope itself — harness home, shared agents home, then repository root through the working directory — deduplicated by realpath and cancelled with the reader.
- Read only `AGENTS.md`. `AGENTS.local.md` personal overlays are no longer requested, so guidance comes from one committed file per scope and a stray local file cannot change titles.
- Observe whether a title instruction actually reaches the model. `roleProbe` sends one tiny request per route that demands an exact token: a model that cannot read the instruction answers something unrelated, which is how an endpoint that silently drops the instruction block is detected. Verdicts are cached per provider/model, logged as `role-probe ... result=supported|unsupported`, and transport failures stay undecided instead of marking the route unsupported. The probe runs detached: it never delays or fails title generation, and it never rewrites the profile.
- Name a subagent from its delegation label. A subagent's first message is a task brief, so deriving a title from messages reads like the brief and costs a model call. `readDelegationLabel` takes the subagent's own `subagent/descriptor` label, and `planTitle` renders it through the configured template, so a delegated session gets a readable title with zero model calls; a later refinement can still supply the precise type. Root sessions never use that source.
- Separate planning from execution. `planTitle` answers whether a session needs a new title, why, and what the fallback and canonical state are, from a plain snapshot object. The provider now only wires stages together, so refresh rules, fallback construction and recovery detection are testable without a session, a route or the filesystem.
- Report title state as one snapshot. `describeTitleState` separates the built-in rules (template, date format, vocabulary, length, spacing) from optional `AGENTS.md` supplements, so a supplement is never mistaken for the whole rule set: the summary reads `内置规则 + N 个补充来源`, and only sources that contributed a naming excerpt are counted. The snapshot also reports title source and pin state, the newest failure category, and the role-probe verdict, without provider text.
- Record diagnostics as structured data. `state.record` appends bounded JSON lines beside the human log, so the status view reads fields instead of parsing log strings. Records are truncated per field, trimmed to a bounded file, and a corrupt line is skipped rather than failing the read.
- 247 tests.

## 0.1.3 — 2026-11-16

- Stop cutting titles mid-word: `topicMaxChars` now measures CJK-equivalent width (Han 1, ASCII 0.5, CJK spacing 0) and truncates on whole tokens, so mixed CJK/English topics such as `open-code-review 支持 Bitbucket CI` survive intact. Default moves from `18` to `20`.
- Truncation keeps a complete clause: when a parallel clause would lose its object, the title falls back to the completed first clause instead of ending on `与修复`, and a leftover connector such as a trailing `与` or `-` is removed. Conjunction detection compares whole segmented tokens, so `合并`, `涉及`, `并发`, `校验和`, and `重定向` are never mistaken for separators.
- An atomic token (scoped package name or ASCII identifier) is split only when that single token exceeds the whole budget.
- Both prompt languages now state the width unit and forbid cutting a word short or stitching unrelated tasks together.
- Register the rename and refresh tools with plain JSON Schema instead of importing `@deepseek-ai/dsh-tools` at runtime. This fixes linked/profile installs where the plugin directory cannot resolve the Harness SDK and the whole plugin fiber fails with `Cannot find package '@deepseek-ai/dsh-tools'`.
- 191 tests.

## 0.1.2 — 2026-11-06

- Add adaptive automatic refresh: short acknowledgements and follow-ups skip model calls; explicit topic shifts, low lexical overlap, provisional titles and a periodic audit trigger evaluation.
- Always pass the current title as a JSON anchor with explicit stability rules; an unchanged model title preserves provenance instead of emitting a rewrite.
- Keep the three-part configurable template and existing tools unchanged.
- 186 tests.

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
