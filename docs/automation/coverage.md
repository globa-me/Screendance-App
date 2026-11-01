# Automation coverage and continuation

Status: October 25, 2026, Screendance App 1.6.0. Stages **1–6 are implemented in
source**, with **84 registered commands** (21 original, 8 editor/preview, 11 job,
44 system). This covers ordinary application-user functions through typed
operations; it is not a command-per-button mirror of internal IPC.
`app.capabilities` and the shared schemas are authoritative. Both G2 signed/
notarized/stapled apps passed full packaged CLI/MCP and binary smoke (x64 via
Rosetta). Both DMGs and post-staple ZIPs passed final QA/checksums. Local artifacts
are complete; no external publication or replacement of the installed app was
performed. See [validation.md](validation.md) and [release record](../releases/v1.6.0.md).

| Domain | Implemented surface | Boundaries / validation |
| --- | --- | --- |
| App lifecycle | Launch/connect, status/capabilities, window inventory/actions, open editor/recorder/sources, safe quit | Exact app window IDs; close/quit/update install refuse unsaved or active work |
| Sources/devices/TCC | Screens/windows list/select/highlight, passive microphone/camera listing, permission state/request | Exact IDs; explicit permission grants remain controlled by macOS |
| Recording | Settings/countdown/start/pause/resume/stop/cancel/recover, awaited finalization/editor adoption | Complete shared recorder pipeline; hardware mic/camera/denied-permission matrix remains manual |
| Project library | List/recent/open/video import/live inspect/save/save-as/rename | Captured live snapshot, atomic writes, trusted-current overwrite, explicit other-target overwrite, context/allowlist rollback |
| Document/history | `editor.get/apply/undo/redo`, revision and document identity, validated atomic batches | UI and automation share full persisted-document history; transient selection/playback is separate |
| Clips/trim/speed | Collection/region CRUD/reorder, split, resize, delete, speed/mute/source-audio fields | Integer millisecond editor coordinates; display span and source span differ with clip speed |
| Zoom | Regions/focus/depth/keyframes/transitions, auto-zoom from telemetry, duration/easing/spring/motion settings | Typed settings/regions plus `editor.autoZoom`; source telemetry remains bounded |
| Cursor | Visibility/type/size/smoothing/bounce/sway/loop, effective override, telemetry/catalogs | Session cursor hiding remains stronger than presets |
| Scene | Wallpaper image/video/color/gradient, padding/blur/shadow/radius/crop/frame/aspect | Local media preparation; extension contributions visible in catalogs |
| Webcam | Source/offset/enabled/mirror/crop/position/size/zoom response/style | Media approval; preset application preserves current session source and offset |
| Annotations | Text/image/figure/blur, ranges/geometry/styles/tracks/z-order | Local image embedding; batch validation before application |
| Audio | Default and per-clip source tracks/mute/gain/normalization, external audio ranges/tracks | Frozen export carries per-clip mappings independent of current selection; real 14 dB regression verified |
| Captions | Runtime/model selection, generate/apply, cue/word/text/timing/style edits | Source/document/revision guards; fake runtime used in live smoke, actual recognition quality untested there |
| Presets | List/get/save/apply/delete, last-applied/default creation preferences | Saved projects authoritative; fresh recordings/imports use last preset |
| Preview | Status/play/pause/seek/volume/view zoom/select, composed PNG | Source-time PNG; static springs/motion blur may differ from sequential export |
| Export | Explicit MP4/GIF/MOV/WebM paths, alpha/fps/quality/backend/pipeline and existing format settings | Dedicated frozen renderer; no-overwrite/identity guards, cancellation, retry and retained-artifact save |
| Jobs | List/get/revision wait/cancel/retry for export/export.save/captions/model download | Private durable records; disconnect survives, unfinished restart becomes interrupted, explicit retry |
| Whisper models | Passive list, managed small-model download/delete | Downloads explicit; no large model downloads performed in smoke |
| App preferences | Theme/locale, configurable/fixed shortcuts, directories, HUD capture protection | Live provider/window synchronization; future recording directory only |
| Fonts/wallpapers | List/register/remove custom assets and existing contribution catalogs | Font imports restricted to HTTPS Google Fonts stylesheets; wallpaper unregister does not delete files |
| Extensions | Discover/list/contributions/permissions, enable, local install/uninstall, declared setting read/write | Transactional replacement, built-in protection, typed registered fields, no arbitrary JS/IPC endpoint |
| Marketplace | Search/get/install by catalog ID through existing service | Matched manifest and trusted-origin bounded archive/redirect/extraction checks; offline tests, no live remote install |
| Updates/diagnostics | Status/check/download/install/defer/dismiss/skip/dev preview, app/native diagnostics, bounded app/updater logs/app log clear | Existing updater/feed, safe restart gate, known logs only, credential redaction; no actual update install in smoke |
| OS helpers | Clipboard text, reveal existing local path, open managed folder | Explicit bounded arguments; no generic shell execution |
| CLI/MCP distribution | Native universal launcher, bundled runtime, safe user-link install/uninstall, print-only client setup | Both G2 signed/notarized/stapled apps passed 16 scenarios; x64 via Rosetta; final DMG/ZIP/checksum QA passed |

## Deliberate boundaries

- Hidden marketplace administration/review endpoints are server-administration
  surfaces, not ordinary application-user functionality. They are not exposed.
- Arbitrary plugin JavaScript/undeclared plugin actions, generic IPC calls, shell
  execution, arbitrary file deletion and macOS permission bypasses are not part
  of the contract. Explicit extension install runs the extension's declared code;
  explicit Whisper executable selection runs that selected local runtime.
- The editor remains the document owner. Do not mutate JSON behind an open
  editor, infer success from a written file alone, or substitute a pure Node
  renderer for the frozen compositor.
- Commands have correlation IDs, not universal mutation deduplication. Inspect
  document/job state before retrying after an ambiguous lost reply.

## Continuation and future release gate

1. Maintain source contracts in `shared/automation.ts` and its editor/job/system
   registries; add matching strict validation, routing and meaningful tests.
2. Keep UI/automation document history, dirty baselines, preset/session behavior
   and per-clip audio synchronized. Preserve app-owned job lifetimes and explicit
   conflict/restart handling.
3. For future source changes, repeat macOS14+ arm64/x64 packaging with matching
   helpers/Whisper/FFmpeg/FFprobe and full upgrade smoke for each app. Record
   Rosetta versus physical hardware accurately. Native CLI/MCP must work with
   `PATH=/usr/bin:/bin` without external Node; current 1.6.0 passes both runs.
4. Preserve the current notarized bundles. Future builds must repeat G2
   signatures/Hardened Runtime/timestamps, Apple Accepted submissions, stapling,
   archive/mounted-DMG QA and final checksums. Current 1.6.0 passed all these
   checks; its hashes/IDs are in the release record.
5. Extend the manual capture matrix for physical microphone/camera/system audio,
   denied/revoked TCC, long sessions and crash recovery. Keep AI-client discovery,
   SDK execution and actual model-driven calls as separate reported evidence.

Preserve existing project guardrails: saved project over last preset; current
webcam source/offset; session cursor override; Quick Look-compatible ProRes alpha
FFMP/Lavc behavior; architecture-matched native/Whisper helpers and packaged
FFmpeg/FFprobe. Release details belong in `docs/releasing/macos-signing.md`.
