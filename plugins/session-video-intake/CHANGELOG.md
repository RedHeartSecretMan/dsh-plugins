# Changelog

## 0.1.1 — 2026-11-05

- Split the host half into focused modules: `capture.js` (input capture), `request-scope.js` (per-request scope), `native-video.js` (verified bytes to a data URL), `rewrite-tokens.js` (shared token replacement), `failure.js` (error shape), `defaults.js` (storyboard defaults) and `attachment.js` (byte-count + SHA-256 verification).
- Installed-Harness three-route check passes on `0.2.2-rc.1` as well. The opt-in live gateway check passes with `zhipu/glm-5.3-flash` for a native attachment and a bare video URL.
- Support native video on the OpenAI Responses shape via `input_video.video_url`, verified against the live Magpie gateway; unknown payload shapes still fail with `VIDEO_SDK_UNSUPPORTED`. Chat Completions behavior is unchanged. 97 tests.

## 0.1.0 — 2026-11-04

- Per-route video handling: native `video_url` when the selected route supports video, a storyboard fallback when it only supports images, and `VIDEO_UNSUPPORTED` when it supports neither. No provider is registered and the selected route is never changed.
- Native video support from an explicit `videoRoutes` whitelist, or a fail-soft catalog probe of the provider's model listing when the whitelist is unset.
- Scene-aware storyboard generation: 64x36 HSV scan, rate-based cut threshold, content segments fitted to the cell budget, one PNG plus a per-cell time manifest; equal-interval sampling remains the fallback.
- Original attachments are verified by byte count and SHA-256; temporary files are always removed; cancellation and timeouts are handled; original FileBlocks are never rewritten.
- Composer intake for drop, paste and file-picker events, with host paths stripped and bytes preserved.
- Native video is written only into Chat Completions payloads; a declared native-video route serialized as Responses or an unknown shape fails with `VIDEO_SDK_UNSUPPORTED` instead of degrading silently.
- A static scan (fewer than two cuts) uses four equal cells; only an unavailable scan falls back to the duration-based count.
- 92 tests and an installed-Harness three-route check.
