# Changelog

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
