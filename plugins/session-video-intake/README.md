# session-video-intake

English | [中文](README.zh.md) · [Catalog](../../README.md)

The plugin decides how to hand a video to the model you already selected:

| Selected route | Behaviour |
| --- | --- |
| Supports native video | The original video is sent as `video_url` |
| Supports images only | A storyboard image plus a time manifest is sent |
| Supports neither | The request fails before it is sent |

The plugin registers no provider and never replaces the route you chose.

Deciding "native video" needs extra information: DSH model metadata only has `text` / `image`, no `video`. The plugin therefore checks the explicit `videoRoutes` whitelist first. When that is unset, it reads the provider's model listing and looks for a `video` declaration on the current model. If neither source answers, the video takes the image path.

## Install

Requires Node.js 22+. The storyboard fallback needs a capable FFmpeg/FFprobe; an existing capable build is reused, and a pinned LGPL managed pair is downloaded only when the capability probe rejects every local candidate. Verified against the installed DSH `0.2.1-rc.3`, `0.2.1-rc.5`, `0.2.2-rc.1` and `0.2.2-rc.2`; declared compatibility is `>=0.2.1-rc.3 <0.6.0`.

The package is `@redheartsecretman/session-video-intake`, version `0.1.2`. Install the [Release archive](https://github.com/RedHeartSecretMan/dsh-plugins/releases/download/session-video-intake-v0.1.2/session-video-intake-0.1.2.tgz) through the plugin manager (`install_bundle`) or the CLI:

```sh
dsh plugin --profile <profile> add https://github.com/RedHeartSecretMan/dsh-plugins/releases/download/session-video-intake-v0.1.2/session-video-intake-0.1.2.tgz
```

The package ships a `postinstall` hook that resolves FFmpeg and downloads the managed pair only when no local build qualifies. Package managers that gate install scripts skip it: pnpm reports `ERR_PNPM_IGNORED_BUILDS` and exits non-zero while still installing the package. Installing the package without running that hook is fine — the first storyboard repeats the same resolution — so approve it only if you want the download to happen at install time.

To install from a checkout instead:

```sh
git clone https://github.com/RedHeartSecretMan/dsh-plugins.git
dsh plugin --profile <profile> add /absolute/path/to/dsh-plugins/plugins/session-video-intake
```

Use `<clone>/plugins/session-video-intake` as the plugin manager's target, not the repository root. Follow the Host's reload outcome: a restart-required result means fully quit and reopen Desktop.

## Configure

Override `id: session-video-intake` in your profile's user patch. The whole `config` object is replaced, not recursively merged; omitted fields use plugin defaults, and unknown keys are activation errors rather than silently ignored settings.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` disables host-side capability checks and payload rewriting; the composer intake still loads and video files follow normal DSH file handling |
| `videoRoutes` | unset | Explicit `provider/model` whitelist for native `video_url`. Unset means "discover from the model listing"; `[]` disables native video entirely. Model ids may contain `/` |
| `catalogProbe.enabled` | `true` | Discovery used only while `videoRoutes` is unset |
| `catalogProbe.timeoutMs` | `2500` | Deadline for one listing request (`200`–`10000`) |
| `catalogProbe.ttlMs` | `300000` | How long a discovery answer is cached (`10000`–`3600000`) |
| `maxOutputTokens` | `32768` | Output cap applied to video-bearing requests; other requests are untouched |
| `maxVideoBytes` | `67108864` | Per-video byte limit enforced before reading the attachment |
| `maxTotalVideoBytes` | `67108864` | Per-request aggregate limit for native video payloads |
| `maxVideos` | `8` | Per-request video count limit |
| `storyboard.enabled` | `true` | `false` makes image-only routes fail instead of building a storyboard |
| `storyboard.sceneAware` | `true` | Detect scene cuts and distribute cells over content segments; `false` uses equal intervals |
| `storyboard.cells` | `9` | Maximum grid cells (`4`–`16`); short videos use at least 4 |
| `storyboard.cellEdge` | `256` | Width of one cell in pixels (`64`–`1024`) |
| `storyboard.timeoutMs` | `120000` | Deadline for one FFprobe/FFmpeg invocation |
| `storyboard.ffmpegPath` / `ffprobePath` | auto-detected | Explicit paths are authoritative. Otherwise probe `SESSION_VIDEO_FFMPEG`, `$DSH_HOME/tools/ffmpeg/bin`, profile/Homebrew/PATH; only if none can compose a storyboard, download the pinned LGPL managed pair |

Pin a route explicitly when you know it accepts `video_url`, or disable native video for a predictable all-storyboard setup:

```yaml
- id: session-video-intake
  config:
    videoRoutes:
      - magpie/zhipu/glm-5.3-flash
    # or: videoRoutes: []
    storyboard:
      cells: 6
      cellEdge: 320
```

## FFmpeg selection

The plugin does not assume a specific FFmpeg build:

1. An explicit `storyboard.ffmpegPath` is used as-is; if it is not capable, the request fails with the tried path instead of silently switching.
2. Otherwise candidates are probed in order: `SESSION_VIDEO_FFMPEG`, `$DSH_HOME/tools/ffmpeg/bin`, the profile tools directory, Homebrew/`/usr/local/bin`, then bare `ffmpeg`.
3. A candidate is accepted only when ffprobe works and the build reports `image2`, `scale`, `tile` and `mjpeg`.
4. The first accepted candidate is used without downloading anything. `glob` is the primary **image-input mode** when the build supports it; an unsupported-glob error automatically retries the image2 sequence and caches that choice. These are two ways to read the same zero-padded frame files, not different storyboard algorithms: frame extraction, scene planning, cell times, grid layout and the tile filter are identical.
5. Only when no local candidate qualifies does the plugin download a pinned LGPL FFmpeg/ffprobe pair into `$DSH_HOME/tools/ffmpeg/managed/`. The download is best-effort at install time, retries on first storyboard use, and keeps the plugin installable offline. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Input sources

Video input is normalized before the model sees it:

| Source | Handling |
|---|---|
| Drop, paste, browser file picker | pathless `File` upload, then a durable video `file` block |
| Desktop `+` picker | stable structural selector forwards a pathless `File`; it no longer becomes an `@path` text reference |
| `@/absolute/path.mp4` / Windows path / UNC | host reads the file, stores it as a durable attachment and replaces the reference token |
| `file://` local URI | same materialization path as `@` |
| Bare HTTP(S) URL with a supported extension | captured and sent as native video or a storyboard |
| Direct video `file` block | captured by extension or `video/*` media type |

Supported default containers include MP4, WebM, MOV, MKV, M4V, AVI, TS/MTS/M2TS, FLV, 3GP and OGV. A video-looking reference that cannot be materialized fails as `VIDEO_UNSUPPORTED_INPUT`; it is never silently treated as ordinary text.

## How it works

```text
video message
  ↓
client intake: a File without a host path becomes a durable DSH attachment
  ↓
agent/request: resolve the current provider/model capability; fail here if it has neither
  ↓
llm/stream: capture the original FileBlock / bare URL before core's file projection
  ↓
the provider's onPayload:
  ├─ native video → replace the handle with video_url
  └─ image only   → build a storyboard, replace the handle with a manifest plus image parts
  ↓
streamed model reply
```

- [client.js](client.js) forwards the existing composer's drop, paste and file-picker events; it clones video `File` objects to strip Electron's host path while keeping every byte and all metadata.
- [lib/capability.js](lib/capability.js) resolves `video` / `image` / `injectable` per provider/model and clears its cache when the adapter topology changes.
- [lib/catalog.js](lib/catalog.js) performs the fail-soft model-listing probe and caches its answers.
- [lib/router.js](lib/router.js) validates capability before `prepareCall()`; ordinary messages never touch the route.
- [lib/capture.js](lib/capture.js) records video blocks and bare URLs before core projects them to file handles.
- [lib/request-scope.js](lib/request-scope.js) binds that record to the current request stream.
- [lib/native-video.js](lib/native-video.js) turns verified attachment bytes into a `data:` URL.
- [lib/attachment.js](lib/attachment.js) owns byte-count and SHA-256 verification shared by native video and storyboards.
- [lib/rewrite-tokens.js](lib/rewrite-tokens.js) performs token replacement for either payload shape.
- [lib/payload.js](lib/payload.js) holds the payload shapes and provider hook; it chooses `video_url` or storyboard images. Both Chat Completions `messages` and Responses `input` shapes support storyboards and native video: Chat Completions uses `video_url` with an object, Responses uses `input_video` with a `video_url` string. A route that declares native video but is serialized as an unknown shape fails with `VIDEO_SDK_UNSUPPORTED` instead of silently storyboarding.
- [lib/storyboard.js](lib/storyboard.js) probes with FFprobe, samples cells with FFmpeg, tiles one PNG and writes a Chinese time manifest.
- [lib/failure.js](lib/failure.js) owns the plugin error prefix and codes; [lib/defaults.js](lib/defaults.js) is the single source of storyboard defaults.
- [lib/config.js](lib/config.js) validates the profile patch and resolves FFmpeg paths.

The original FileBlock is never rewritten. Storyboards enter only the current request and are not written to the session log. Later follow-up turns are re-projected because the durable attachments remain in the session.

## How a route is judged

The plugin answers two questions: can this route take native video, and can it take images?

1. **Images** come from the Host metadata: `inputModalities` contains `image`.
2. **Native video** cannot come from the Host. It comes from, in order:
   - an explicit `videoRoutes` entry — when configured, nothing else is probed;
   - otherwise the provider's model listing, where a `video` declaration on the current model counts as support.

| Situation | Behaviour |
| --- | --- |
| `videoRoutes` matches the current route | Native `video_url` |
| `videoRoutes` does not match, or is `[]` | No probing; use the image path |
| `videoRoutes` unset, listing declares `video` | Native `video_url` |
| `videoRoutes` unset, no declaration or probe failed | Use the image path |
| Images are unsupported too | `VIDEO_UNSUPPORTED` |

One more requirement: the provider must expose the pi-ai profile structure the payload hook attaches to. Without it the plugin cannot inject video or storyboard parts, so it fails instead of sending a file handle as video content.

Only `VIDEO_UNSUPPORTED` is a capability outcome. Authentication, missing credentials, rate limits, transport errors, server errors, timeouts and cancellations propagate unchanged and never trigger a fallback.

## Catalog discovery

- Only the **model selected in the current session** matters. The plugin requests the provider's `{baseURL}/models` and reads only the entry whose `id` equals the current `model`. Other entries are ignored, and no model is ever switched.
- Only OpenAI-compatible routes with an `http(s)` `baseURL` are probed. Other protocols stay unknown and use the image path.
- Credentials come from the Host credentials service, then the environment variable named by the provider profile. A missing or rejected credential only makes the probe unknown; it never fails the turn.
- Answers are cached per `provider/model` for `catalogProbe.ttlMs`, including negative answers, and are dropped with the capability cache when the adapter topology changes.
- `modalities` is not part of the OpenAI standard. Plain OpenAI and vLLM listings usually omit it, so most routes stay on the storyboard path unless you add them to `videoRoutes`.
- A listing declaration describes the backend model, not proof that this exact route accepts `video_url`; use `videoRoutes` when it must be exact.

## Storyboard fallback

- FFprobe reads duration, dimensions and audio presence; an unusable duration fails with `VIDEO_STORYBOARD_PROBE_FAILED`.
- With `sceneAware` enabled, FFmpeg decodes 64×36 RGB frames at a low rate, an HSV per-channel difference produces per-frame scores, and a rate-based threshold turns them into cut candidates. Cut times become content segments, then merge/split until the cell budget is met; each cell samples its segment centre.
- A static video therefore uses four equal cells instead of repeating the same frame, and fast-cut footage gets shorter segments instead of one uniform interval.
- When scene detection reports fewer than two cuts, a static fallback uses four equal cells. When detection is disabled or unavailable, the duration-based equal intervals use `clamp(ceil(duration / 4), 4, cells)` cells.
- One PNG is returned; the manifest names the file, duration, grid and every cell's interval, and states that this is sampled rather than continuous video.
- A missing binary fails with `VIDEO_STORYBOARD_UNAVAILABLE`; execution failure uses `VIDEO_STORYBOARD_FAILED`; a disabled fallback on an image-only route fails with `VIDEO_STORYBOARD_DISABLED`. None of these silently degrades to text.
- Attachments are verified by byte count and SHA-256 before FFmpeg runs; a temporary directory is always removed, and cancelled or timed-out processes are terminated.

## Storyboard idea source

The storyboard approach follows [dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard): downscaled HSV scene scanning, a rate-based cut threshold, segment-aware cell placement and one addressable contact sheet. This plugin is an independent, narrower implementation with no copied upstream code; see [NOTICE](NOTICE) for what was adopted and what was not.

## Scope and limits

- Storyboards are an approximation: scene detection is a heuristic, fast motion, flicker and continuous camera movement still lose detail, and audio is not transcribed.
- The sheet is always PNG. Bare HTTP(S) links are read by FFmpeg directly and are not persisted into the attachment store.
- Supported containers are MP4 and WebM. Local files are checked for container signature, byte count and SHA-256.
- Bare links must be HTTP(S) with a supported video path; Markdown links, code spans and quoted links remain ordinary text.
- Attaching to provider internals is deliberate: the profile keeps only its own routes. If a future SDK removes the pi-ai profile structure, the plugin fails clearly instead of guessing.
- The payload hook handles the two OpenAI-compatible shapes the installed adapters produce. Native video is written into Chat Completions `messages` as `video_url` or into Responses `input` as `input_video`; an unknown payload shape fails with `VIDEO_SDK_UNSUPPORTED` rather than degrading silently.

## Development

No dependencies to install and no build step:

```sh
cd plugins/session-video-intake
npm test
npm run check
```

`npm test` runs the configuration, catalog, scene planning, payload, routing, client and storyboard suites. Storyboard unit tests inject a fake runner for determinism and additionally exercise the real runner's stdout, stderr truncation, timeout and abort handling.

`scripts/verify-runtime.mjs` checks the installed Harness: an ASAR install needs Electron's Node carrier and FFmpeg, and reads fixtures through `VIDEO_FIXTURE_ROOT`:

```sh
VIDEO_FIXTURE_ROOT=/path/to/fixtures \
ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' scripts/verify-runtime.mjs
```

It covers the three route outcomes: native `video_url` with identical bytes, a real storyboard for an image-only route, and an explicit failure for a text-only route, and asserts that no second provider is registered. It pins routes explicitly, so the catalog probe is not exercised there; [test/catalog.test.js](test/catalog.test.js) covers discovery with an injected `fetch`.

`scripts/verify-gateway.mjs` is an opt-in live check and needs `RUN_SESSION_VIDEO_LIVE=1`, `SESSION_VIDEO_FIXTURE`, `SESSION_VIDEO_GATEWAY` and working credentials; `SESSION_VIDEO_API` selects `openai-completions` (default) or `openai-responses`:

```sh
RUN_SESSION_VIDEO_LIVE=1 SESSION_VIDEO_FIXTURE=/path/to/clip.mp4 \
SESSION_VIDEO_GATEWAY=http://127.0.0.1:3425/v1 SESSION_VIDEO_MODEL=zhipu/glm-5.3-flash MAGPIE_GATEWAY_KEY=... \
ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' scripts/verify-gateway.mjs
```

See [validation and behavior boundaries](docs/VALIDATION.md) for checked contracts and limits.

## License

[MIT](LICENSE)
